import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const MAX_DISCOVERY_PAGES = 100;
const MAX_TOOLS = 1_000;

function failure(code, message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value, fallback, min, max, label) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  return value;
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError(`${label} must be nonempty text without NUL`);
  return value;
}
function stringMap(value, label, header = false) {
  if (value === undefined) return undefined;
  if (!object(value)) throw new TypeError(`${label} must be an object`);
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (!key || /[\0=\r\n]/.test(key) || typeof item !== 'string' || item.includes('\0') || (header && /[\r\n]/.test(item))) {
      throw new TypeError(`${label} contains an invalid entry`);
    }
    result[key] = item;
  }
  if (header) new Headers(result);
  return result;
}

function normalizeServers(servers) {
  if (!Array.isArray(servers)) throw new TypeError('mcp.servers must be an array');
  const names = new Set();
  return servers.map(input => {
    if (!object(input) || typeof input.name !== 'string' || !SERVER_NAME.test(input.name)) throw new TypeError('MCP server name must be 1–64 letters, digits, dots, underscores or hyphens');
    const key = input.name.toLowerCase();
    if (names.has(key)) throw new TypeError(`Duplicate MCP server name: ${input.name}`);
    names.add(key);
    for (const flag of ['enabled', 'required']) if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw new TypeError(`MCP ${flag} must be boolean`);
    const server = { ...input, enabled: input.enabled ?? true, required: input.required ?? true };
    if (!server.enabled) return server;
    server.transport ??= 'stdio';
    if (server.transport === 'streamable-http') server.transport = 'streamable_http';
    if (server.transport === 'stdio') {
      server.command = text(server.command, 'MCP command');
      server.args ??= [];
      if (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new TypeError('MCP args must be an array of strings without NUL');
      server.args = [...server.args];
      server.env = stringMap(server.env, 'MCP env');
      if (server.cwd !== undefined) text(server.cwd, 'MCP cwd');
      if (server.url !== undefined || server.headers !== undefined) throw new TypeError('MCP stdio does not accept url or headers');
    } else if (server.transport === 'streamable_http' || server.transport === 'sse') {
      const url = new URL(text(server.url, 'MCP url'));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new TypeError('MCP url must be absolute HTTP(S), without credentials or a fragment');
      server.url = url;
      server.headers = stringMap(server.headers, 'MCP headers', true);
      if (['command', 'args', 'env', 'cwd'].some(key => server[key] !== undefined)) throw new TypeError('MCP HTTP transports do not accept command, args, env or cwd');
    } else throw new TypeError(`Unsupported MCP transport: ${server.transport}`);
    if (server.tools !== undefined && (!Array.isArray(server.tools) || server.tools.some(name => typeof name !== 'string' || !name || name.includes('\0')) || new Set(server.tools).size !== server.tools.length)) throw new TypeError('MCP tools must be a unique array of remote tool names');
    server.tools = server.tools && [...server.tools];
    if (server.toolNamePrefix !== undefined && !SERVER_NAME.test(server.toolNamePrefix)) throw new TypeError('Invalid MCP toolNamePrefix');
    return server;
  });
}

/** Stable provider-safe names, including tools with punctuation or long names. */
function exposedName(server, remoteName) {
  const original = `${server.toolNamePrefix ?? `mcp_${server.name}`}_${remoteName}`;
  let normalized = original.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!/^[A-Za-z_]/.test(normalized)) normalized = `mcp_${normalized}`;
  if (normalized === original && normalized.length <= 64) return normalized;
  const hash = createHash('sha256').update(original).digest('hex').slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}

function makeTransport(server, maxResultBytes) {
  if (server.transport === 'stdio') return new StdioClientTransport({
    command: server.command, args: server.args, env: server.env, cwd: server.cwd,
    // Stderr is intentionally not sent to model context or SDK diagnostics.
    stderr: 'ignore', maxBufferSize: Math.max(maxResultBytes * 2, 1 << 20),
  });
  const options = { requestInit: { headers: server.headers } };
  return server.transport === 'sse' ? new SSEClientTransport(server.url, options) : new StreamableHTTPClientTransport(server.url, options);
}

async function boundedOperation(signal, timeoutMs, operation) {
  signal?.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(failure('MCP_TIMEOUT', `MCP operation exceeded ${timeoutMs} ms`)), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(combined.reason);
    combined.addEventListener('abort', onAbort, { once: true });
  });
  try {
    combined.throwIfAborted();
    return await Promise.race([Promise.resolve().then(() => operation(combined)), interrupted]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', onAbort);
  }
}

