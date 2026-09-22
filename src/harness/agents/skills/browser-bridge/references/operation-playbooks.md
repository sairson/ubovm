# Browser Operation Playbooks

Use the section matching the current operational problem. Keep all actions on Worker-owned pages and authorized origins.

## Contents

- Stable interaction and waiting
- Route and endpoint discovery
- Network correlation and response evidence
- Identity-aware replay and authorization
- SPA and client-runtime analysis
- Frames, popups, and multiple pages
- WebSocket and SSE observation
- Service workers, cache, and storage
- CDP interception and protocol use
- Failure recovery

## Stable interaction and waiting

1. Call `accessibility` with a narrow `role` or `query` when the target control is known.
2. Use the returned `backend_node_id` only with extension `browser-bridge`; use the returned `ref` only with Obscura.
3. Perform one semantic action. For forms, prefer `fill` then `press`/`click`; verify the resulting value or state before submission when consequences matter.
4. Wait on `domcontentloaded`, `networkidle`, or a specific visible text only when the action truly requires it. Avoid fixed sleeps.
5. Refresh semantic state after navigation, submission, hydration, modal replacement, or route change.

For inaccessible custom controls, try `snapshot`, keyboard navigation, then a narrow `evaluate`. Use CDP Input/DOM only when those paths cannot express the operation. A stale identifier is state drift, not evidence of a security control.

## Route and endpoint discovery

Use three complementary inventories:

- `sitemap`: routes actually observed, parameter names, body shapes, status/MIME, request counts, and recent request IDs.
- `script_scan`: static leads in loaded inline/external JavaScript, including API, GraphQL, WebSocket, upload, and auth paths.
- `network`: runtime-only calls, redirects, preflights, initiators, polling, WebSocket frames, and service-worker traffic.

Start with the normal user journey so authenticated and lazy-loaded routes appear. Traverse Sitemap origin → directory → request → query/body nodes with pagination. Validate script-only leads by normal navigation or bounded runtime traffic; do not report an endpoint solely because it appears in a bundle.

## Network correlation and response evidence

1. Call `network_start` before the action and note the current sequence boundary when available.
2. Execute exactly one UI action with a unique canary.
3. Read `network` pages using `after_sequence=next_sequence` while `has_more=true`.
4. Correlate request and response events by `requestId`; record method, normalized URL, initiator/timestamp, redirect chain, status, MIME, and cache/service-worker indicators.
5. Retrieve `network_body` only for the decisive request and only the necessary page. Respect `base64_encoded` and pagination.
6. Re-snapshot the resulting UI and independently re-read durable state after writes.
7. Call `network_stop`; use `cdp_detach` only when all page-scoped protocol work is complete.

Do not clear an event page before recording its `next_sequence`. Do not treat `loadingFailed`, a timeout, or missing body as proof the server rejected or accepted the action.

## Identity-aware replay and authorization

1. Establish owner access through the normal UI and capture identity A with `identity_capture`.
2. Capture the decisive owner request with Network and save it as an opaque `request_ref`.
3. Switch through normal product controls to identity B, confirm visible account/tenant, and capture identity B.
4. Use `object_catalog` to select an observed owner, tenant, parent, or child identifier.
5. Run `authz_compare` with A as owner and B as other; include anonymous only when meaningful.
6. If a single-field diagnostic is needed, use `request_replay` with one `mutations` group and identity B.
7. For authorized writes, set `allow_unsafe=true` only for a disposable object and verify final state independently.

Preserve raw mutation order for duplicate-key/parser tests. If the application signs requests dynamically or binds CSRF material per request, reproduce the normal page flow rather than inventing or transplanting credentials.

## SPA and client-runtime analysis

- Observe URL, history, visible route, and Network together; a client route change may not issue a request.
- Capture bootstrap/hydration payloads and lazy API calls narrowly. Compare server-rendered markup, post-hydration DOM, and subsequent state only when relevant to a source/sink hypothesis.
- Use `script_scan` for route strings and APIs, then inspect the matching runtime request or function behavior with a narrow `evaluate`.
- For state stores, query only named keys/objects relevant to the test. Do not dump global objects, all storage, or framework internals.
- Record client-side validation separately from the server response. Bypassing a disabled control is not an authorization finding without server impact.

## Frames, popups, and multiple pages

- Use `tabs` after an action expected to open a window. Retain distinct page IDs and bind each to origin and identity.
- Prefer a new Worker-owned page for a tester-controlled cross-origin initiator. Confirm its identity assumptions separately because browser-profile state may be shared.
- For same-origin frames, use targeted `evaluate` or CDP DOM/Runtime with the relevant execution context. For cross-origin frames, rely on top-level UI, Network, frame-tree, and security events; do not assume DOM access.
- Record opener/source relationships for OAuth, `postMessage`, reverse-tabnabbing, or callback workflows. Close only pages created by the test.

## WebSocket and SSE observation

1. Start Network capture before connection or subscription.
2. Correlate the HTTP handshake, Origin, cookies/authorization, protocol/extension negotiation, and reconnect behavior.
3. Record outbound subscription/event names and inbound frames using bounded Network/CDP events.
4. Change one identity, tenant, channel, room, object, or filter at a time using normal application behavior or an explicitly authorized narrow script.
5. Require another actor's marker or unauthorized action for impact. Connection success, `101`, or an acknowledgement is insufficient.

For Socket.IO or polling fallbacks, compare namespace/event authorization across polling, upgrade, reconnect, subscribe, and each message.

## Service workers, cache, and storage

- Use CDP service-worker/storage/cache methods only for named origins and keys relevant to the hypothesis.
- Record registration scope, controller, script URL, update state, CacheStorage keys, and whether responses originate from service worker, memory/disk cache, or network.
- Compare before/after logout and across authorized identities with unique markers. Use cache-disabled or unique-query controls where appropriate.
- Do not clear cookies, storage, caches, registrations, or profile data unless the exact target and cleanup action are explicitly authorized.

## CDP interception and protocol use

Use CDP only when a structured action is insufficient:

1. Enable the smallest required domain (`Network`, `Fetch`, `Runtime`, `DOM`, `Page`, `Security`, `Storage`, `ServiceWorker`, or `Performance`).
2. Issue one exact command with bounded parameters.
3. Read asynchronous results with `cdp_events`, paginating by sequence and clearing only consumed events.
4. Check protocol errors and `evaluation.exceptionDetails` before accepting the result.
5. Always continue or fail paused `Fetch.requestPaused` events promptly; do not leave the page deadlocked.
6. Detach when finished.

Never use interception to redirect credentials cross-origin, silently alter unrelated traffic, or create a persistent browser modification.

## Failure recovery

- **Disconnect/binding error:** stop actions, call `browser_connection_status`, and resume only when connected.
- **Missing/closed page:** call `tabs`; create a new page only if the old state is not required. Re-establish identity and baseline.
- **Stale element:** refresh accessibility/snapshot; for Obscura retry once only with the supplied fresh `ref`.
- **Navigation timeout:** inspect current URL and semantic state before retrying. The navigation may have completed.
- **No Network events:** ensure capture started on the correct page before the action; repeat one harmless baseline, not the security mutation.
- **Body unavailable:** use response metadata, a fresh normal request, or a narrow page-visible control. Do not loop identical body reads.
- **Replay mismatch:** check identity selection, origin, CSRF/signature freshness, content type, redirects, and request shape one at a time.
- **Unsupported CDP capability:** record the runtime limitation and choose the nearest structured observation. Do not switch browser products.
- **Unexpected real data, write, notification, instability, or scope escape:** stop immediately, minimize retained evidence, and report the condition.
