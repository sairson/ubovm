import { runLocalProcess } from '../shared/process/local-process.mjs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { Type } from 'typebox';
import { SkillRegistry } from './resources.mjs';
import { contained, requireText, integer } from '../shared/common.mjs';
import { flagHelpProperties, withProgressiveDisclosure } from '../shared/disclosure.mjs';
import { SKILL_SCRIPT_CATALOG } from '../shared/tool-catalogs.mjs';
import { resolvePython } from '../terminals/python/policy.mjs';

export function localSkillInterpreter(path) {
  switch (extname(path).toLowerCase()) {
    case '.js': case '.mjs': case '.cjs': return [process.execPath, []];
    case '.py': return [process.platform === 'win32' ? 'python' : 'python3', []];
    case '.sh': return ['bash', []];
    case '.ps1': return [process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', ...(process.platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : []), '-File']];
    default: throw new Error('Only .py, .ps1, .sh, .js, .mjs and .cjs skill scripts are supported');
  }
}
export async function resolveSkillInterpreter(path, signal) {
  if (extname(path).toLowerCase() === '.py') {
    const python = await resolvePython(undefined, process.env, signal);
    return [python.executable, []];
  }
  return localSkillInterpreter(path);
}
function environment(directory) {
  const allowed = new Set(['COMSPEC', 'LANG', 'LC_ALL', 'PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase()))), CARIN_SKILL_DIR: directory, UBOVM_SKILL_DIR: directory, PYTHONNOUSERSITE: '1' };
}

export function createSkillScriptTool({ skills = [], registry = new SkillRegistry(skills), defaultTimeoutSeconds, maxTimeoutSeconds = 600, maxOutputBytes = 10 << 20 } = {}) {
  maxTimeoutSeconds = integer(maxTimeoutSeconds, 600, 1, 600, 'maxTimeoutSeconds');
  defaultTimeoutSeconds = integer(defaultTimeoutSeconds, Math.min(120, maxTimeoutSeconds), 1, maxTimeoutSeconds, 'defaultTimeoutSeconds');
  maxOutputBytes = integer(maxOutputBytes, 10 << 20, 1, 100 << 20, 'maxOutputBytes');
  return withProgressiveDisclosure({
    name: 'run_local_skill_script', label: 'Run loaded skill script',
    description: `${SKILL_SCRIPT_CATALOG.description} Loaded skills: ${registry.names().join(', ') || '(none)'}.`,
    parameters: Type.Object({
      skill: Type.Optional(Type.String()),
      script: Type.Optional(Type.String()),
      arguments: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: maxTimeoutSeconds })),
      ...flagHelpProperties()
    }, { additionalProperties: false }),
    async execute(_id, input, signal, onUpdate) {
      signal?.throwIfAborted();
      const script = requireText(input.script, 'script');
      if (!/^scripts[/\\]/.test(script)) throw new Error('Script must start with scripts/');
      const located = await registry.resolve(input.skill, script);
      const scriptRoot = resolve(located.directory, 'scripts');
      const realScriptRoot = await realpath(scriptRoot);
      if (!contained(scriptRoot, located.path) || !contained(realScriptRoot, located.path) || !(await stat(located.path)).isFile()) throw new Error('Script must be a regular file inside the skill scripts/ directory');
      const args = input.arguments ?? [];
      if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 4096) || args.reduce((n, arg) => n + Buffer.byteLength(arg), 0) > 32768) throw new Error('Arguments exceed allowed count/size or contain NUL');
      const timeout = integer(input.timeout_seconds, defaultTimeoutSeconds, 1, maxTimeoutSeconds, 'timeout_seconds');
      const [executable, prefix] = await resolveSkillInterpreter(located.path, signal);
      signal?.throwIfAborted();
      return runLocalProcess({ executable, args: [...prefix, located.path, ...args], cwd: located.directory, env: environment(located.directory), timeout, maxOutputBytes, label: 'Skill script', details: { script: located.path } }, signal, onUpdate);
    }
  }, { ...SKILL_SCRIPT_CATALOG, mode: 'flag' });
}
