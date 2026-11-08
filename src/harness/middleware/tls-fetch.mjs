/**
 * A small fetch() implementation for MCP HTTP transports that need TLS trust
 * the global fetch cannot express: a self-signed certificate or a private CA.
 * Node's global fetch goes through undici and offers no per-request TLS
 * options, so an `https://` MCP endpoint whose certificate is not in the system
 * store always fails with `fetch failed` even though every other requirement is
 * met. Servers opt in explicitly (`insecureTls` / `tlsCa`); every other server
 * keeps using global fetch and full certificate verification.
 *
 * Only the shape the MCP SDK relies on is implemented: absolute http(s) URLs,
 * string/Buffer bodies, `Headers` (or plain object) request headers, abort
 * signals, streaming responses and ordinary redirects. Proxies are not handled
 * here, matching the previous behaviour of global fetch in this harness.
 */
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { Readable } from 'node:stream';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const BODYLESS_STATUS = new Set([101, 204, 205, 304]);
const MAX_REDIRECTS = 5;

function headerObject(headers) {
  const result = {};
  if (!headers) return result;
  if (typeof headers.entries === 'function') {
    for (const [key, value] of headers.entries()) result[key] = value;
    return result;
  }
  for (const [key, value] of Array.isArray(headers) ? headers : Object.entries(headers)) result[key] = String(value);
  return result;
}

function bodyBuffer(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new TypeError('MCP TLS fetch only supports string or Buffer request bodies');
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

/** Build a fetch implementation pinned to the supplied TLS trust settings. */
export function createTlsFetch({ rejectUnauthorized = true, ca } = {}) {
  if (typeof rejectUnauthorized !== 'boolean') throw new TypeError('rejectUnauthorized must be boolean');
  if (ca !== undefined && typeof ca !== 'string') throw new TypeError('ca must be a PEM certificate string');
  const tlsOptions = { rejectUnauthorized, ...(ca ? { ca } : {}) };

  function hop(url, init, method, body) {
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? requestHttps : requestHttp)({
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: headerObject(init.headers),
        ...(url.protocol === 'https:' ? tlsOptions : {}),
      }, response => {
        cleanup();
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') headers.set(key, value);
          else if (Array.isArray(value)) headers.set(key, value.join(', '));
        }
        const status = response.statusCode ?? 500;
        resolve(new Response(BODYLESS_STATUS.has(status) ? null : Readable.toWeb(response), {
          status, statusText: response.statusMessage ?? '', headers,
        }));
      });
      const signal = init.signal;
      let onAbort;
      if (signal) {
        if (signal.aborted) { request.destroy(); reject(abortError(signal)); return; }
        onAbort = () => request.destroy(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      function cleanup() { if (onAbort) signal.removeEventListener('abort', onAbort); }
      request.once('error', error => { cleanup(); reject(error); });
      if (body) request.write(body);
      request.end();
    });
  }

  return async function fetchWithTls(input, init = {}) {
    let url;
    if (typeof input === 'string') url = new URL(input);
    else if (input instanceof URL) url = input;
    else url = new URL(String(input?.url ?? input));
    let method = String(init.method ?? 'GET').toUpperCase();
    let body = bodyBuffer(init.body);
    for (let redirects = 0; ; redirects++) {
      const response = await hop(url, init, method, body);
      if (!REDIRECT_STATUS.has(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      if (redirects >= MAX_REDIRECTS) throw new TypeError(`Too many redirects fetching ${url.href}`);
      try { await response.body?.cancel(); } catch { /* redirect bodies are irrelevant */ }
      url = new URL(location, url);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
      }
    }
  };
}
