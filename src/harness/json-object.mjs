function matchingBrace(text, start) {
  let depth = 0, inString = false, escape = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function parseSlice(text) {
  try { return asObject(JSON.parse(text)); } catch { return undefined; }
}

function lastTopLevelObject(text) {
  const candidates = [];
  let inString = false, escape = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char !== '{') continue;
    const end = matchingBrace(text, index);
    if (end < 0) continue;
    const value = parseSlice(text.slice(index, end + 1));
    if (value) candidates.push({ start: index, end, value });
  }
  const top = candidates.filter(item => !candidates.some(other => other.start < item.start && other.end > item.end));
  return top.at(-1)?.value;
}

function fencedBlocks(source) {
  return [...source.matchAll(/```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/giu)].map(match => match[1].trim()).filter(Boolean);
}

/** Decode one JSON object from model text, ignoring fences and surrounding commentary. */
export function readJSONObject(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'empty' };
  let source = text.replace(/^\uFEFF/u, '').replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, '').trim();
  const fenced = fencedBlocks(source);
  for (const candidate of [...fenced].reverse()) {
    const value = parseSlice(candidate) ?? lastTopLevelObject(candidate);
    if (value) return { value };
  }
  const value = parseSlice(source) ?? lastTopLevelObject(source);
  return value ? { value } : { error: 'invalid' };
}

export function extractedJSONBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Raw model text may include commentary; the JSON object itself stays under maxBytes. */
export function commentaryBudget(maxBytes) {
  if (maxBytes === undefined) return undefined;
  return Math.min(Math.max(maxBytes * 8, maxBytes), 1024 * 1024);
}
