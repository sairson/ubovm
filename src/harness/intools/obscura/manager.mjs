import { id, bounded, boundedMap, requireString, credentialHeader, safeHeaders, identitySummary,
  mutateRequest, objectCatalog, responseSummary, recordSitemap, readSitemap, sitemapSummary } from './features.mjs';

const EVENTS = ['Network.requestWillBeSent', 'Network.requestWillBeSentExtraInfo', 'Network.responseReceived',
  'Network.responseReceivedExtraInfo', 'Network.loadingFinished', 'Network.loadingFailed', 'Network.dataReceived',
  'Network.webSocketCreated', 'Network.webSocketClosed', 'Network.webSocketFrameReceived', 'Network.webSocketFrameSent',
  'Network.webSocketWillSendHandshakeRequest', 'Network.webSocketHandshakeResponseReceived', 'Network.eventSourceMessageReceived',
  'Fetch.requestPaused', 'Fetch.authRequired', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown',
  'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared',
  'Page.frameNavigated', 'Page.frameStartedLoading', 'Page.frameStoppedLoading', 'Page.loadEventFired',
  'Page.domContentEventFired', 'Page.javascriptDialogOpening', 'Page.javascriptDialogClosed', 'Page.lifecycleEvent',
  'Page.downloadWillBegin', 'Page.downloadProgress', 'DOM.documentUpdated', 'DOM.setChildNodes',
  'DOM.childNodeInserted', 'DOM.childNodeRemoved', 'DOM.attributeModified', 'DOM.characterDataModified',
  'Security.securityStateChanged', 'Security.visibleSecurityStateChanged', 'Log.entryAdded'];
const timeoutError = () => Object.assign(new Error('Browser action timed out; its isolated context was closed to stop unfinished work'), { name: 'TimeoutError' });

