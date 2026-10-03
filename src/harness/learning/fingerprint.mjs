import { createHash } from 'node:crypto';

// Call IDs, attempts, and timing are deliberately excluded. Replaying identical
// inputs and observations in another Worker/session must not create new credit.
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])
  );
  return value;
};
export const learningFingerprint = entry => createHash('sha256').update(JSON.stringify(canonical({
  tool: entry.toolName, args: entry.args ?? {}, result: entry.result ?? {}, isError: Boolean(entry.isError)
}))).digest('hex');
export const learningRequestFingerprint = entry => createHash('sha256').update(JSON.stringify(canonical({
  tool: entry.toolName, args: entry.args ?? {}
}))).digest('hex');

export const methodFamily = method => createHash('sha256').update(JSON.stringify(
  [method.title, method.trigger].map(value => value.trim().replace(/\s+/gu, ' ').toLowerCase())
)).digest('hex');
