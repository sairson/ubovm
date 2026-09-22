import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

export const jsonResult = (output) => ({ content: [{ type: 'text', text: JSON.stringify(output) }], details: output });
export const compact = (value, maximum = 512) => Array.from(String(value ?? '').replace(/\s+/gu, ' ').trim()).slice(0, maximum).join('');
export function knownKeys(value, keys, label = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`Unknown ${label} field: ${key}`);
}
export function integer(value, fallback, minimum, maximum, name) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
export function boundedString(value, name, maximum, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  value = value.replace(/\s+/gu, ' ').trim();
  if ((required && !value) || Buffer.byteLength(value) > maximum) throw new TypeError(`${name} is ${required ? 'required and ' : ''}limited to ${maximum} bytes`);
  return value;
}
export function boolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}
export function httpURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('An absolute HTTP(S) URL is required'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new TypeError('Only HTTP(S) URLs without userinfo are allowed');
  url.hash = '';
  return url;
}
export function linkURL(value, base) {
  try { return httpURL(new URL(value, base)).href; } catch { return ''; }
}

const blocked = new BlockList();
for (const cidr of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '::/128', '::1/128', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8']) {
  const [ip, bits] = cidr.split('/'); blocked.addSubnet(ip, Number(bits), isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}
export function isPublicIP(address) {
  const family = isIP(address);
  return Boolean(family) && !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}
const blockedPorts = new Set([22, 23, 25, 110, 143, 445, 465, 587, 993, 995, 1433, 3306, 3389, 5432, 5900, 6379, 11211, 27017]);
function abortable(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
async function validateDestination(url, options, signal) {
  if (blockedPorts.has(Number(url.port))) throw Object.assign(new Error(`Port ${url.port} is not permitted for web content retrieval`), { code: 'BLOCKED_DESTINATION' });
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (options.allowedHost && hostname !== options.allowedHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')) throw Object.assign(new Error('Host is outside the allowed source'), { code: 'BLOCKED_DESTINATION' });
  if (options.allowPrivateAddresses) return undefined;
  let records;
  try { records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable((options.lookup ?? dnsLookup)(hostname, { all: true, verbatim: true }), signal); }
  catch (error) { signal?.throwIfAborted(); throw Object.assign(new Error('Could not resolve host', { cause: error }), { code: 'DNS_ERROR' }); }
  if (!Array.isArray(records) || !records.length || records.some(({ address }) => !isPublicIP(address))) throw Object.assign(new Error('Destination resolves to a private or non-routable/reserved address'), { code: 'BLOCKED_DESTINATION' });
  return records;
}

// Native requests pin the validated IPs in lookup. There is no second DNS lookup
// between validation and connection, no proxy, and redirects are handled below.
function nativeFetch(url, init, addresses) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: init.method, headers: init.headers, signal: init.signal, agent: false,
      ...(addresses ? { lookup(_host, lookupOptions, callback) {
        const family = typeof lookupOptions === 'number' ? lookupOptions : lookupOptions.family;
        const filtered = addresses.filter((entry) => !family || entry.family === family);
        if (!filtered.length) return callback(new Error('No validated address for requested family'));
        if (lookupOptions?.all) callback(null, filtered);
        else callback(null, filtered[0].address, filtered[0].family);
      } } : {}),
    }, (response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const encoding = headers.get('content-encoding');
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
      let stream = response;
      if (decoder) {
        response.on('error', (error) => decoder.destroy(error));
        decoder.on('close', () => response.destroy());
        stream = response.pipe(decoder);
      }
      const body = [204, 205, 304].includes(response.statusCode) ? null : Readable.toWeb(stream);
      if (body === null) response.resume();
      resolve(new Response(body, { status: response.statusCode, headers }));
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

export class HTTPStatusError extends Error {
  constructor(status, url) { super(`Server returned HTTP ${status}`); this.status = status; this.url = url; }
}

async function boundedBody(response, maximum, truncate, signal) {
  if (!response.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const parts = [];
  let bytes = 0, truncated = false;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      const part = Buffer.from(value);
      if (bytes + part.length > maximum) {
        if (!truncate) throw new Error(`Response exceeds ${maximum} bytes`);
        parts.push(part.subarray(0, maximum - bytes));
        bytes = maximum;
        truncated = true;
        break;
      }
      parts.push(part); bytes += part.length;
    }
  } finally { void reader.cancel().catch(() => {}); }
  return { body: Buffer.concat(parts, bytes), truncated };
}

/** Fetch injection is a trusted host transport hook; it must honor manual redirects.
 * The default secured transport pins DNS and enforces the destination at connection time.
 */
export async function requestBytes(rawURL, options = {}) {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let url = httpURL(rawURL);
  let method = options.method ?? 'GET', body = options.body;
  const headers = new Headers(options.headers);
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const addresses = options.secure ? await validateDestination(url, options, signal) : undefined;
    const init = { method, headers: Object.fromEntries(headers), body, signal, redirect: 'manual' };
    const operation = options.fetch ? options.fetch(url.href, init) : options.secure ? nativeFetch(url, init, addresses) : globalThis.fetch(url, init);
    const response = await abortable(operation, signal);
    if (!(response instanceof Response)) throw new TypeError('HTTP transport must return a Response');
    if (response.redirected) { void response.body?.cancel().catch(() => {}); throw new Error('HTTP transport followed a redirect without destination validation'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      if (redirects >= (options.maxRedirects ?? 10)) throw Object.assign(new Error('Too many redirects'), { code: 'REDIRECT_LIMIT' });
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect is missing Location');
      const next = httpURL(new URL(location, url));
      if (next.origin !== url.origin) {
        // Credentials and POST bodies must never be redirected to another host.
        if (headers.has('authorization') || body) throw new Error('Authenticated or body-bearing cross-origin redirect is not permitted');
        headers.delete('cookie'); headers.delete('x-project-id'); headers.delete('referer');
      }
      if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) { method = 'GET'; body = undefined; headers.delete('content-type'); }
      url = next; continue;
    }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new HTTPStatusError(response.status, url.href); }
    const bounded = await boundedBody(response, options.maxResponseBytes ?? 2 * 1024 * 1024, Boolean(options.truncate), signal);
    return { ...bounded, url, status: response.status, headers: response.headers };
  }
}
export async function retry(operation, { attempts = 1, backoffMs = 200, signal, shouldRetry = (error) => error instanceof HTTPStatusError && [408, 429, 500, 502, 503, 504].includes(error.status) } = {}) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      signal?.throwIfAborted();
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      await delay(backoffMs * attempt, undefined, { signal });
    }
  }
}

export function validateHTTPOptions(options) {
  integer(options.timeoutMs, 30_000, 1, 300_000, 'timeoutMs');
  integer(options.maxResponseBytes, 2 * 1024 * 1024, 1, 64 * 1024 * 1024, 'maxResponseBytes');
  integer(options.maxRedirects, 10, 0, 20, 'maxRedirects');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new TypeError('fetch must be a function');
  if (options.lookup !== undefined && typeof options.lookup !== 'function') throw new TypeError('lookup must be a function');
  boolean(options.allowPrivateAddresses, false, 'allowPrivateAddresses');
  if (options.allowedHost !== undefined && (typeof options.allowedHost !== 'string' || !options.allowedHost.trim())) throw new TypeError('allowedHost must be a hostname');
}