/** Lazy Chromium runtime. Existing browser/context objects remain caller-owned. */
export class BrowserManager {
  constructor({ browser, context, executablePath, channel, cdpEndpoint, launchOptions = {} } = {}) {
    this.options = { browser, context, executablePath, channel, cdpEndpoint, launchOptions };
    this.browser = browser || context?.browser?.();
    this.scopes = new Map(); this.queues = new Map(); this.starting = null; this.closed = false;
    this.ownsBrowser = false; this.contextBinding = null;
  }
  async status({ sessionId, workerId } = {}) {
    const configured = Boolean(this.options.browser || this.options.context || this.options.executablePath || this.options.channel || this.options.cdpEndpoint);
    const connected = !this.closed && Boolean(this.browser?.isConnected?.() || this.options.context && !this.options.context.isClosed?.());
    const available = configured && !this.closed && (!this.browser || this.browser.isConnected());
    const scope = this.scopes.get(JSON.stringify([sessionId, workerId]));
    return { session_id: sessionId, worker_id: workerId, source: 'obscura', manager_available: true,
      configured, available, connected, browser_action_available: available, isolated: true,
      state: this.closed ? 'closed' : connected ? 'connected' : configured ? 'configured' : 'not_configured',
      worker_page_id: scope?.active || null,
      guidance: available ? 'Chromium starts lazily; use navigate or tab_new.' : 'Configure executablePath, channel, cdpEndpoint, or inject a Playwright browser/context. No browser is downloaded automatically.' };
  }
  async start() {
    if (this.closed) throw new Error('Browser manager is closed');
    if (this.browser || this.options.context) return;
    if (!this.starting) this.starting = (async () => {
      const { chromium } = await import('playwright-core');
      const { cdpEndpoint, executablePath, channel, launchOptions } = this.options;
      if (!cdpEndpoint && !executablePath && !channel) throw new Error('Browser is not configured; set executablePath, channel or cdpEndpoint');
      const browser = cdpEndpoint ? await chromium.connectOverCDP(cdpEndpoint, { timeout: 30000 })
        : await chromium.launch({ headless: true, timeout: 30000, ...launchOptions, ...(executablePath ? { executablePath } : {}), ...(channel ? { channel } : {}) });
      if (this.closed) { await browser.close(); throw new Error('Browser manager closed during startup'); }
      this.browser = browser; this.ownsBrowser = true;
    })().catch(error => { this.starting = null; throw error; });
    await this.starting;
  }
  async scope(key) {
    if (this.scopes.has(key)) return this.scopes.get(key);
    await this.start();
    let context, ownsContext = true;
    if (this.options.context) {
      if (this.contextBinding && this.contextBinding !== key) throw new Error('Injected context is bound to another Worker; inject a browser to create isolated Worker contexts');
      this.contextBinding = key; context = this.options.context; ownsContext = false;
    } else context = await this.browser.newContext();
    const scope = { key, context, ownsContext, pages: new Map(), identities: new Map(), templates: new Map(), requestsInFlight: new Set(), retired: false };
    this.scopes.set(key, scope);
    return scope;
  }
  call(binding, input, signal) {
    signal?.throwIfAborted();
    if (input.action === 'status') return this.status(binding);
    const key = JSON.stringify([binding.sessionId, binding.workerId]);
    const previous = this.queues.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const scope = await this.scope(key);
      signal?.throwIfAborted();
      if (scope.retired) throw new Error('Browser context is closed');
      const timeout = bounded(input.timeout_seconds, 30, 120) * 1000;
      let timer, abortHandler;
      const cancellation = new Promise((_, reject) => {
        const cancel = error => {
          scope.retired = true; this.scopes.delete(key);
          // Closing the owned pages/context interrupts navigation, evaluation and interactions.
          // Retired operations never reuse this context or register late pages in a new scope.
          this.disposeScope(scope).catch(() => {});
          reject(error);
        };
        timer = setTimeout(() => cancel(timeoutError()), timeout);
        abortHandler = () => cancel(signal.reason instanceof Error ? signal.reason : new Error('Browser action aborted'));
        signal?.addEventListener('abort', abortHandler, { once: true });
      });
      try { return await Promise.race([this.perform(scope, binding, input, timeout, signal), cancellation]); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abortHandler); }
    });
    this.queues.set(key, operation);
    operation.finally(() => { if (this.queues.get(key) === operation) this.queues.delete(key); }).catch(() => {});
    if (!signal) return operation;
    // A queued caller can cancel immediately without interrupting the preceding caller's page.
    return new Promise((resolve, reject) => {
      const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason instanceof Error ? signal.reason : new Error('Browser action aborted')); };
      signal.addEventListener('abort', cancel, { once: true });
      operation.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
      if (signal.aborted) cancel();
    });
  }
  async disposeScope(scope) {
    await Promise.allSettled([...scope.requestsInFlight].map(request => request.dispose()));
    scope.requestsInFlight.clear();
    if (scope.ownsContext) await scope.context.close().catch(() => {});
    else await Promise.allSettled([...scope.pages.values()].map(state => state.page.close()));
    scope.pages.clear(); scope.identities.clear(); scope.templates.clear();
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.scopes.values()].map(scope => { scope.retired = true; return this.disposeScope(scope); }));
    this.scopes.clear();
    if (this.ownsBrowser) await this.browser?.close();
  }
  check(scope, signal) { signal?.throwIfAborted(); if (scope.retired || this.closed) throw new Error('Browser operation context was closed'); }
  async newPage(scope, url, timeout, signal) {
    this.check(scope, signal);
    if (scope.pages.size >= 4) throw new Error('Worker already owns the maximum of 4 pages');
    const page = await scope.context.newPage();
    if (scope.retired || signal?.aborted) { await page.close(); this.check(scope, signal); }
    const state = { id: id('page'), page, requests: new Map(), events: [], sequence: 0, network: false, sitemap: new Map(), cdp: null, refs: new Map(), generation: 0 };
    scope.pages.set(state.id, state); scope.active = state.id;
    page.on('close', () => {
      scope.pages.delete(state.id); if (scope.active === state.id) scope.active = [...scope.pages.keys()].at(-1);
      for (const [key, item] of scope.identities) if (item.page_id === state.id) scope.identities.delete(key);
      for (const [key, item] of scope.templates) if (item.page_id === state.id) scope.templates.delete(key);
    });
    page.on('popup', popup => popup.close().catch(() => {}));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) { state.refs.clear(); state.generation++; } });
    await this.cdp(scope, state);
    this.check(scope, signal);
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    return state;
  }
  async cdp(scope, state) {
    if (state.cdp) return state.cdp;
    const cdp = await scope.context.newCDPSession(state.page);
    if (scope.retired) { await cdp.detach(); throw new Error('Browser context closed'); }
    state.cdp = cdp;
    for (const method of EVENTS) cdp.on(method, params => {
      if (scope.retired || state.cdp !== cdp) return;
      const network = method.startsWith('Network.');
      if (!network || state.network) {
        state.events.push({ sequence: ++state.sequence, method, params });
        if (state.events.length > 1000) state.events.shift();
      }
      if (method === 'Network.requestWillBeSent') {
        const item = { ...params.request, requestId: params.requestId, page_id: state.id, captured_at: new Date().toISOString() };
        state.requests.set(params.requestId, item); boundedMap(state.requests, 1000); recordSitemap(state, item);
      } else if (method === 'Network.requestWillBeSentExtraInfo') {
        const item = state.requests.get(params.requestId); if (item) item.headers = { ...item.headers, ...params.headers };
      } else if (method === 'Network.responseReceived') {
        const item = state.requests.get(params.requestId);
        if (item) {
          item.status = params.response.status; item.responseHeaders = params.response.headers;
          for (const entry of item.sitemapEntries || []) state.sitemap.get(entry)?.statuses.add(item.status);
        }
      }
    });
    await cdp.send('Network.enable', { maxTotalBufferSize: 16 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024, maxPostDataSize: 65536 });
    return cdp;
  }
  async summary(state) { return { page_id: state.id, url: state.page.url(), title: await state.page.title().catch(() => '') }; }
  async resolve(scope, binding, input, timeout, signal) {
    if (input.page_id) {
      const state = scope.pages.get(input.page_id);
      if (!state) throw new Error('page_id is unknown or belongs to another Worker');
      return state;
    }
    const current = scope.pages.get(scope.active);
    if (current) return current;
    const url = input.action === 'navigate' ? input.url : binding.target;
    if (!url) throw new Error('No Worker page exists; call tab_new with a URL first');
    return this.newPage(scope, url, timeout, signal);
  }
  async perform(scope, binding, input, timeout, signal) {
    const action = input.action;
    if (action === 'tabs') return { pages: await Promise.all([...scope.pages.values()].map(state => this.summary(state))) };
    if (action === 'tab_new') return this.summary(await this.newPage(scope, input.url || binding.target || 'about:blank', timeout, signal));
    const state = await this.resolve(scope, binding, input, timeout, signal);
    this.check(scope, signal);
    const page = state.page;
    const common = { page_id: state.id };
    switch (action) {
      case 'tab_close': await page.close(); return { ...common, closed: true };
      case 'tab_activate': await page.bringToFront(); scope.active = state.id; return this.summary(state);
      case 'navigate': await page.goto(requireString(input.url, 'url'), { waitUntil: 'domcontentloaded', timeout }); return this.summary(state);
      case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout }); return this.summary(state);
      case 'forward': await page.goForward({ waitUntil: 'domcontentloaded', timeout }); return this.summary(state);
      case 'reload': await page.reload({ waitUntil: 'domcontentloaded', timeout }); return this.summary(state);
      case 'snapshot': return { ...common, ...await this.snapshot(state, input) };
      case 'accessibility': return { ...common, ...await this.accessibility(scope, state, input) };
      case 'click': case 'fill': case 'select': case 'press': case 'hover': {
        if (input.backend_node_id) throw new Error('Obscura interactions require a snapshot/accessibility ref');
        const ref = requireString(input.ref, 'ref');
        const selector = state.refs.get(ref); if (!selector) throw new Error('Unknown or stale element ref; take a new snapshot');
        const locator = page.locator(selector);
        if (action === 'fill') await locator.fill(input.value ?? '', { timeout });
        else if (action === 'select') await locator.selectOption(input.value ?? '', { timeout });
        else if (action === 'press') await locator.press(requireString(input.key, 'key'), { timeout });
        else await locator[action]({ timeout });
        return { ...common, action, completed: true };
      }
      case 'scroll': await page.mouse.wheel(input.delta_x || 0, input.delta_y || (input.delta_x ? 0 : 600)); return { ...common, completed: true };
      case 'wait': {
        const condition = requireString(input.wait_for, 'wait_for');
        if (['load', 'domcontentloaded', 'networkidle'].includes(condition)) await page.waitForLoadState(condition, { timeout });
        else await page.getByText(condition, { exact: false }).first().waitFor({ state: 'visible', timeout });
        return { ...common, completed: true };
      }
      case 'evaluate': {
        const cdp = await this.cdp(scope, state);
        const evaluation = await cdp.send('Runtime.evaluate', { expression: requireString(input.script, 'script'), awaitPromise: true, returnByValue: true, timeout });
        if (evaluation.exceptionDetails) throw new Error(`Browser JavaScript failed: ${evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text}`);
        return { ...common, result: evaluation.result?.value ?? evaluation.result?.unserializableValue ?? null };
      }
      case 'screenshot': {
        const bytes = await page.screenshot({ type: 'jpeg', quality: 65, timeout });
        if (bytes.length > 4 * 1024 * 1024) throw new Error('Screenshot exceeds 4 MiB; reduce the viewport');
        return { ...common, mime_type: 'image/jpeg', image: { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' } };
      }
      case 'cdp': {
        const method = requireString(input.method, 'method');
        if (!/^(Accessibility|Animation|CSS|DOM|DOMDebugger|DOMSnapshot|Debugger|Emulation|Fetch|Input|Inspector|LayerTree|Log|Network|Overlay|Page|Performance|Profiler|Runtime|Security|WebAudio)\.[A-Za-z0-9]+$/.test(method)) throw new Error('CDP method is outside the isolated page domains (Browser, Target and Storage are blocked)');
        if (input.command_params?.sessionId || input.command_params?.browserContextId || input.command_params?.targetId) throw new Error('Cross-target CDP parameters are forbidden');
        return { ...common, method, result: await (await this.cdp(scope, state)).send(method, input.command_params || {}) };
      }
      case 'cdp_events': case 'network': return { ...common, ...this.events(state, input, action === 'network') };
      case 'cdp_detach': {
        if (state.cdp) await state.cdp.detach(); state.cdp = null; state.events = []; state.network = false;
        return { ...common, detached: true };
      }
      case 'network_start': await this.cdp(scope, state); state.network = true; state.events = []; return { ...common, capturing: true };
      case 'network_stop': state.network = false; return { ...common, capturing: false, sitemap_capturing: true };
      case 'network_body': {
        requireString(input.request_id, 'request_id');
        if (!state.requests.has(input.request_id)) throw new Error('request_id was not captured on this page');
        const response = await (await this.cdp(scope, state)).send('Network.getResponseBody', { requestId: input.request_id });
        const offset = Math.max(0, input.offset || 0), max = bounded(input.max_bytes, 32768, 65536);
        const body = response.body.slice(offset, offset + max);
        return { ...common, request_id: input.request_id, body, base64_encoded: response.base64Encoded, offset,
          next_offset: offset + body.length, has_more: offset + body.length < response.body.length, total_characters: response.body.length };
      }
      case 'sitemap_start': await this.cdp(scope, state); return { ...common, capturing: true, seeded: state.sitemap.size, record_limit: 2000 };
      case 'sitemap': return { ...common, ...readSitemap(state, input) };
      case 'sitemap_entry': {
        const entry = state.sitemap.get(input.entry_id); if (!entry) throw new Error('sitemap entry_id was not found in this page');
        return { ...common, entry: sitemapSummary(entry, state), child_ids: [...state.sitemap.values()].filter(item => item.parent_id === entry.id).map(item => item.id), recent_requests: entry.requests, sensitive_values_omitted: true };
      }
      case 'sitemap_clear': state.sitemap.clear(); return { ...common, cleared: true };
      case 'identity_capture': return { ...common, ...await this.captureIdentity(scope, state, input) };
      case 'identity_list': return { ...common, identities: [...scope.identities].filter(([, item]) => item.page_id === state.id).map(([ref, item]) => identitySummary(ref, item, input.include_credentials)) };
      case 'identity_delete': {
        const item = scope.identities.get(input.identity_ref), found = item?.page_id === state.id;
        if (found) scope.identities.delete(input.identity_ref);
        return { ...common, deleted: found, identity_ref: input.identity_ref };
      }
      case 'request_save': return { ...common, ...await this.saveRequest(scope, state, input) };
      case 'request_replay': return { ...common, ...await this.replay(scope, state, input, timeout, signal) };
      case 'object_catalog': return { ...common, request_ref: input.request_ref, ...objectCatalog(this.template(scope, state, input.request_ref), input.max_candidates) };
      case 'authz_compare': return { ...common, ...await this.compare(scope, state, input, timeout, signal) };
      case 'script_scan': return { ...common, ...await this.scriptScan(scope, state, input, timeout) };
      default: throw new Error(`Unknown browser action ${action}`);
    }
  }
  events(state, input, networkOnly) {
    const selected = state.events.filter(item => item.sequence > (input.after_sequence || 0) && (!networkOnly || item.method.startsWith('Network.')));
    const events = selected.slice(0, bounded(input.limit, 50, 200));
    if (input.clear) { const ids = new Set(events.map(item => item.sequence)); state.events = state.events.filter(item => !ids.has(item.sequence)); }
    return { events, next_sequence: events.at(-1)?.sequence ?? input.after_sequence ?? 0,
      has_more: events.length < selected.length, capturing: state.network, earliest_sequence: state.events[0]?.sequence ?? state.sequence };
  }
  async snapshot(state, input) {
    const token = id('ref').replaceAll('-', ''), max = bounded(input.max_elements, 120, 300);
    const data = await state.page.evaluate(({ token, max, chars }) => {
      const nodes = [...document.querySelectorAll('a,button,input,textarea,select,summary,[role],[contenteditable="true"],[tabindex]')]
        .filter(node => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width && rect.height && style.visibility !== 'hidden' && style.display !== 'none'; });
      const elements = nodes.slice(0, max).map((node, index) => {
        const ref = `${token}_${index}`; node.setAttribute('data-intools-ref', ref);
        const label = node.getAttribute('aria-label') || node.labels?.[0]?.innerText || node.innerText || node.getAttribute('placeholder') || node.getAttribute('title') || '';
        return { ref, tag: node.tagName.toLowerCase(), role: node.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' }[node.tagName]) || '',
          name: label.slice(0, 300), ...(node.type === 'password' ? {} : { value: String(node.value || '').slice(0, 300) }), href: node.getAttribute('href') || undefined };
      });
      const text = document.body?.innerText || '';
      return { url: location.href, title: document.title, text: text.slice(0, chars), elements, text_truncated: text.length > chars, elements_truncated: nodes.length > max };
    }, { token, max, chars: bounded(input.max_chars, 6000, 20000) });
    state.refs.clear(); for (const element of data.elements) state.refs.set(element.ref, `[data-intools-ref="${element.ref}"]`);
    return data;
  }
  async accessibility(scope, state, input) {
    const snapshot = await this.snapshot(state, { ...input, max_elements: input.max_elements || 300, max_chars: 1 });
    const { nodes } = await (await this.cdp(scope, state)).send('Accessibility.getFullAXTree');
    const filtered = nodes.filter(node => (input.include_ignored || !node.ignored) && (input.include_text || !['StaticText', 'InlineTextBox'].includes(node.role?.value))
      && (!input.role || String(node.role?.value).toLowerCase() === input.role.toLowerCase())
      && (!input.query || [node.name?.value, node.value?.value, node.description?.value].join(' ').toLowerCase().includes(input.query.toLowerCase())));
    const offset = Math.max(0, input.offset || 0), max = bounded(input.max_nodes, 100, 300);
    const compact = filtered.slice(offset, offset + max).map(node => ({ role: node.role?.value, name: node.name?.value,
      value: node.value?.value, description: node.description?.value, ignored: node.ignored,
      states: node.properties?.filter(item => !['labelledby', 'describedby'].includes(item.name)).map(item => ({ name: item.name, value: item.value.value })) }));
    return { url: state.page.url(), tree: compact, nodes: compact, elements: snapshot.elements.filter(item => (!input.role || item.role.toLowerCase() === input.role.toLowerCase()) && (!input.query || item.name.toLowerCase().includes(input.query.toLowerCase()))),
      offset, next_offset: offset + compact.length, has_more: offset + compact.length < filtered.length, total_nodes: filtered.length };
  }
  async captureIdentity(scope, state, input) {
    const origin = new URL(state.page.url()).origin;
    if (!/^https?:/.test(origin)) throw new Error('identity_capture requires an HTTP(S) page');
    const cookies = await scope.context.cookies(state.page.url());
    const storage = await state.page.evaluate(() => {
      const read = storage => { const result = {}; let size = 0; for (let i = 0; i < Math.min(storage.length, 200); i++) { const key = storage.key(i), value = storage.getItem(key); if (size + key.length + value.length > 32768) break; result[key] = value.slice(0, 8192); size += key.length + value.length; } return result; };
      return { local_storage: read(localStorage), session_storage: read(sessionStorage) };
    });
    let headers = {};
    for (const request of state.requests.values()) {
      if (new URL(request.url).origin !== origin) continue;
      const candidate = Object.fromEntries(Object.entries(request.headers).filter(([key]) => credentialHeader(key) && !/cookie/i.test(key)));
      if (Object.keys(candidate).length) headers = candidate;
    }
    const ref = id('identity'), item = { page_id: state.id, origin, name: input.name || '', cookies, headers, ...storage, captured_at: new Date().toISOString() };
    scope.identities.set(ref, item); boundedMap(scope.identities, 100);
    return identitySummary(ref, item, input.include_credentials);
  }
  async saveRequest(scope, state, input) {
    const request = state.requests.get(requireString(input.request_id, 'request_id'));
    if (!request) throw new Error('request_id was not captured on this page');
    let responseBody;
    try { const result = await (await this.cdp(scope, state)).send('Network.getResponseBody', { requestId: input.request_id }); responseBody = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body; } catch { /* Body may have been evicted or is still loading. */ }
    const ref = id('request');
    scope.templates.set(ref, { ...structuredClone(request), responseBody: responseBody?.slice(0, 2 * 1024 * 1024) }); boundedMap(scope.templates, 200);
    const url = new URL(request.url); const queryNames = [...url.searchParams.keys()]; for (const key of queryNames) url.searchParams.set(key, '[redacted]');
    return { request_ref: ref, request_id: input.request_id, method: request.method,
      url: input.include_credentials ? request.url : url.href, header_names: Object.keys(request.headers), has_body: Boolean(request.postData),
      captured_response_status: request.status, captured_response_characters: responseBody?.length || 0,
      credentials_opaque: !input.include_credentials, ...(input.include_credentials ? { request_headers: request.headers, credentials_sensitive: true } : {}) };
  }
  template(scope, state, ref) {
    const request = scope.templates.get(requireString(ref, 'request_ref'));
    if (!request || request.page_id !== state.id) throw new Error('request_ref was not found on this page');
    return request;
  }
  async replay(scope, state, input, timeout, signal) {
    const request = this.template(scope, state, input.request_ref);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase()) && !input.allow_unsafe) throw new Error(`Replay of ${request.method} requires allow_unsafe`);
    const identity = input.identity_ref ? scope.identities.get(input.identity_ref) : undefined;
    if (input.identity_ref && (!identity || identity.page_id !== state.id)) throw new Error('identity_ref was not found on this page');
    const { url, body } = mutateRequest(request, input.mutations);
    if (identity && identity.origin !== new URL(url).origin) throw new Error('Identity credentials may only be replayed on their captured origin');
    const headers = { ...safeHeaders(request.headers), ...identity?.headers };
    for (const key of Object.keys(headers)) if (/^(host|content-length|connection|accept-encoding)$/i.test(key)) delete headers[key];
    for (const [key, value] of Object.entries(input.mutations?.headers || {})) {
      if (/^(host|content-length|connection)$/i.test(key)) throw new Error(`Replay header ${key} cannot be overridden`);
      for (const existing of Object.keys(headers)) if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
      if (value !== null) headers[key] = String(value);
    }
    const { request: api } = await import('playwright-core');
    this.check(scope, signal);
    const context = await api.newContext({ storageState: { cookies: identity?.cookies || [], origins: [] }, timeout });
    scope.requestsInFlight.add(context);
    const abort = () => context.dispose().catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });
    // Manager deadlines retire scope; an independent timer also interrupts this isolated request context.
    const timer = setTimeout(abort, timeout);
    try {
      this.check(scope, signal);
      const response = await context.fetch(url, { method: request.method, headers, ...(body === undefined ? {} : { data: body }), maxRedirects: 0, timeout, failOnStatusCode: false });
      this.check(scope, signal);
      const buffer = await response.body();
      return { request_ref: input.request_ref, identity_ref: input.identity_ref || '', url: response.url(), method: request.method,
        status: response.status(), headers: safeHeaders(response.headers()), body: buffer.subarray(0, 32768).toString('utf8'), body_truncated: buffer.length > 32768,
        redirects_followed: false, base64_encoded: false };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); scope.requestsInFlight.delete(context); await context.dispose(); }
  }
  async compare(scope, state, input, timeout, signal) {
    requireString(input.owner_identity_ref, 'owner_identity_ref'); requireString(input.other_identity_ref, 'other_identity_ref');
    const owner = responseSummary(await this.replay(scope, state, { ...input, identity_ref: input.owner_identity_ref }, timeout, signal));
    const other = responseSummary(await this.replay(scope, state, { ...input, identity_ref: input.other_identity_ref }, timeout, signal));
    const equal = owner.status >= 200 && owner.status < 300 && owner.status === other.status && !owner.body_truncated && !other.body_truncated && owner.body_sha256 === other.body_sha256;
    const output = { request_ref: input.request_ref, owner, other, identifier_overlap: owner.identifier_values.filter(value => other.identifier_values.includes(value)),
      verdict: equal ? 'potential_idor' : 'authorization_enforced_or_response_differs', preliminary: true };
    if (input.include_anonymous) {
      output.anonymous = responseSummary(await this.replay(scope, state, { ...input, identity_ref: undefined }, timeout, signal));
      if (equal && output.anonymous.status === owner.status && output.anonymous.body_sha256 === owner.body_sha256) output.verdict = 'same_response_for_anonymous_review_public_resource';
    }
    return output;
  }
  async scriptScan(scope, state, input, timeout) {
    const source = input.source || 'all'; if (!['all', 'inline', 'external'].includes(source)) throw new Error('source must be all, inline or external');
    const flags = input.flags || 'gi'; if (!/^[gimsu]*$/.test(flags) || new Set(flags).size !== flags.length) throw new Error('Invalid script_scan flags');
    const max = bounded(input.max_source_chars, 262144, 2097152), matches = bounded(input.max_matches, 100, 500);
    const expression = `(${async ({ source, flags, pattern, max, matches }) => {
      const rules = pattern ? [['custom', pattern]] : [
        ['absolute_url', 'https?://[^\\s"\'<>`]+'], ['websocket_url', 'wss?://[^\\s"\'<>`]+'],
        ['api_endpoint', '/(?:api|rest|graphql|v[0-9]+|admin|internal|auth|oauth|sso|upload|download)(?:/[A-Za-z0-9._~!$&()*+,;=:@%?{}-]+)+'],
        ['jwt', 'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{8,}'],
        ['aws_access_key', '(?:AKIA|ASIA)[A-Z0-9]{16}'], ['private_key', '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'],
        ['secret_assignment', '(?:api[_-]?key|secret|access[_-]?token|client[_-]?secret)\\s*[:=]\\s*["\'][^"\'\\r\\n]{8,512}["\']'],
      ];
      const output = [], errors = []; let scanned = 0, count = 0, truncated = false;
      for (const [index, script] of [...document.scripts].slice(0, 64).entries()) {
        if (source === 'inline' && script.src || source === 'external' && !script.src) continue;
        let text = script.textContent || '';
        if (script.src) {
          try {
            const response = await fetch(script.src, { signal: AbortSignal.timeout(5000) });
            const reader = response.body.getReader(); const chunks = []; let bytes = 0;
            while (bytes < max) { const { value, done } = await reader.read(); if (done) break; chunks.push(value.subarray(0, max - bytes)); bytes += value.length; }
            await reader.cancel(); const decoder = new TextDecoder(); text = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
          } catch (error) { errors.push({ source: script.src, error: String(error).slice(0, 200) }); continue; }
        }
        count++; const original = text.length; text = text.slice(0, Math.min(max, 16 * 1024 * 1024 - scanned)); scanned += text.length; if (original > text.length) truncated = true;
        for (const [category, pattern] of rules) {
          const regex = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g'); let match;
          while ((match = regex.exec(text))) {
            output.push({ category, match: match[0].slice(0, 2000), captures: match.slice(1, 21), source_url: script.src || location.href + '#inline-script-' + index, source_kind: script.src ? 'external' : 'inline', script_index: index, line: text.slice(0, match.index).split('\n').length });
            if (output.length >= matches) return { matches: output, errors, source_count: count, scanned_characters: scanned, truncated: true };
            if (match[0] === '') regex.lastIndex++;
          }
        }
        if (scanned >= 16 * 1024 * 1024) { truncated = true; break; }
      }
      return { matches: output, errors, source_count: count, scanned_characters: scanned, truncated };
    }})(${JSON.stringify({ source, flags, pattern: input.pattern || '', max, matches })})`;
    const result = await (await this.cdp(scope, state)).send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout });
    if (result.exceptionDetails) throw new Error(`script_scan failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return { ...result.result.value, source_scope: source, max_matches: matches, max_source_chars: max };
  }
}
