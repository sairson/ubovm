import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Type } from 'typebox';
import { contained, integer, requireText } from '../../shared/common.mjs';
import { flagHelpProperties, withProgressiveDisclosure } from '../../shared/disclosure.mjs';
import { RUN_PYTHON_CATALOG } from '../../shared/tool-catalogs.mjs';
import { resolvePython, normalizePythonDomains } from './policy.mjs';
import { runPythonSandbox } from './execution.mjs';
import { readPythonEnvironment, environmentPython, environmentMatchesBase, validatePythonEnvironmentFiles } from './environment-state.mjs';

export function createPythonTool({ cwd = process.cwd(), executable, allowedDomains = ['*'], allowWorkspaceWrite = false,
  defaultTimeoutSeconds, maxTimeoutSeconds = 600, maxOutputBytes = 1 << 20, useManagedEnvironment = true } = {}) {
  const workspace = resolve(requireText(cwd, 'cwd'));
  maxTimeoutSeconds = integer(maxTimeoutSeconds, 600, 1, 3600, 'maxTimeoutSeconds');
  defaultTimeoutSeconds = integer(defaultTimeoutSeconds, Math.min(120, maxTimeoutSeconds), 1, maxTimeoutSeconds, 'defaultTimeoutSeconds');
  maxOutputBytes = integer(maxOutputBytes, 1 << 20, 1024, 10 << 20, 'maxOutputBytes');
  allowedDomains = Object.freeze(normalizePythonDomains(allowedDomains));
  if (typeof allowWorkspaceWrite !== 'boolean') throw new Error('allowWorkspaceWrite must be boolean');
  return withProgressiveDisclosure({
    name: 'run_python', label: 'Run Python in local sandbox',
    description: RUN_PYTHON_CATALOG.description,
    parameters: Type.Object({
      code: Type.Optional(Type.String({ minLength: 1, maxLength: 262144 })),
      script: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: 'Existing .py file inside this workspace; relative to cwd or absolute.' })),
      arguments: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 })),
      cwd: Type.Optional(Type.String({ maxLength: 4096, description: 'Directory inside this workspace.' })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: maxTimeoutSeconds })),
      ...flagHelpProperties()
    }, { additionalProperties: false }),
    async execute(_id, input, signal, onUpdate) {
      signal?.throwIfAborted();
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['code', 'script', 'arguments', 'cwd', 'reason', 'timeout_seconds'].includes(key))) throw new Error('Invalid Python execution arguments');
      if ((input.code !== undefined) === (input.script !== undefined)) throw new Error('Provide exactly one of code or script');
      const reason = requireText(input.reason, 'reason');
      if (reason.length > 2048) throw new Error('reason exceeds 2048 characters');
      if (input.code !== undefined && (typeof input.code !== 'string' || !input.code.trim() || input.code.includes('\0') || Buffer.byteLength(input.code) > 262144)) throw new Error('code must be nonempty Python source, at most 256 KiB');
      const args = input.arguments ?? [];
      if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 4096) || args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 32768) throw new Error('Python arguments exceed size/count limit or contain NUL');
      // Capture caller-owned data before the first asynchronous boundary.
      const code = input.code, scriptInput = input.script, cwdInput = input.cwd, argumentsSnapshot = [...args];
      const timeout = integer(input.timeout_seconds, defaultTimeoutSeconds, 1, maxTimeoutSeconds, 'timeout_seconds');
      for (const [key, value] of [['script', scriptInput], ['cwd', cwdInput]]) if (value !== undefined && (typeof value !== 'string' || value.length > 4096)) throw new Error(`${key} exceeds path limit`);
      const root = await realpath(workspace);
      const directory = await realpath(cwdInput === undefined ? root : resolve(root, requireText(cwdInput, 'cwd')));
      if (!contained(root, directory) || !(await stat(directory)).isDirectory()) throw new Error('Python cwd must be inside this workspace');
      let script;
      if (scriptInput !== undefined) {
        script = await realpath(resolve(directory, requireText(scriptInput, 'script')));
        if (!contained(root, script) || !/\.py$/i.test(script) || !(await stat(script)).isFile()) throw new Error('Python script must be a .py file inside this workspace');
      }
      let python = await resolvePython(executable, process.env, signal), environmentIdentity;
      if (useManagedEnvironment) {
        const environment = await readPythonEnvironment(root);
        if (environmentMatchesBase(environment, python)) {
          environmentIdentity = await validatePythonEnvironmentFiles(environment.directory);
          python = await resolvePython(environmentPython(environment.directory), process.env, signal);
        }
      }
      signal?.throwIfAborted();
      const outputDirectory = join(root, '.ubovm-python-output', `run-${randomUUID()}`);
      return runPythonSandbox({ workspace: root, cwd: directory, script, code, arguments: argumentsSnapshot, reason,
        outputDirectory, ...python, environmentIdentity, allowedDomains: [...allowedDomains], allowWorkspaceWrite, timeout, maxOutputBytes }, signal, onUpdate);
    }
  }, { ...RUN_PYTHON_CATALOG, mode: 'flag' });
}
