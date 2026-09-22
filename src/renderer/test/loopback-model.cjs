'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

const text = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
const keyPoint = '读取 smoke 证据文件并返回实际内容';

function jsonAfter(source, marker) {
  const offset = source.lastIndexOf(marker);
  assert(offset >= 0, `Missing fixture context: ${marker}`);
  const value = source.slice(offset + marker.length);
  const start = value.search(/[\[{]/);
  assert(start >= 0, `Missing JSON after ${marker}`);
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < value.length; index++) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '[' || character === '{') depth++;
    else if ((character === ']' || character === '}') && --depth === 0) return JSON.parse(value.slice(start, index + 1));
  }
  throw new Error(`Incomplete JSON after ${marker}`);
}

/** Deterministic local provider; requests still traverse HTTP, pi and real tools. */
async function startLoopbackModel({ readPath, marker }) {
  const requests = [];
  const sockets = new Set();
  let hold, sequence = 0;
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer fixture-key');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const messages = body.messages || [];
      const system = messages.filter(message => ['system', 'developer'].includes(message.role)).map(text).join('\n');
      const phase = /Worker phase:\s*(plan|execute|replan|conclude)/.exec(system)?.[1] || (system.includes('You are Reason,') ? 'reason' : 'assist');
      const item = { phase, body, aborted: false };
      requests.push(item);
      response.once('close', () => { if (!response.writableEnded) item.aborted = true; });
      if (hold?.phase === phase) {
        const pending = hold; hold = undefined;
        response.once('close', pending.release);
        pending.arrive(item);
        await pending.wait;
        if (response.destroyed) return;
      }
      let content, toolCall;
      if (phase === 'reason') {
        const evidence = messages.map(text).findLast(value => value.includes('Blackboard Evidence'));
        const board = jsonAfter(evidence, 'Blackboard Evidence');
        const completed = board.nodes.filter(node => node.intent?.status === 'completed' && node.fact);
        content = completed.length ? { complete: true, evidenceIds: [completed.at(-1).ref], summary: `SMOKE_GOAL_COMPLETE ${marker}` }
          : { intents: [{ description: '读取工作区证据并验证内容', parentIds: [board.root], priority: 'medium', keyPoints: [keyPoint] }] };
      } else if (phase === 'plan') content = { steps: [{ description: '读取本地 smoke 证据文件', doneWhen: '工具结果包含实际文件内容' }] };
      else if (phase === 'replan') content = { done: true };
      else if (phase === 'conclude') {
        const evidence = messages.map(text).findLast(value => value.includes('Host tool evidence ledger:'));
        const ledger = jsonAfter(evidence, 'Host tool evidence ledger:');
        const read = ledger.find(entry => entry.toolName === 'read_workspace_file' && entry.status === 'completed' && !entry.isError);
        assert(read, 'Conclusion needs a successfully executed workspace read');
        assert(read.observations.some(value => value.includes(marker)), 'Tool evidence must contain the actual marker');
        content = { version: 1, outcome: 'confirmed', statement: `文件包含 ${marker}`, coverage: [{ point: keyPoint, status: 'confirmed', result: `实际读取 ${marker}` }], evidence: [{ toolCallId: read.toolCallId, observation: `读取到 ${marker}` }], failedChecks: [], limitations: [] };
      } else if (phase === 'execute') {
        const read = messages.findLast(message => message.role === 'tool');
        if (read) { assert(text(read).includes(marker)); content = `已读取文件，证据 ${read.tool_call_id}：${marker}`; }
        else toolCall = { id: `smoke_read_${++sequence}`, type: 'function', function: { name: 'read_workspace_file', arguments: JSON.stringify({ path: readPath }) } };
      } else {
        const latest = messages.findLast(message => message.role === 'user');
        content = 'SMOKE_ASSIST_REPLY ' + text(latest).split('\n\nEditor context')[0];
      }
      const id = `chatcmpl-smoke-${++sequence}`;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      emit({ role: 'assistant' });
      if (toolCall) emit({ tool_calls: [{ index: 0, ...toolCall }] });
      else {
        const answer = typeof content === 'string' ? content : JSON.stringify(content);
        const middle = Math.floor(answer.length / 2);
        emit({ content: answer.slice(0, middle) });
        emit({ content: answer.slice(middle) });
      }
      emit({}, toolCall ? 'tool_calls' : 'stop');
      response.end('data: [DONE]\n\n');
    } catch (error) {
      requests.push({ error: error.message });
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    model: { provider: 'smoke', modelId: 'fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key', streamOptions: { maxRetries: 0 } },
    requests,
    holdNext(phase) {
      assert(!hold, 'Only one fixture hold is allowed');
      let arrive, release;
      const arrived = new Promise(resolve => { arrive = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      hold = { phase, arrive, release, wait };
      return { arrived, release };
    },
    async close() {
      hold?.release();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

module.exports = { startLoopbackModel };
