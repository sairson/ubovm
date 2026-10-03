import { StringDecoder } from 'node:string_decoder';
import { textResult } from '../common.mjs';

// Bound retained output and batch UI notifications, preserving arrival order.
export function createProcessOutput(maxBytes, onUpdate, { intervalMs = 16, batchBytes = 32768, captureOutput = true, rolling = () => false } = {}) {
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
  const stored = [], chunks = [];
  let chunkHead = 0, retainedBytes = 0, rollingStored = false;
  let pending = [], pendingBytes = 0, bytes = 0, timer, closed = false, truncated = false, result, lastStream;
  const prefixBytes = stderr => stderr && lastStream !== true ? 9 : 0;
  const tail = text => {
    const data = Buffer.from(text);
    let start = Math.max(0, data.length - maxBytes);
    while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
    return data.subarray(start).toString('utf8');
  };
  function retain(text) {
    const buffer = Buffer.from(text);
    if (buffer.length) { chunks.push(buffer); retainedBytes += buffer.length; }
    while (retainedBytes > maxBytes) {
      const first = chunks[chunkHead], excess = retainedBytes - maxBytes;
      if (first.length <= excess) { retainedBytes -= first.length; chunks[chunkHead++] = undefined; }
      else {
        let start = excess;
        while (start < first.length && (first[start] & 0xc0) === 0x80) start++;
        // Each batch is bounded; advance its view instead of recopying the
        // entire retained window on every small append. Eviction drops it.
        chunks[chunkHead] = first.subarray(start); retainedBytes -= start;
      }
    }
    if (chunkHead >= 64 && chunkHead * 2 >= chunks.length) { chunks.splice(0, chunkHead); chunkHead = 0; }
  }
  function retainedText() { return rollingStored ? Buffer.concat(chunks.slice(chunkHead), retainedBytes).toString('utf8') : stored.join(''); }
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!pending.length) return;
    const text = pending.join(''); pending = []; pendingBytes = 0;
    if (captureOutput) {
      if (rolling()) {
        if (!rollingStored) { rollingStored = true; retain(stored.join('')); stored.length = 0; }
        retain(text);
      }
      else stored.push(text);
    }
    try { Promise.resolve(onUpdate?.(textResult(text))).catch(() => {}); } catch { /* observer */ }
  }
  function append(text) {
    if (!text) return;
    pending.push(text); pendingBytes += Buffer.byteLength(text);
    if (pendingBytes >= batchBytes) flush();
    else timer ??= setTimeout(flush, intervalMs);
  }
  function publish(text, stderr) {
    if (!text) return;
    if (rolling()) {
      const rendered = `${prefixBytes(stderr) ? '[stderr] ' : ''}${text}`;
      lastStream = stderr; bytes += Buffer.byteLength(rendered);
      if (bytes > maxBytes) truncated = true;
      append(tail(rendered));
      return;
    }
    const available = Math.max(0, maxBytes - bytes - prefixBytes(stderr));
    const encoded = Buffer.from(text);
    if (encoded.length > available) {
      // Invalid input bytes can expand into three-byte replacement characters.
      // Bound the decoded representation too, without splitting UTF-8.
      text = new StringDecoder('utf8').write(encoded.subarray(0, available));
      truncated = true;
    }
    if (text) {
      const rendered = `${prefixBytes(stderr) ? '[stderr] ' : ''}${text}`;
      lastStream = stderr;
      bytes += Buffer.byteLength(rendered); append(rendered);
    }
  }
  return {
    write(chunk, stderr = false) {
      if (closed) return false;
      if (rolling()) { publish(decoders[Number(stderr)].write(chunk), stderr); return true; }
      if (truncated) return false;
      const available = Math.max(0, maxBytes - bytes - prefixBytes(stderr));
      const bounded = chunk.subarray(0, available);
      // Prefix bytes are bounded too. Do not add a replacement character for a
      // UTF-8 sequence cut by the output limit.
      publish(decoders[Number(stderr)].write(bounded), stderr);
      if (bounded.length < chunk.length) truncated = true;
      return !truncated;
    },
    end(stderr = false) { if (!closed && (!truncated || rolling())) publish(decoders[Number(stderr)].end(), stderr); },
    finish() {
      if (!closed) { closed = true; flush(); result = retainedText(); stored.length = 0; chunks.length = 0; retainedBytes = 0; chunkHead = 0; }
      return result ?? retainedText();
    },
    flush,
    get bytes() { return bytes; },
    get truncated() { return truncated; }
  };
}
