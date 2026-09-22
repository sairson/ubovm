# Browser Security Test Catalog

Load only the family relevant to the current hypothesis. Use the evidence loop and scope rules in `SKILL.md`; this catalog supplies browser-specific test matrices, not automatic findings.

## Contents

- Authentication and session lifecycle
- Authorization and tenant isolation
- Input handling and browser injection
- CSRF, CORS, messaging, and navigation
- Files, downloads, and URL handling
- Workflow, replay, and concurrency
- Browser policy and client persistence
- Active-lab limits

## Authentication and session lifecycle

Build a state table across login, pre-authentication, password-only intermediate state, MFA-complete state, logout, recovery, credential change, role change, and session expiry. For each transition, record cookies/storage changes, redirect chain, protected-resource behavior, and whether a fresh tab or reload changes the result.

- Compare the same protected read before login, after login, after logout, and after credential/session rotation.
- Check fixation by observing whether the relevant session identifier rotates at authentication and privilege elevation; never expose its full value.
- Verify that logout and account/security changes invalidate the old browser state through a harmless protected read.
- For recovery and MFA, use only designated accounts and a tiny attempt budget. Test step ordering, purpose/subject binding, backup-code single use, and whether an intermediate session reaches protected resources.
- Compare login/register/recovery error semantics with a few designated identifiers; status, body structure, length, and timing differences are leads until reproducible.
- Treat a rendered login page, redirect, or changed cookie alone as insufficient. Confirm the resulting local identity and protected capability.

## Authorization and tenant isolation

Create two test identities and two test-owned objects when authorized. Record object owner, tenant, parent resource, object type, and state before mutation.

- Capture the owner's normal request with `network_start` and `request_save`; capture both identities with non-secret names.
- Use `object_catalog` to enumerate observed identifiers in path, query, JSON/form body, GraphQL variables, response, parent resource, attachment, export, share, job, and secondary lookup.
- Mutate one identifier location at a time. Test parent and child independently, then compound IDs only after their topology is known.
- Use `authz_compare` for owner/non-owner and optional anonymous controls. Interpret normalized hashes and identifier overlap with response meaning; generic success envelopes are not access proof.
- Exercise alternate read surfaces that the legitimate UI reveals: detail, download, attachment, export, history, batch, background-job result, GraphQL nested edge, or WebSocket subscription.
- For writes, use a disposable object and `allow_unsafe=true` only when explicitly authorized. Verify the authoritative state with an independent read as each identity.
- Stop immediately on real third-party data. Preserve the smallest redacted marker that proves ownership and access.

## Input handling and browser injection

Map the value from source to final browser context: URL/query/hash, form, API response, postMessage, storage, WebSocket, hydration data, upload metadata, or third-party content into HTML, attribute, URL, script, style, DOM API, template, or navigation sink.

- Begin with a unique inert canary and harmless metacharacters. Observe encoding/decoding at the request, response, DOM, and post-hydration stages.
- Use a context-specific non-networking proof only after identifying the sink. Prefer a page-state marker; do not read cookies, storage, DOM secrets, or keystrokes.
- Revisit stored inputs in a fresh navigation and, when relevant, a second authorized test role to distinguish first-order, stored, second-order, and mutation behavior.
- Record CSP/Trusted Types enforcement, sanitizer behavior, framework hydration, and browser console/security events where they change exploitability.
- Test client-side prototype changes only through a real merge/parser path with a unique canary, then require a concrete reachable gadget. A reflected `__proto__` key is insufficient.
- Treat errors, reflection, source-code matches, and blocked probes as leads. Confirm execution or a reversible server-side semantic change.

## CSRF, CORS, messaging, and navigation

