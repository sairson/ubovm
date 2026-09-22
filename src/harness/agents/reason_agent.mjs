import { Agent } from '@earendil-works/pi-agent-core';
import { parseReasonDecision, validateReasonContext } from './protocol.mjs';
import { reasonEvidencePrompt, reasonSystemPrompt } from './prompts.mjs';

const failure = (code, message, cause) => Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
const aborted = signal => Object.assign(failure('ABORT_ERR', 'Reason execution was interrupted.', signal?.reason), { name: 'AbortError' });

function raceAbort(operation, signal) {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted(signal));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** A real pi Agent adapter for BlackboardCoordinator.reason, with no execution tools. */
export function createPiReason({
  model, streamFn, getApiKey, thinkingLevel = 'off', systemPrompt = '',
  maxIntents = 8, maxResponseBytes = 32768, maxRepairs = 1, onEvent, beforeModel
} = {}) {
  if (!model || !['id', 'api', 'provider'].every(key => typeof model[key] === 'string' && model[key])) throw new TypeError('A pi model is required.');
  if (typeof streamFn !== 'function') throw new TypeError('A pi streamFn is required.');
  if (typeof systemPrompt !== 'string') throw new TypeError('systemPrompt must be a string.');
  for (const [name, value] of Object.entries({ getApiKey, onEvent, beforeModel })) {
    if (value !== undefined && typeof value !== 'function') throw new TypeError(`${name} must be a function.`);
  }
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel)) throw new TypeError('Invalid thinkingLevel.');
  for (const [name, value] of Object.entries({ maxIntents, maxResponseBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  }
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 4) throw new TypeError('maxRepairs must be an integer from 0 to 4.');

  return async function piReason({ context, signal } = {}) {
    validateReasonContext(context);
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal.');
    if (signal?.aborted) throw aborted(signal);
    // Fix the evidence for this decision. The coordinator fences its revision
    // before persisting any proposed work; repairs must not silently refresh it.
    const snapshot = { ...context, data: structuredClone(context.data) };
    let agent;
    let closed = false;
    let fatal;
    let modelCalls = 0;
    const check = () => {
      if (signal?.aborted || closed) throw aborted(signal);
      if (fatal) throw fatal;
    };
    const report = event => {
      if (closed) return;
      try { Promise.resolve(onEvent?.({ revision: snapshot.data.revision, ...structuredClone(event) })).catch(() => {}); }
      catch { /* Observers never control planning. */ }
    };
    const cancel = () => agent?.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let repair;
    try {
      report({ type: 'reason_start' });
      for (let attempt = 0; attempt <= maxRepairs; attempt++) {
        check();
        agent = new Agent({
          initialState: {
            systemPrompt: reasonSystemPrompt({ goal: snapshot.data.goal, maxIntents, systemPrompt }),
            model, thinkingLevel, tools: []
          },
          getApiKey,
          // Even an unexpected tool call must not trigger an implicit new turn.
          shouldStopAfterTurn: () => true,
          streamFn: async (requestModel, transcript, options) => {
            try {
              check();
              if (++modelCalls > maxRepairs + 1) throw failure('MODEL_BUDGET_EXCEEDED', 'Reason model-call budget exceeded.');
              const request = beforeModel ? await raceAbort(Promise.resolve().then(() => beforeModel({
                role: 'reason', scope: 'reason', model: requestModel, context: structuredClone(transcript), signal,
                blackboard: structuredClone(snapshot.data),
                evidence: { messageIndex: transcript.messages.length - 1, boardText: JSON.stringify(snapshot.data, null, 2) }
              })), signal) : transcript;
              check();
              if (!request || !Array.isArray(request.messages)) throw new TypeError('beforeModel must return a model context');
              return await streamFn(requestModel, request, options);
            } catch (cause) {
              fatal ??= signal?.aborted || closed ? aborted(signal) : failure('MODEL_REQUEST_FAILED', 'Reason model request failed.', cause);
              throw fatal;
            }
          }
        });
        const unsubscribe = agent.subscribe(event => {
          if (closed || fatal || signal?.aborted) return;
          if (['message_update', 'message_end'].includes(event.type) && event.message.role === 'assistant') {
            const size = (event.message.content ?? []).reduce((sum, part) => sum +
              (part.type === 'text' ? Buffer.byteLength(part.text ?? '', 'utf8') : part.type === 'toolCall' ? Buffer.byteLength(JSON.stringify(part), 'utf8') : 0), 0);
            if (size > maxResponseBytes) {
              fatal = failure('RESPONSE_TOO_LARGE', `Reason response exceeds ${maxResponseBytes} UTF-8 bytes.`);
              agent.abort();
              throw fatal;
            }
          }
          report({ type: 'pi_event', attempt: attempt + 1, event });
        });
        let message;
        try {
          await raceAbort(agent.prompt(reasonEvidencePrompt(snapshot, repair)), signal);
          check();
          message = agent.state.messages.findLast(item => item.role === 'assistant');
        } finally {
          unsubscribe();
          agent.abort();
          agent = undefined;
        }
        if (!message || ['error', 'aborted'].includes(message.stopReason)) throw failure('MODEL_RESPONSE_FAILED', message?.errorMessage ?? `Reason model ended with ${message?.stopReason ?? 'no response'}.`);
        const source = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
        try {
          if (message.stopReason === 'length') throw failure('MODEL_RESPONSE_TRUNCATED', 'Reason output reached the model token limit. Return a shorter complete JSON decision; reduce plan detail without dropping required work.');
          if (message.stopReason !== 'stop' || message.content.some(part => !['text', 'thinking'].includes(part.type))) throw failure('INVALID_REASON_DECISION', 'Reason must produce JSON text, without tool calls.');
          const decision = parseReasonDecision(source, { context: snapshot, maxIntents, maxResponseBytes });
          report({ type: 'reason_decision', decision, modelCalls });
          return decision;
        } catch (error) {
          if (!['INVALID_REASON_DECISION', 'MODEL_RESPONSE_TRUNCATED'].includes(error.code) || attempt >= maxRepairs) throw error;
          repair = { source, error: error.message };
          report({ type: 'reason_repair', attempt: attempt + 1, error: error.message });
        }
      }
    } finally {
      closed = true;
      agent?.abort();
      signal?.removeEventListener('abort', cancel);
    }
  };
}
