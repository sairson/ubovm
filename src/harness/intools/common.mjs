import { homedir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';

export function textResult(text, details) {
  return { content: [{ type: 'text', text: String(text) }], ...(details === undefined ? {} : { details }) };
}
export function jsonResult(value) { return textResult(JSON.stringify(value), value); }
export function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError(`${name} must be nonempty text without NUL`);
  return value.trim();
}
export function integer(value, fallback, min, max, name) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
export function expandHome(value) { return /^~(?:[/\\]|$)/.test(value) ? resolve(homedir(), value.slice(2)) : value; }
export function contained(root, path) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\'));
}
export function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
}
export function preview(value, maxBytes) {
  const bytes = Buffer.from(String(value));
  if (bytes.length <= maxBytes) return bytes.toString();
  return new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
}
