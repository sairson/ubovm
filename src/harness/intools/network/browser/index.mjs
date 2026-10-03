import { Type } from 'typebox';
import { BrowserManager } from '../obscura/manager.mjs';
import { createIdeBrowserBridge, IDE_BROWSER_ACTIONS, IDE_BROWSER_UNSUPPORTED_HINT } from './ide-bridge.mjs';
import {
  BROWSER_ACTION_DOCS, BROWSER_CORE_DESCRIPTION, BROWSER_IDE_DESCRIPTION, BROWSER_HELP_TIERS,
  buildBrowserHelp, browserActionsForBackend,
} from './disclosure.mjs';

export { createIdeBrowserBridge, IDE_BROWSER_ACTIONS, IDE_BROWSER_UNSUPPORTED_HINT };
export {
  BROWSER_ACTION_DOCS, BROWSER_CORE_DESCRIPTION, BROWSER_IDE_DESCRIPTION, BROWSER_HELP_TIERS,
  buildBrowserHelp, browserActionsForBackend,
} from './disclosure.mjs';

export { BrowserManager };

/** All executable actions including progressive-disclosure help. */
export const BROWSER_ACTIONS = Object.freeze([
  'help',
  ...BROWSER_ACTION_DOCS.map(doc => doc.action).filter(action => action !== 'help'),
]);

const strings = ['page_id', 'url', 'ref', 'query', 'role', 'value', 'key', 'wait_for', 'script', 'pattern', 'flags',
  'source', 'name', 'identity_ref', 'owner_identity_ref', 'other_identity_ref', 'request_ref', 'method',
  'request_id', 'parent_id', 'entry_id', 'depth', 'level', 'topic'];
const integers = ['backend_node_id', 'page', 'page_size', 'limit', 'after_sequence', 'max_bytes', 'offset',
  'max_chars', 'max_elements', 'max_nodes', 'max_matches', 'max_source_chars', 'max_candidates', 'delta_x', 'delta_y'];
const booleans = ['clear', 'include_text', 'include_ignored', 'include_anonymous', 'include_credentials', 'allow_unsafe', 'checked', 'full_page', 'allow_popups'];

/** Flat parameter bag; per-action requirements are disclosed via action=help. */
export const browserActionParameters = Type.Object({
  action: Type.String({ minLength: 1, maxLength: 64, description: 'Browser verb. Start with help, status, navigate, snapshot, click, fill, wait, screenshot, tabs.' }),
  ...Object.fromEntries(strings.map(key => [key, Type.Optional(Type.String())])),
  ...Object.fromEntries(integers.map(key => [key, Type.Optional(Type.Integer())])),
  ...Object.fromEntries(booleans.map(key => [key, Type.Optional(Type.Boolean())])),
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
  values: Type.Optional(Type.Array(Type.String(), { maxItems: 300 })),
  mutations: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  command_params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });

function result(value) {
  const source = value?.source || 'obscura';
  if (value?.image) {
    const { image, ...metadata } = value;
    return { content: [{ type: 'text', text: JSON.stringify(metadata) }, image], details: { ...metadata, source } };
  }
  let text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 60 * 1024) {
    const truncated = { truncated: true,
      original_bytes: Buffer.byteLength(text), preview: text.slice(0, 16000),
      guidance: 'Refine filters or paginate the result.', source };
    return { content: [{ type: 'text', text: JSON.stringify(truncated) }], details: truncated };
  }
  const details = value && typeof value === 'object' ? { ...value, source } : { source, value };
  return { content: [{ type: 'text', text }], details };
}

function isIdeBrowserManager(manager) {
  return manager?.source === 'ide-browser'
    || (Array.isArray(manager?.supportedActions) && manager.supportedActions.includes('navigate')
      && !manager.supportedActions.includes('identity_capture'));
}

function unknownActionResult(action, { ide, available }) {
  const sample = [...available].filter(name => name !== 'help').slice(0, 8);
  return {
    ok: false,
    error: `Unknown browser action "${action}". Call action=help for the progressive catalog.`,
    action,
    source: ide ? 'ide-browser' : 'obscura',
    examples: sample,
    help: { action: 'help', topic: 'core' },
  };
}

/** Build genuine pi AgentTool objects. Manager can also be a scoped bridge implementing status/call. */
export function createBrowserTools({ manager = new BrowserManager(), sessionId, workerId, target = '' } = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('browser requires sessionId');
  if (typeof workerId !== 'string' || !workerId.trim()) throw new TypeError('browser requires workerId');
  const scope = { sessionId, workerId, target };
  const ide = isIdeBrowserManager(manager);
  const backend = ide ? 'ide-browser' : 'obscura';
  const available = new Set(
    ide
      ? ['help', ...(manager.supportedActions?.length ? manager.supportedActions : IDE_BROWSER_ACTIONS)]
      : BROWSER_ACTIONS
  );
  return [{
    name: 'browser_action', label: 'Browser action', executionMode: 'sequential',
    description: ide ? BROWSER_IDE_DESCRIPTION : BROWSER_CORE_DESCRIPTION,
    parameters: browserActionParameters,
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted();
      if (!args || typeof args.action !== 'string' || !args.action.trim()) throw new TypeError('Unknown browser action');
      const action = args.action.trim();
      if (args.timeout_seconds !== undefined && (!Number.isInteger(args.timeout_seconds) || args.timeout_seconds < 1 || args.timeout_seconds > 120)) {
        throw new RangeError('timeout_seconds must be 1..120');
      }
      if (action === 'help') {
        return result(buildBrowserHelp({
          topic: args.topic || args.query || args.name,
          backend,
          availableActions: [...available],
          source: backend,
        }));
      }
      if (!BROWSER_ACTIONS.includes(action) || !available.has(action)) {
        if (ide && BROWSER_ACTIONS.includes(action) && !available.has(action)) {
          return result({ ok: false, error: IDE_BROWSER_UNSUPPORTED_HINT, action, source: 'ide-browser',
            help: { action: 'help', topic: 'core' } });
        }
        return result(unknownActionResult(action, { ide, available }));
      }
      return result(await manager.call(scope, { ...args, action }, signal));
    },
  }, {
    name: 'browser_connection_status', label: 'Browser connection status', executionMode: 'sequential',
    description: ide
      ? 'Inspect IDE Integrated Browser readiness without launching a separate Chromium. For action catalog use browser_action action=help.'
      : 'Inspect browser configuration without launching or downloading a browser. For action catalog use browser_action action=help.',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_id, _args, signal) => {
      signal?.throwIfAborted();
      const status = await manager.status(scope);
      return result({
        ...status,
        source: status?.source || backend,
        help: { action: 'help', topic: 'core' },
        available_tiers: ide
          ? BROWSER_HELP_TIERS.filter(tier => ['core', 'interaction', 'tabs', 'inspect'].includes(tier))
          : [...BROWSER_HELP_TIERS],
      });
    },
  }];
}