function convertResult(result, serverName, toolName, maxResultBytes) {
  if (Buffer.byteLength(JSON.stringify(result)) > maxResultBytes) throw failure('MCP_RESULT_TOO_LARGE', `MCP tool ${serverName}/${toolName} result exceeds ${maxResultBytes} bytes; request a narrower result`);
  const content = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text') content.push({ type: 'text', text: item.text });
    else if (item.type === 'image') content.push({ type: 'image', data: item.data, mimeType: item.mimeType });
    else if (item.type === 'resource' && typeof item.resource?.text === 'string') content.push({ type: 'text', text: `Resource ${item.resource.uri}\n${item.resource.text}` });
    else if (item.type === 'resource_link') content.push({ type: 'text', text: JSON.stringify({ type: 'resource_link', name: item.name, uri: item.uri, ...(item.description ? { description: item.description } : {}), ...(item.mimeType ? { mimeType: item.mimeType } : {}) }) });
    else if (item.type === 'resource') content.push({ type: 'text', text: `Binary resource ${item.resource?.uri ?? ''} (${item.resource?.mimeType ?? 'application/octet-stream'}); binary content is omitted.` });
    else if (item.type === 'audio') content.push({ type: 'text', text: `Audio result (${item.mimeType}); audio content is not supported by the Worker tool interface.` });
    else throw failure('MCP_RESULT_INVALID', `MCP tool ${serverName}/${toolName} returned unsupported content`);
  }
  if (result.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
  if (!content.length) content.push({ type: 'text', text: '(MCP tool returned no content)' });
  const converted = { content, details: { server: serverName, tool: toolName } };
  if (Buffer.byteLength(JSON.stringify(converted)) > maxResultBytes) throw failure('MCP_RESULT_TOO_LARGE', `MCP tool ${serverName}/${toolName} converted result exceeds ${maxResultBytes} bytes`);
  // Pi records failures only when execute throws. Returning isError would be
  // interpreted as a successful tool result and could be promoted as evidence.
  if (result.isError) throw failure('MCP_TOOL_ERROR', content.filter(item => item.type === 'text').map(item => item.text).join('\n') || `MCP tool ${serverName}/${toolName} failed`);
  return converted;
}

/**
 * Connect explicitly configured MCP servers and expose a stable set of Pi tools.
 * The middleware owns its clients; close cancels and drains in-flight calls.
 * Environment values and HTTP headers are literal host-supplied values, never
 * expanded through a shell or copied to tool definitions and diagnostics.
 */
