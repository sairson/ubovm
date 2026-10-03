/** Deterministic invalid learning data cannot improve through timed retries. */
export class LearningValidationError extends Error {
  constructor(message, code = 'KNOWLEDGE_REFLECTION_INVALID') {
    super(message);
    this.name = 'LearningValidationError';
    this.code = code;
  }
}

export function validateReflectionCandidates(candidates, records) {
  const reject = message => { throw new LearningValidationError(message); };
  if (!Array.isArray(candidates) || candidates.length > 1) reject('Invalid reflection candidates');
  const fields = new Set(['title', 'trigger', 'steps', 'tool_call_ids', 'failure_call_ids', 'portable']);
  const text = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
  const refs = (value, maximum) => Array.isArray(value) && value.length > 0 && value.length <= maximum &&
    value.every(item => text(item, 2048)) && new Set(value).size === value.length;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
        Object.keys(candidate).some(key => !fields.has(key)) ||
        !text(candidate.title, 160) || !text(candidate.trigger, 512) ||
        !refs(candidate.steps, 12) || !refs(candidate.tool_call_ids, 16) ||
        (candidate.portable !== undefined && typeof candidate.portable !== 'boolean') ||
        (candidate.failure_call_ids !== undefined && !refs(candidate.failure_call_ids, 16))) reject('Invalid reflection candidate schema');
    if (Buffer.byteLength(JSON.stringify(candidate)) > 32768) reject('Reflection candidate is too large');
    const successes = candidate.tool_call_ids.map(id => records.find(record => record.toolCallId === id && record.status === 'completed' && record.isError === false));
    if (successes.some(record => !record)) reject('Reflection cited unavailable evidence');
    for (const id of candidate.failure_call_ids ?? []) {
      const failure = records.find(record => record.toolCallId === id && record.status === 'completed' && record.isError === true);
      if (!failure || !successes.some(success => success.toolName === failure.toolName &&
          success.workerId === failure.workerId && success.sessionId === failure.sessionId && records.indexOf(success) > records.indexOf(failure))) {
        reject('Reflection cited unavailable failed evidence or no subsequent recovery');
      }
    }
  }
  return candidates;
}
