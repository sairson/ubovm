# Browser tools

`createBrowserTools({ manager, sessionId, workerId, target })` returns pi `AgentTool` objects named
`browser_action` and `browser_connection_status`. `target` is the initial URL when a Worker does not yet
have a page. The tool schema preserves the reference implementation's snake_case fields.

```js
import { BrowserManager, createBrowserTools } from './index.mjs';

const manager = new BrowserManager({ channel: 'msedge' });
const tools = createBrowserTools({ manager, sessionId: 'assessment', workerId: 'worker-1', target: 'http://localhost:3000' });
// Supply tools to createPiWorker; close the manager at the end of the assessment.
await manager.close();
```

`BrowserManager` accepts an existing Playwright `browser`, an existing `context`, `executablePath`,
`channel`, or `cdpEndpoint`, plus optional `launchOptions`. Startup is lazy. No browser is downloaded.
Browsers launch headless by default. Set `launchOptions: { headless: false }` to show a browser
window (for example, `new BrowserManager({ channel: 'msedge', launchOptions: { headless: false } })`).
In desktop settings, open “浏览器与搜索”, turn off “无头模式（隐藏浏览器窗口）”, and save;
the setting is stored in `intools.browser.launchOptions.headless` and applies on the next browser
launch. It does not change the window mode of an existing browser connected through CDP.
An unconfigured manager reports `not_configured`. Caller-supplied browsers and contexts remain
caller-owned; `close()` closes only pages/contexts created for tools and a browser launched/connected
by this manager. A supplied context binds to one session/Worker; pass a browser for multiple Workers.

The manager's `status({sessionId, workerId})` and `call({sessionId, workerId, target}, input, signal)`
form a replaceable backend interface. A Chrome extension bridge can implement this interface; this
port supplies the Chromium backend and does not install the original extension's UI or bridge server.

Supported actions (39):

- Runtime/pages: `status`, `tabs`, `tab_new`, `tab_close`, `tab_activate`.
- Navigation: `navigate`, `back`, `forward`, `reload`.
- Inspection: `snapshot`, `accessibility`, `screenshot`, `evaluate`, `script_scan`.
- Interaction: `click`, `fill`, `select`, `press`, `hover`, `scroll`, `wait`.
- Protocol/network: `cdp`, `cdp_events`, `cdp_detach`, `network_start`, `network`, `network_body`, `network_stop`.
- Sitemap: `sitemap_start`, `sitemap`, `sitemap_entry`, `sitemap_clear`.
- Captured identities/requests: `identity_capture`, `identity_list`, `identity_delete`, `request_save`,
  `request_replay`, `object_catalog`, `authz_compare`.

Each session/Worker has a distinct browser context and up to four explicit pages. Calls serialize per
Worker. Unknown/cross-Worker page IDs are rejected; omitted page IDs use that Worker's selected page.
Popups are closed; create additional pages with `tab_new`. Snapshots generate opaque references;
new snapshots and navigation invalidate earlier references. Accessibility includes Chromium's semantic
tree plus refs from visible DOM controls; interact using refs, not backend node IDs. Inspection covers
the main document; use page-scoped CDP/evaluation for frame-specific requirements.

The default operation timeout is 30 seconds, maximum 120. Cancellation or timeout retires the Worker
context, closes its pages and in-flight replay requests, and prevents reuse by subsequent operations.
Waiting for startup uses Playwright's 30-second launch/connection timeout. Non-image tool responses
have a 60 KiB envelope; oversized results return an explicit truncation summary. Network and CDP
events use a bounded 1,000-event buffer with sequence pagination. Screenshots return a JPEG image
content block rather than JSON base64; a worker's own tool-result byte budget must fit the image.

Raw CDP is restricted to page domains. `Browser`, `Target`, `Storage`, cross-target IDs, and similar
browser-wide operations are rejected to preserve isolation. Asynchronous event capture includes
Network, Fetch, Runtime, Page, DOM, Security and Log events listed in `obscura/manager.mjs`; it is not
a wildcard subscription to every future protocol event. `cdp_detach` disables automatic network and
sitemap capture until a subsequent action reattaches. Sitemap records observed traffic, not a crawler.

Identities and request templates are isolated by page. Cookies, authorization headers and Web Storage
values are opaque unless `include_credentials: true` is supplied to identity/list/save actions.
Network/CDP/evaluation evidence can contain credentials. Replay uses a separate API request context,
never swaps the live page's cookies, stays on the original request origin, rejects identity-origin
mismatches, and never follows redirects. GET/HEAD/OPTIONS are permitted by default; other methods
require `allow_unsafe: true`. Replay supports `url`, `query`, `path`, `path_segments`, `headers`, `json`,
`form`, and `graphql_variables` mutations. Anonymous replay strips captured credentials. Applications
requiring runtime-generated request signatures must reproduce their normal page flow.

Authorization comparison returns normalized JSON/text hashes, identifier overlap, truncation flags,
optional anonymous controls and a preliminary verdict. Matching successful owner/other responses are
only leads; a matching anonymous response is flagged separately. External script scans use browser
fetch and therefore obey CORS; individual inaccessible scripts appear in `errors`.

This backend has been verified against a local HTTP fixture with an installed Edge browser.
