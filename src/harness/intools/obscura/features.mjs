import { createHash, randomUUID } from 'node:crypto';

export const id = prefix => `${prefix}_${randomUUID()}`;
export const bounded = (value, fallback, max) => Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
export const credentialHeader = name => /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key)$|csrf|xsrf|access-token|auth-token/i.test(name);
export const safeHeaders = headers => Object.fromEntries(Object.entries(headers).filter(([key]) => !credentialHeader(key)));
export const requireString = (value, name) => { if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`); return value; };
export function boundedMap(map, max = 1000) { while (map.size > max) map.delete(map.keys().next().value); }

export function identitySummary(ref, item, includeCredentials = false) {
  return { identity_ref: ref, name: item.name, origin: item.origin, captured_at: item.captured_at,
    cookie_count: item.cookies.length, authorization_header_names: Object.keys(item.headers),
    local_storage_keys: Object.keys(item.local_storage), session_storage_keys: Object.keys(item.session_storage),
    credentials_opaque: !includeCredentials,
    ...(includeCredentials ? { credentials_sensitive: true, credentials: {
      cookies: item.cookies, authorization_headers: item.headers, local_storage: item.local_storage, session_storage: item.session_storage,
    } } : {}) };
}

function setPath(object, path, value) {
  const parts = path.split('.');
  if (!parts.length || parts.some(key => !key || ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('Unsafe or invalid mutation path');
  let current = object;
  for (const key of parts.slice(0, -1)) {
    if (current[key] === undefined) current[key] = {};
    if (!current[key] || typeof current[key] !== 'object') throw new Error(`Mutation path ${path} is not an object`);
    current = current[key];
  }
  current[parts.at(-1)] = value;
}

export function mutateRequest(request, mutations = {}) {
  for (const key of Object.keys(mutations)) if (!['url', 'query', 'path', 'path_segments', 'headers', 'json', 'form', 'graphql_variables'].includes(key)) throw new Error(`Unsupported mutation ${key}`);
  const original = new URL(request.url);
  const target = new URL(mutations.url || request.url, original);
  if (!['http:', 'https:'].includes(target.protocol) || original.origin !== target.origin || target.username || target.password) throw new Error('Replay mutations must remain on the captured origin');
  for (const [key, value] of Object.entries(mutations.query ?? {})) value === null ? target.searchParams.delete(key) : target.searchParams.set(key, String(value));
  const segments = target.pathname.split('/').slice(1);
  for (let i = 0; i < segments.length; i++) {
    const decoded = decodeURIComponent(segments[i]);
    if (Object.hasOwn(mutations.path ?? {}, decoded)) segments[i] = encodeURIComponent(String(mutations.path[decoded]));
    if (Object.hasOwn(mutations.path_segments ?? {}, String(i))) segments[i] = encodeURIComponent(String(mutations.path_segments[i]));
  }
  target.pathname = '/' + segments.join('/');
  let body = request.postData || undefined;
  if (mutations.json || mutations.graphql_variables) {
    const parsed = JSON.parse(body || '{}');
    if (!parsed || typeof parsed !== 'object') throw new Error('JSON mutation requires an object or array');
    for (const [key, value] of Object.entries(mutations.json ?? {})) setPath(parsed, key, value);
    for (const [key, value] of Object.entries(mutations.graphql_variables ?? {})) setPath(parsed, `variables.${key}`, value);
    body = JSON.stringify(parsed);
  }
  if (mutations.form) {
    const form = new URLSearchParams(body);
    for (const [key, value] of Object.entries(mutations.form)) value === null ? form.delete(key) : form.set(key, String(value));
    body = form.toString();
  }
  return { url: target.href, body };
}

export function objectCatalog(request, max = 100) {
  max = bounded(max, 100, 500);
  const candidates = [];
  const looks = value => /\d/.test(value) || String(value).length >= 8;
  const add = (source, path, value) => { if (candidates.length < max && looks(String(value))) candidates.push({ source, path, value: String(value).slice(0, 1000) }); };
  const url = new URL(request.url);
  url.pathname.split('/').slice(1).forEach((value, index) => add('path', `path_segments.${index}`, decodeURIComponent(value)));
  for (const [key, value] of url.searchParams) add('query', key, value);
  function walk(value, path, source, depth = 0) {
    if (depth > 20 || candidates.length >= max) return;
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`, source, depth + 1);
    else if (typeof value === 'number' || typeof value === 'string') add(source, path, value);
  }
  for (const [source, raw] of [['json', request.postData], ['response_json', request.responseBody]]) {
    try { walk(JSON.parse(raw), source, source); } catch { /* The response need not be JSON. */ }
  }
  return { candidates, total: candidates.length, truncated: candidates.length >= max };
}