export async function createMcpMiddleware({ servers = [], connectTimeoutMs = 20_000, callTimeoutMs = 60_000, maxResultBytes = 262_144, signal } = {}) {
  const configurations = normalizeServers(servers);
  connectTimeoutMs = integer(connectTimeoutMs, 20_000, 1, 120_000, 'connectTimeoutMs');
  callTimeoutMs = integer(callTimeoutMs, 60_000, 1, 3_600_000, 'callTimeoutMs');
  maxResultBytes = integer(maxResultBytes, 262_144, 1_024, 16 << 20, 'maxResultBytes');
  signal?.throwIfAborted();
  const lifetime = new AbortController();
  const clients = [];
  const active = new Set();
  const diagnostics = [];
  const tools = [];
  const names = new Set();
  let closed = false;
  let closePromise;
  let abortListener;

  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    for (const diagnostic of diagnostics) diagnostic.connected = false;
    closePromise = Promise.resolve().then(async () => {
      signal?.removeEventListener('abort', abortListener);
      lifetime.abort(failure('MCP_CLOSED', 'MCP middleware is closed'));
      const results = await Promise.allSettled(clients.map(client => Promise.resolve().then(() => client.close())));
      await Promise.allSettled([...active]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Could not close all MCP clients');
    });
    return closePromise;
  };

  function execute(client, server, remoteName, input, callSignal, onUpdate, outputValidator, taskRequired) {
    if (closed) return Promise.reject(failure('MCP_CLOSED', 'MCP middleware is closed'));
    if (taskRequired) return Promise.reject(failure('MCP_TASK_UNSUPPORTED', `MCP tool ${server.name}/${remoteName} requires asynchronous task execution, which this Worker does not support`));
    const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), ...(callSignal ? [callSignal] : [])]);
    const pending = boundedOperation(combined, callTimeoutMs, async activeSignal => {
      const result = await client.callTool({ name: remoteName, arguments: structuredClone(input) }, CallToolResultSchema, {
        signal: activeSignal, timeout: callTimeoutMs, maxTotalTimeout: callTimeoutMs,
        onprogress: onUpdate ? progress => {
          if (closed || activeSignal.aborted) return;
          try { Promise.resolve(onUpdate({ content: [{ type: 'text', text: progress.message ?? `Progress: ${progress.progress}${progress.total === undefined ? '' : `/${progress.total}`}` }], details: { server: server.name, tool: remoteName, progress: progress.progress, ...(progress.total === undefined ? {} : { total: progress.total }) } })).catch(() => {}); } catch { /* Progress is observational. */ }
        } : undefined,
      });
      activeSignal.throwIfAborted();
      // The official client's listTools cache covers only the most recent page.
      // Keep our own validators so earlier pages retain output validation.
      if (outputValidator && !result.isError && !outputValidator.Check(result.structuredContent)) throw failure('MCP_OUTPUT_INVALID', `MCP tool ${server.name}/${remoteName} result does not match its output schema`);
      return convertResult(result, server.name, remoteName, maxResultBytes);
    });
    active.add(pending);
    void pending.finally(() => active.delete(pending)).catch(() => {});
    return pending;
  }

  try {
    for (const server of configurations) {
      const diagnostic = { name: server.name, transport: server.transport ?? 'stdio', enabled: server.enabled, required: server.required, connected: false, tools: [] };
      diagnostics.push(diagnostic);
      if (!server.enabled) continue;
      const client = new Client({ name: 'ubovm-harness', version: '0.1.2' }, { capabilities: {} });
      const transport = makeTransport(server, maxResultBytes);
      client.onclose = () => { diagnostic.connected = false; };
      let connected = false;
      try {
        const available = await boundedOperation(signal, connectTimeoutMs, async activeSignal => {
          await client.connect(transport, { signal: activeSignal, timeout: connectTimeoutMs, maxTotalTimeout: connectTimeoutMs });
          activeSignal.throwIfAborted();
          const found = [];
          const remoteNames = new Set();
          const cursors = new Set();
          let cursor;
          for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
            const listed = await client.listTools(cursor === undefined ? {} : { cursor }, { signal: activeSignal, timeout: connectTimeoutMs, maxTotalTimeout: connectTimeoutMs });
            activeSignal.throwIfAborted();
            for (const tool of listed.tools) {
              if (!tool.name || remoteNames.has(tool.name)) throw failure('MCP_DISCOVERY_INVALID', 'MCP server advertises duplicate or empty tool names');
              remoteNames.add(tool.name);
              found.push(tool);
              if (found.length > MAX_TOOLS) throw failure('MCP_DISCOVERY_LIMIT', `MCP server advertises more than ${MAX_TOOLS} tools`);
            }
            cursor = listed.nextCursor;
            if (cursor === undefined) break;
            if (cursors.has(cursor)) throw failure('MCP_DISCOVERY_INVALID', 'MCP tool pagination repeats a cursor');
            cursors.add(cursor);
            if (page === MAX_DISCOVERY_PAGES - 1) throw failure('MCP_DISCOVERY_LIMIT', 'MCP tool pagination exceeds its limit');
          }
          if (server.tools) for (const name of server.tools) if (!remoteNames.has(name)) throw failure('MCP_TOOL_MISSING', `Configured MCP tool is unavailable: ${name}`);
          return server.tools ? found.filter(tool => server.tools.includes(tool.name)) : found;
        });
        signal?.throwIfAborted();
        const pendingTools = [];
        const pendingNames = new Set();
        for (const remote of available) {
          if (Buffer.byteLength(JSON.stringify(remote)) > 262_144) throw failure('MCP_SCHEMA_TOO_LARGE', 'MCP tool definition exceeds 262144 bytes');
          const name = exposedName(server, remote.name);
          if (names.has(name) || pendingNames.has(name)) throw failure('MCP_TOOL_COLLISION', `Duplicate exposed MCP tool name: ${name}`);
          if (!object(remote.inputSchema) || remote.inputSchema.type !== 'object') throw failure('MCP_SCHEMA_INVALID', 'MCP tool inputSchema must describe an object');
          const parameters = Type.Unsafe(structuredClone(remote.inputSchema));
          Compile(parameters);
          const outputValidator = remote.outputSchema ? Compile(Type.Unsafe(structuredClone(remote.outputSchema))) : undefined;
          pendingTools.push({ name, label: `${server.name}: ${remote.title ?? remote.name}`, description: remote.description ?? `Call MCP tool ${server.name}/${remote.name}.`, parameters,
            execute: (_id, input, callSignal, onUpdate) => execute(client, server, remote.name, input, callSignal, onUpdate, outputValidator, remote.execution?.taskSupport === 'required'),
          });
          pendingNames.add(name);
        }
        for (const name of pendingNames) names.add(name);
        tools.push(...pendingTools);
        diagnostic.tools = pendingTools.map(tool => tool.name).sort();
        diagnostic.connected = true;
        clients.push(client);
        connected = true;
      } catch (error) {
        // Keep credentials, command arguments and transport response bodies out
        // of public diagnostics. The original error remains available as cause.
        diagnostic.error = `MCP server ${server.name} connection or discovery failed`;
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        signal?.throwIfAborted();
        if (server.required) throw failure('MCP_CONNECT_FAILED', diagnostic.error, error);
      } finally {
        if (!connected) diagnostic.connected = false;
      }
    }
    signal?.throwIfAborted();
    abortListener = () => { void close().catch(() => {}); };
    signal?.addEventListener('abort', abortListener, { once: true });
    return Object.freeze({ tools: Object.freeze(tools), diagnostics: () => structuredClone(diagnostics), close });
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
