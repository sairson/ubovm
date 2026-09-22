import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { Type } from 'typebox';
import { SkillRegistry, createSkillResourceTool } from '../intools/skill-resource-read.mjs';
import { createSkillScriptTool } from '../intools/skill-script-command.mjs';
import { expandHome, integer, requireText, textResult } from '../intools/common.mjs';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const clone = value => structuredClone(value);
const failure = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });

function skillName(value) {
  if (typeof value !== 'string' || value.length > 64 || !NAME.test(value)) throw failure('INVALID_SKILL', 'Skill name must contain 1-64 lowercase letters, digits, or single hyphens');
  return value;
}

function splitSkill(text, path) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') throw failure('INVALID_SKILL', `${path} must start with YAML frontmatter`);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) throw failure('INVALID_SKILL', `${path} is missing the frontmatter closing delimiter`);
  const document = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true, maxAliasCount: 0 });
  if (document.errors.length) throw failure('INVALID_SKILL', `${path} contains invalid YAML: ${document.errors[0].message}`);
  let metadata;
  try { metadata = document.toJS({ maxAliasCount: 0 }); }
  catch (cause) { throw failure('INVALID_SKILL', `${path} contains unsupported YAML aliases`, cause); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw failure('INVALID_SKILL', `${path} frontmatter must be an object`);
  const name = skillName(metadata.name);
  const description = requireText(metadata.description, `${path} description`);
  if (Buffer.byteLength(description) > 1024) throw failure('INVALID_SKILL', `${path} description exceeds 1024 bytes`);
  const content = lines.slice(end + 1).join('\n').trim();
  if (!content) throw failure('INVALID_SKILL', `${path} must contain instructions after its frontmatter`);
  // The pi Worker executes skills inline. Never silently turn a requested fork,
  // model override, or agent route into instructions for the current Worker.
  if (metadata.context !== undefined && !['', 'inline'].includes(metadata.context)) throw failure('UNSUPPORTED_SKILL_RUNTIME', `${path}: context ${JSON.stringify(metadata.context)} requires a skill agent router; only inline skills are supported`);
  if (metadata.agent || metadata.model) throw failure('UNSUPPORTED_SKILL_RUNTIME', `${path}: agent/model routing is not configured for inline skills`);
  return { name, description, content };
}

async function readBounded(path, maximum) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw failure('INVALID_SKILL', `${path} must be a regular file`);
  const handle = await open(path, 'r');
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > maximum) throw failure('SKILL_LIMIT_EXCEEDED', `${path} exceeds ${maximum} bytes or is not a regular file`);
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > maximum) throw failure('SKILL_LIMIT_EXCEEDED', `${path} exceeds ${maximum} bytes`);
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

async function supportingFiles(directory, maximum) {
  const files = [];
  let entriesSeen = 0;
  async function visit(relative = '') {
    for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entriesSeen > maximum) throw failure('SKILL_LIMIT_EXCEEDED', `${directory} contains more than ${maximum} package entries`);
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw failure('INVALID_SKILL', `${directory}: symbolic links are not allowed in skill packages`);
      if (entry.isDirectory()) await visit(path);
      else if (!entry.isFile()) throw failure('INVALID_SKILL', `${directory}: ${path} is not a regular file`);
      else if (path !== 'SKILL.md') files.push(path);
    }
  }
  await visit();
  return files;
}