- Determine whether the target action uses ambient cookies/HTTP auth, whether SameSite permits the navigation/request shape, and whether the endpoint accepts a simple request, top-level navigation, or method override.
- Test token absence, reuse, subject/session/purpose binding, and Origin/Referer behavior including missing or `null`, using only a tester-controlled page and account.
- For CORS, compare exact allowed origin against scheme, host, port, subdomain, suffix/prefix, encoded/IDNA, and `null` variants. Observe both preflight and actual response and verify whether protected content is readable in the requesting origin.
- For `postMessage`, record sender origin, source window/frame, message schema, receiver validation, and privileged sink. Test source and origin independently with a harmless canary.
- For WebSocket, verify browser Origin handling at handshake and per-message identity/object authorization after connection.
- For redirects, compare application validation with final browser canonicalization and record every hop, scheme/host/port, userinfo, slash/backslash, and encoding transformation. Use only an allowlisted tester destination.
- Do not host public lures or involve other users. A permissive header, wildcard target origin, or accepted redirect parameter alone is not demonstrated impact.

## Files, downloads, and URL handling

- Upload one small inert file with a unique marker. Compare filename/extension, declared MIME, observed content type, storage name/path, preview/processor result, and download disposition.
- Revisit the artifact as owner, another test identity, and signed-out state when authorized. Check direct URLs, thumbnails, conversions, attachments, and stale links separately.
- Use browser download and Network metadata to prove filename, MIME, caching, authorization, and navigation behavior without opening active content.
- For path handling, request only a known tester fixture. For server-side URL fetch, use a lab-owned callback or synthetic internal fixture; never scan ranges or real metadata services.
- Active documents, polyglots, executables, oversized archives, malware signatures, and parser resource-exhaustion probes require an explicitly isolated lab and separate authorization.

## Workflow, replay, and concurrency

Model the authoritative state machine and invariant before mutation: allowed actor, order, amount, currency, entitlement, quota, approval, inventory, or single-use token.

- Capture a successful baseline and then test skip, repeat, reverse, stale-state replay, alternate endpoint, duplicate submit, cancellation race, or idempotency reuse one dimension at a time.
- Use zero-value/test-only transactions and suppress external notification or fulfillment. Verify the server-side durable state rather than the UI toast.
- For idempotency, distinguish a replayed response from a second side effect. For ordering, prove the forbidden transition persisted.
- Run concurrency only with explicit authorization, disposable fixtures, a predetermined request ceiling, and the smallest useful concurrency starting at two. Stop on latency, errors, queue growth, or instability.

## Browser policy and client persistence

- Record the effective final-origin response policy after redirects: CSP header/meta precedence and report-only status, HSTS, framing, Referrer-Policy, Permissions-Policy, MIME sniffing, mixed content, and certificate/security state.
- For CSP, map actual nonce/hash/`strict-dynamic` behavior, script sources, base/object/frame restrictions, Trusted Types, and an observed reachable gadget. Missing directives alone are hardening evidence.
- For service workers, record registration origin, scope, script/update URL, controlling state, cache names/keys, navigation fallback, logout cleanup, and behavior across identities. Do not unregister or clear user state unless explicitly authorized.
- Compare sensitive browser-rendered data across reload, back/forward cache, logout, a fresh tab, and cache-disabled controls. Avoid collecting unrelated storage.
- For frames/popups, bind each observation to frame origin, opener relationship, and page ID. Same-origin script access and cross-origin browser isolation must be distinguished.

## Active-lab limits

Before deeper verification, write down request budget, maximum concurrency, seeded accounts/objects, readable markers, callbacks, prohibited effects, and cleanup plan.

- Mutate only traffic produced by the connected browser and only through documented `browser_action` operations.
- Use synthetic rows, fixed template variables, harmless command markers, lab files, or lab callbacks. Do not pivot, persist, dump credentials, or access operating-system secrets.
- Stop after the first reproducible boundary crossing or confirmed primitive; switch to negative controls and regression validation instead of expanding impact.
- No public lures, real payments, external notifications, production writes, metadata-service probing, broad identifier brute force, denial of service, or propagation.