function normalizedBody(body) {
  try {
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    return JSON.stringify(stable(JSON.parse(body)));
  } catch { return body.trim(); }
}
export function responseSummary(response) {
  const normalized = normalizedBody(response.body);
  return { status: response.status, body_sha256: createHash('sha256').update(normalized).digest('hex'),
    body_length: response.body.length, body_truncated: response.body_truncated,
    identifier_values: [...new Set(objectCatalog({ url: response.url, responseBody: response.body }, 100).candidates.map(item => item.value))] };
}

export function recordSitemap(state, request) {
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  const lineage = [];
  let parent = null;
  const add = (key, kind, label, metadata) => {
    const entryId = createHash('sha256').update(key).digest('hex').slice(0, 24);
    if (!state.sitemap.has(entryId)) state.sitemap.set(entryId, { id: entryId, parent_id: parent, kind, label, metadata, count: 0, statuses: new Set(), methods: new Set(), requests: [] });
    const entry = state.sitemap.get(entryId); lineage.push(entry); parent = entryId;
  };
  add(url.origin, 'ORIGIN', url.origin, {});
  const segments = url.pathname.split('/').filter(Boolean);
  let path = url.origin;
  for (const segment of segments.slice(0, -1)) { path += '/' + segment; add(path + '/', 'DIRECTORY', segment, {}); }
  add(`${url.origin}${url.pathname}:${request.method}`, 'REQUEST', `${request.method} ${segments.at(-1) || '/'}`, { path: url.pathname, query_parameter_names: [...new Set(url.searchParams.keys())] });
  for (const entry of lineage) {
    entry.count++; entry.methods.add(request.method); entry.last_seen = new Date().toISOString();
    if (request.status) entry.statuses.add(request.status);
    entry.requests.push({ request_id: request.requestId, method: request.method, path: url.pathname, captured_at: entry.last_seen });
    if (entry.requests.length > 30) entry.requests.shift();
  }
  boundedMap(state.sitemap, 2000);
  request.sitemapEntries = lineage.map(entry => entry.id);
}

export function sitemapSummary(entry, state) {
  return { id: entry.id, parent_id: entry.parent_id, kind: entry.kind, label: entry.label, metadata: entry.metadata,
    request_count: entry.count, status_codes: [...entry.statuses], methods: [...entry.methods], last_seen: entry.last_seen,
    has_descendants: [...state.sitemap.values()].some(item => item.parent_id === entry.id) };
}

export function readSitemap(state, input) {
  if (input.parent_id && !state.sitemap.has(input.parent_id)) throw new Error('sitemap parent_id was not found in this page');
  const entries = [];
  const visit = (parent, depth = 0) => {
    if (depth > 100) return;
    for (const item of state.sitemap.values()) if (item.parent_id === parent) {
      entries.push(sitemapSummary(item, state));
      if (input.depth === 'ALL') visit(item.id, depth + 1);
    }
  };
  visit(input.parent_id || null);
  const page = bounded(input.page, 1, 100000), size = bounded(input.page_size, 30, 100), offset = (page - 1) * size;
  return { capturing: true, entries: entries.slice(offset, offset + size), total_count: entries.length,
    page, page_size: size, has_more: offset + size < entries.length, depth: input.depth || 'DIRECT' };
}