async function discover(options) {
  const maxSkills = integer(options.maxSkills, 160, 1, 1000, 'maxSkills');
  const maxSkillBytes = integer(options.maxSkillBytes, 256 << 10, 1, 4 << 20, 'maxSkillBytes');
  const maxTotalBytes = integer(options.maxTotalBytes, 4 << 20, 1, 64 << 20, 'maxTotalBytes');
  const maxFiles = integer(options.maxFiles, 256, 1, 4096, 'maxFiles');
  if (options.directories !== undefined && !Array.isArray(options.directories)) throw new TypeError('directories must be an array');
  if (options.skills !== undefined && !Array.isArray(options.skills)) throw new TypeError('skills must be an array');
  const candidates = [...(options.skills ?? [])];
  for (const directory of options.directories ?? []) {
    const root = resolve(expandHome(requireText(directory, 'skills directory')));
    let info;
    try { info = await lstat(root); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('INVALID_SKILL', `${root} must be a regular directory`);
    const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const directory = join(root, entry.name);
      try { await lstat(join(directory, 'SKILL.md')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      candidates.push({ directory });
    }
  }
  const catalog = new Map(), directories = new Map();
  let total = 0;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TypeError('Each skill must provide a directory');
    const path = resolve(expandHome(requireText(candidate.directory, 'skill.directory')));
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('INVALID_SKILL', `${path} must be a regular directory`);
    const directory = await realpath(path);
    const directoryKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
    if (directories.has(directoryKey)) {
      if (candidate.name !== undefined && candidate.name !== directories.get(directoryKey)) throw failure('INVALID_SKILL', `${path}: configured name does not match SKILL.md`);
      continue;
    }
    if (catalog.size >= maxSkills) throw failure('SKILL_LIMIT_EXCEEDED', `Skill count exceeds ${maxSkills}`);
    const bytes = await readBounded(join(directory, 'SKILL.md'), maxSkillBytes);
    total += bytes.length;
    if (total > maxTotalBytes) throw failure('SKILL_LIMIT_EXCEEDED', `Total skill content exceeds ${maxTotalBytes} bytes`);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (cause) { throw failure('INVALID_SKILL', `${path}/SKILL.md must be UTF-8 text`, cause); }
    const skill = splitSkill(text, join(directory, 'SKILL.md'));
    if (candidate.name !== undefined && candidate.name !== skill.name) throw failure('INVALID_SKILL', `${path}: configured name does not match SKILL.md`);
    if (catalog.has(skill.name)) throw failure('DUPLICATE_SKILL', `Duplicate skill name: ${skill.name}`);
    const files = await supportingFiles(directory, maxFiles);
    catalog.set(skill.name, Object.freeze({ ...skill, directory, files: Object.freeze(files), fingerprint: createHash('sha256').update(bytes).digest('hex') }));
    directories.set(directoryKey, skill.name);
  }
  return new Map([...catalog].sort(([a], [b]) => a.localeCompare(b)));
}

/** Progressive skill discovery, with independent and durable Worker activations. */
export async function createSkillsMiddleware(options = {}) {
  const catalog = await discover(options);
  const maxActiveBytes = integer(options.maxActiveBytes, 512 << 10, 1, 64 << 20, 'maxActiveBytes');
  const maxWorkers = integer(options.maxWorkers, 10000, 1, 100000, 'maxWorkers');
  for (const name of ['persist', 'onEvent']) if (options[name] !== undefined && typeof options[name] !== 'function') throw new TypeError(`${name} must be a function`);
  if (options.allowedSkills !== undefined && !Array.isArray(options.allowedSkills) && typeof options.allowedSkills !== 'function') throw new TypeError('allowedSkills must be an array or function');
  if (Array.isArray(options.allowedSkills)) for (const name of options.allowedSkills) if (!catalog.has(skillName(name))) throw failure('SKILL_NOT_FOUND', `Unknown allowed skill: ${name}`);
  const lifetime = new AbortController(), operations = new Set();
  let closed = false, closing, queue = Promise.resolve(), state;
  const assertOpen = () => { if (closed) throw failure('SKILLS_CLOSED', 'Skills middleware is closed'); };
  const workerId = context => requireText(context?.node?.id ?? context?.workerId, 'Worker id');
  const publicSkill = skill => ({ name: skill.name, description: skill.description, directory: skill.directory, fingerprint: skill.fingerprint });
  const renderSkill = skill => `# Skill: ${skill.name}\n\n${skill.content}${skill.files.length ? `\n\nAvailable supporting files:\n${skill.files.map(path => `- ${JSON.stringify(path)}`).join('\n')}` : ''}`;
  const emit = event => { try { Promise.resolve(options.onEvent?.(clone(event))).catch(() => {}); } catch { /* observer */ } };

  function validateState(input) {
    if (!input || input.schemaVersion !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0 || !Array.isArray(input.workers) || input.workers.length > maxWorkers) throw failure('INVALID_SKILLS_STATE', 'Invalid skills state');
    const seen = new Set();
    const workers = input.workers.map(worker => {
      const id = workerId(worker);
      if (seen.has(id) || !Array.isArray(worker.skills)) throw failure('INVALID_SKILLS_STATE', 'Duplicate worker or invalid skill list');
      seen.add(id);
      const names = new Set();
      let bytes = 0;
      const skills = worker.skills.map(item => {
        const skill = catalog.get(item?.name);
        if (!skill || item.fingerprint !== skill.fingerprint) throw failure('SKILL_SNAPSHOT_MISMATCH', `Loaded skill has changed or is unavailable: ${item?.name}`);
        if (names.has(skill.name)) throw failure('INVALID_SKILLS_STATE', `Duplicate loaded skill: ${skill.name}`);
        names.add(skill.name);
        bytes += Buffer.byteLength(renderSkill(skill));
        return { name: skill.name, fingerprint: skill.fingerprint };
      });
      if (bytes > maxActiveBytes) throw failure('SKILL_LIMIT_EXCEEDED', `Worker ${id} active skills exceed ${maxActiveBytes} bytes`);
      return { workerId: id, skills };
    });
    return { schemaVersion: 1, revision: input.revision, workers };
  }
  state = validateState(options.state ?? { schemaVersion: 1, revision: 0, workers: [] });

  function operation(context, signal, invoke) {
    assertOpen();
    const signals = [lifetime.signal, context?.signal, signal].filter(Boolean);
    const combined = AbortSignal.any(signals);
    let pending;
    pending = Promise.resolve().then(async () => {
      combined.throwIfAborted();
      const result = await invoke(combined);
      combined.throwIfAborted();
      return result;
    }).finally(() => operations.delete(pending));
    operations.add(pending);
    return pending;
  }

  function commit(change, signal) {
    const work = queue.then(async () => {
      signal?.throwIfAborted();
      const candidate = clone(state);
      if (change(candidate) === false) return;
      candidate.revision++;
      const valid = validateState(candidate);
      await options.persist?.(clone(valid));
      // A write that completed while cancellation was requested still committed;
      // publish it before observing cancellation so durable and live state agree.
      state = valid;
    });
    queue = work.catch(() => {});
    return work;
  }

  async function allowed(context, signal) {
    signal?.throwIfAborted();
    let names = options.allowedSkills;
    if (typeof names === 'function') names = await names({ ...context, signal });
    signal?.throwIfAborted();
    if (names === undefined) return new Set(catalog.keys());
    if (!Array.isArray(names)) throw new TypeError('allowedSkills callback must return an array');
    for (const name of names) if (!catalog.has(skillName(name))) throw failure('SKILL_NOT_FOUND', `Unknown allowed skill: ${name}`);
    return new Set(names);
  }

  async function assertAccess(context, name, signal) {
    skillName(name);
    if (!(await allowed(context, signal)).has(name)) throw failure('SKILL_NOT_ALLOWED', `Skill is not allowed for this Worker: ${name}`);
    const skill = catalog.get(name);
    if (!skill) throw failure('SKILL_NOT_FOUND', `Unknown skill: ${name}`);
    return skill;
  }

  function contextProvider(context) {
    return operation(context, undefined, async signal => {
      const id = workerId(context), visible = await allowed(context, signal);
      const entries = [...catalog.values()].filter(skill => visible.has(skill.name));
      if (!entries.length) return '';
      const active = new Set(state.workers.find(worker => worker.workerId === id)?.skills.map(skill => skill.name) ?? []);
      const manifest = entries.map(skill => JSON.stringify({ name: skill.name, description: skill.description, loaded: active.has(skill.name) })).join('\n');
      const loaded = entries.filter(skill => active.has(skill.name)).map(renderSkill);
      return `Available skills (host-configured catalog):\n${manifest}\n\nUse load_skill with a skill name before following it. Read supporting resources with read_skills_resource and run files under scripts/ with run_local_skill_script. Both require a skill loaded by this Worker. Skill scripts run on this controller, not a remote SSH host.${loaded.length ? `\n\nLoaded skill instructions:\n\n${loaded.join('\n\n')}` : ''}`;
    });
  }

  function tools(context) {
    return operation(context, undefined, async signal => {
      const id = workerId(context);
      await allowed(context, signal);
      const registry = {
        names: () => [...catalog.keys()],
        async resolve(name, path) {
          const skill = await assertAccess(context, name, signal);
          if (!state.workers.find(worker => worker.workerId === id)?.skills.some(item => item.name === name)) throw failure('SKILL_NOT_LOADED', `Load skill ${name} before using its resources or scripts`);
          if (typeof path !== 'string' || path.includes(':')) throw failure('INVALID_SKILL_PATH', 'Skill path cannot contain a volume or alternate data stream');
          const located = await new SkillRegistry([skill]).resolve(name, path);
          if (located.directory !== skill.directory) throw failure('INVALID_SKILL_PATH', 'Skill directory changed after discovery');
          if (path.replaceAll('\\', '/') !== 'SKILL.md' && !skill.files.includes(path.replaceAll('\\', '/'))) throw failure('INVALID_SKILL_PATH', 'Resource was not present in the discovered skill package');
          return located;
        }
      };
      const resource = createSkillResourceTool({ ...options.resource, registry });
      resource.description = 'Read a supporting file from a skill already loaded by this Worker. Both skill and relative path are required.';
      resource.parameters = Type.Object({ skill: Type.String(), path: Type.String() }, { additionalProperties: false });
      const resourceExecute = resource.execute;
      resource.execute = (callId, input, toolSignal, onUpdate) => operation(context, toolSignal, combined => {
        requireText(input.skill, 'skill');
        return resourceExecute(callId, input, combined, onUpdate);
      });
      const script = createSkillScriptTool({ ...options.script, registry });
      script.description = 'Run a scripts/ file from a skill already loaded by this Worker. Arguments are passed directly without shell parsing.';
      const scriptExecute = script.execute;
      script.execute = (callId, input, toolSignal, onUpdate) => operation(context, toolSignal, combined => scriptExecute(callId, input, combined, onUpdate));
      const load = {
        name: 'load_skill', label: 'Load skill',
        description: 'Load instructions and supporting-file names for an available skill. Loading activates its resource and script tools only for this Worker.',
        parameters: Type.Object({ name: Type.String() }, { additionalProperties: false }),
        execute(_callId, input, toolSignal) {
          return operation(context, toolSignal, async combined => {
            const skill = await assertAccess(context, input.name, combined);
            await commit(candidate => {
              let worker = candidate.workers.find(worker => worker.workerId === id);
              if (!worker) candidate.workers.push(worker = { workerId: id, skills: [] });
              if (worker.skills.some(item => item.name === skill.name)) return false;
              worker.skills.push({ name: skill.name, fingerprint: skill.fingerprint });
            }, combined);
            emit({ type: 'skill.loaded', workerId: id, name: skill.name, revision: state.revision });
            return textResult(renderSkill(skill), { skill: skill.name, fingerprint: skill.fingerprint, files: [...skill.files] });
          });
        }
      };
      return [load, resource, script];
    });
  }

  return Object.freeze({
    tools, contextProvider, instructionProvider: contextProvider,
    list: () => [...catalog.values()].map(publicSkill),
    exportState: () => clone(state),
    importState(input) {
      const candidate = validateState(input);
      return operation(undefined, undefined, signal => commit(current => {
        current.workers = candidate.workers;
      }, signal));
    },
    flush: () => queue,
    close() {
      if (closing) return closing;
      closed = true;
      closing = Promise.resolve().then(async () => {
        lifetime.abort(failure('SKILLS_CLOSED', 'Skills middleware is closed'));
        await Promise.allSettled([...operations]);
        await queue;
      });
      return closing;
    }
  });
}
