import { Type } from 'typebox';
import { withActionHelp, withProgressiveDisclosure } from '../../intools/shared/disclosure.mjs';
import { HARNESS_PROJECT_CATALOG } from '../../intools/shared/tool-catalogs.mjs';

const profileSchema = Type.Object({
  name: Type.String({ pattern: '^[a-z][a-z0-9-]{0,47}$' }),
  instructions: Type.String({ minLength: 1, maxLength: 8192 }),
  modelProfile: Type.Optional(Type.String({ pattern: '^[\\w.-]{1,86}$' })),
  allowedTools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 })),
  maxModelCalls: Type.Optional(Type.Integer({ minimum: 0 })),
  maxToolCalls: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
function validate(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new TypeError('Invalid Harness profile');
  if (Object.keys(profile).some(key => !['name', 'instructions', 'modelProfile', 'allowedTools', 'maxModelCalls', 'maxToolCalls'].includes(key))) throw new TypeError('Unknown Harness profile field');
  if (profile.modelProfile !== undefined && (typeof profile.modelProfile !== 'string' || !/^[\w.-]{1,86}$/.test(profile.modelProfile))) throw new TypeError('Invalid modelProfile');
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(profile.name ?? '') || typeof profile.instructions !== 'string' || !profile.instructions.trim() || profile.instructions.length > 8192) throw new TypeError('Invalid profile name or instructions');
  if (profile.allowedTools !== undefined && (!Array.isArray(profile.allowedTools) || profile.allowedTools.length > 128 || profile.allowedTools.some(name => typeof name !== 'string' || !name || name.length > 128))) throw new TypeError('Invalid profile tool list');
  for (const key of ['maxModelCalls', 'maxToolCalls']) if (profile[key] !== undefined && (!Number.isSafeInteger(profile[key]) || profile[key] < 0)) throw new TypeError(`Invalid profile ${key}`);
  return { name: profile.name, instructions: profile.instructions.trim(),
    ...(profile.modelProfile !== undefined ? { modelProfile: profile.modelProfile } : {}),
    ...(profile.allowedTools !== undefined ? { allowedTools: [...new Set(profile.allowedTools)].sort() } : {}),
    ...Object.fromEntries(['maxModelCalls', 'maxToolCalls'].filter(key => profile[key] !== undefined).map(key => [key, profile[key]])) };
}

/** Immutable profile revisions; a queued worker binds an exact profile ID. */
export function createHarnessProject({ state, save = () => {} } = {}) {
  let current = { version: 1, revision: 0, profiles: [] }, tail = Promise.resolve();
  if (state !== undefined) {
    if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.profiles) || state.profiles.length > 64) throw new TypeError('Invalid saved Harness project');
    const ids = new Set();
    for (const { id, ...profile } of state.profiles) {
      validate(profile);
      if (typeof id !== 'string' || !new RegExp(`^${profile.name}@[1-9][0-9]*$`).test(id) || ids.has(id) || Number(id.split('@')[1]) > state.revision) throw new TypeError('Invalid saved profile identity');
      ids.add(id);
    }
    current = structuredClone(state);
  }
  const snapshot = () => structuredClone(current);
  const get = id => {
    if (id === undefined) return undefined;
    const profile = current.profiles.find(item => item.id === id);
    if (!profile) throw new Error(`Unknown Harness profile: ${id}`);
    return structuredClone(profile);
  };
  async function manage(input, signal) {
    signal?.throwIfAborted();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid Harness project request');
    if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) throw new TypeError('Invalid expectedRevision');
    // Reads observe all writes submitted before this request.
    if (['list', 'export'].includes(input.action)) { await tail; signal?.throwIfAborted(); }
    if (input.action === 'list') return snapshot();
    if (input.action === 'export') return { version: 1, profiles: [...new Map(current.profiles.map(({ id, ...profile }) => [profile.name, profile])).values()].map(profile => structuredClone(profile)) };
    if (!['define', 'import', 'validate'].includes(input.action)) throw new TypeError('Unknown Harness project action');
    if (input.profile !== undefined && input.project !== undefined) throw new TypeError('Provide profile or project, not both');
    const useProject = input.action === 'import' || input.action === 'validate' && input.project !== undefined;
    const source = useProject ? input.project?.profiles : [input.profile];
    if (useProject && (input.project?.version !== 1 || Object.keys(input.project).some(key => !['version', 'profiles'].includes(key)))) throw new TypeError('Invalid Harness project manifest');
    if (!Array.isArray(source) || !source.length || source.length > 64) throw new TypeError('Provide 1..64 profiles');
    const profiles = source.map(validate);
    const names = new Set();
    for (const profile of profiles) { if (names.has(profile.name)) throw new Error('Duplicate profile name in import'); names.add(profile.name); }
    if (input.action === 'validate') return { valid: true, profiles };
    const operation = tail.then(async () => {
      signal?.throwIfAborted();
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) throw Object.assign(new Error('Harness project changed; list the latest revision before editing'), { code: 'HARNESS_PROJECT_CONFLICT' });
      const latest = new Map(current.profiles.map(({ id, ...profile }) => [profile.name, { id, profile }]));
      const changed = profiles.filter(profile => {
        const previous = latest.get(profile.name);
        return !previous || JSON.stringify(validate(previous.profile)) !== JSON.stringify(profile);
      });
      if (!changed.length) return { revision: current.revision, unchanged: true, profiles: profiles.map(profile => get(latest.get(profile.name).id)) };
      if (current.profiles.length + changed.length > 64 || current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Harness project profile capacity reached');
      const revision = current.revision + 1;
      const added = changed.map(profile => ({ ...profile, id: `${profile.name}@${revision}` }));
      const next = { version: 1, revision, profiles: [...current.profiles, ...added] };
      await save(structuredClone(next));
      current = next;
      return { revision, profiles: profiles.map(profile => get(added.find(item => item.name === profile.name)?.id ?? latest.get(profile.name).id)) };
    });
    tail = operation.catch(() => {});
    return operation;
  }
  return { get, snapshot, manage, tool: withProgressiveDisclosure({
    name: 'manage_harness_project', label: 'Customize Harness project',
    description: HARNESS_PROJECT_CATALOG.description,
    parameters: Type.Object(withActionHelp({
      expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      profile: Type.Optional(profileSchema),
      project: Type.Optional(Type.Object({ version: Type.Literal(1), profiles: Type.Array(profileSchema, { minItems: 1, maxItems: 64 }) }, { additionalProperties: false }))
    }), { additionalProperties: false }),
    execute: async (_id, input, signal) => { const value = await manage(input, signal); return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; }
  }, HARNESS_PROJECT_CATALOG) };
}

export function applyHarnessProfile({ profile, options, tools, inherited }) {
  const limits = { ...options };
  for (const key of ['maxModelCalls', 'maxToolCalls']) {
    const finite = [options[key], inherited?.options[key], profile?.[key]].filter(value => value > 0);
    limits[key] = finite.length ? Math.min(...finite) : 0;
  }
  const available = new Set(tools.map(tool => tool.name));
  for (const name of profile?.allowedTools ?? []) if (!available.has(name) || inherited && !inherited.toolNames.has(name)) throw new Error(`Harness profile requests unavailable tool: ${name}`);
  const selected = tools.filter(tool => (!inherited || inherited.toolNames.has(tool.name)) && (!profile?.allowedTools || profile.allowedTools.includes(tool.name)));
  return { options: limits, tools: selected, toolNames: new Set(selected.map(tool => tool.name)) };
}
