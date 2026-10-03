import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Type } from 'typebox';
import { createPythonTool } from './index.mjs';
import { resolvePython, normalizePythonDomains, pythonAllowsHost } from './policy.mjs';
import { acquireEnvironmentLease, environmentPython, environmentMatchesBase, publishPythonEnvironment, readPythonEnvironment, validatePythonEnvironmentFiles } from './environment-state.mjs';
import { integer, requireText, textResult } from '../../shared/common.mjs';
import { withActionHelp, withProgressiveDisclosure } from '../../shared/disclosure.mjs';
import { PYTHON_ENV_CATALOG } from '../../shared/tool-catalogs.mjs';

export function validatePythonPackages(packages) {
  if (!Array.isArray(packages) || packages.length > 100) throw new Error('packages must contain at most 100 package requirements');
  const name = '[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?';
  const requirement = new RegExp(`^${name}(?:\\[${name}(?:,${name})*\\])?(?:(?:===|==|~=|!=|<=|>=|<|>)[a-zA-Z0-9.*+!_-]+(?:,(?:===|==|~=|!=|<=|>=|<|>)[a-zA-Z0-9.*+!_-]+)*)?$`);
  return [...new Set(packages.map(value => {
    if (typeof value !== 'string' || value.length > 256 || value.trim() !== value || !requirement.test(value))
      throw new Error('Use package names with optional extras/version constraints; URLs, paths, flags and requirement files are not accepted');
    return value;
  }))];
}

export function pythonEnvironmentScript(packages, manager) {
  const encoded = Buffer.from(JSON.stringify({ packages, manager })).toString('base64');
  return `import base64,json,os,sys,subprocess,venv
config=json.loads(base64.b64decode('${encoded}'))
root=os.environ['UBOVM_PYTHON_OUTPUT']
target=os.path.join(root,'environment')
print('Creating isolated Python environment',flush=True)
venv.EnvBuilder(with_pip=True,symlinks=False).create(target)
python=os.path.join(target,'Scripts','python.exe') if os.name=='nt' else os.path.join(target,'bin','python')
env=os.environ.copy()
for key in list(env):
 if key.upper().startswith(('PIP_','UV_','PYTHON')): env.pop(key,None)
env.update(PIP_CONFIG_FILE=os.devnull,UV_NO_CONFIG='1',UV_PYTHON_DOWNLOADS='never',UV_NO_MANAGED_PYTHON='1',UV_CACHE_DIR=os.path.join(root,'uv-cache'))
def run(args):
 print('Running '+args[0]+' '+ ' '.join(args[1:]),flush=True)
 subprocess.run(args,check=True,env=env)
pip=[python,'-I','-B','-m','pip','--isolated','--disable-pip-version-check','--require-virtualenv']
install=['install','--no-input','--no-cache-dir','--only-binary=:all:','--index-url','https://pypi.org/simple','--timeout','30','--retries','1']
if config['manager']=='uv':
 run(pip+install+['uv'])
 if config['packages']: run([python,'-I','-B','-m','uv','--no-config','pip','install','--python',python,'--only-binary',':all:','--index-url','https://pypi.org/simple']+config['packages'])
elif config['packages']: run(pip+install+config['packages'])
run(pip+['check'])
run(pip+['list','--format=json'])
print('Python environment ready',flush=True)
`;
}

export function createPythonEnvironmentTool(options = {}) {
  const workspace = resolve(options.cwd ?? process.cwd());
  const domains = normalizePythonDomains(options.allowedDomains);
  const maxTimeout = integer(options.maxTimeoutSeconds, 600, 1, 3600, 'maxTimeoutSeconds');
  const baseTool = createPythonTool({ ...options, allowWorkspaceWrite: false, useManagedEnvironment: false });
  const activeTool = createPythonTool({ ...options, allowWorkspaceWrite: false });
  return withProgressiveDisclosure({
    name: 'manage_python_environment', label: 'Manage sandbox Python dependencies',
    description: PYTHON_ENV_CATALOG.description,
    parameters: Type.Object(withActionHelp({
      packages: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 100 })),
      manager: Type.Optional(Type.Union([Type.Literal('pip'), Type.Literal('uv')])),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: maxTimeout }))
    }), { additionalProperties: false }),
    async execute(id, input, signal, onUpdate) {
      signal?.throwIfAborted();
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['action', 'packages', 'manager', 'reason', 'timeout_seconds'].includes(key))
        || !['status', 'list', 'check', 'sync', 'reset'].includes(input.action)) throw new Error('Invalid Python environment action');
      const reason = requireText(input.reason, 'reason'); if (reason.length > 2048) throw new Error('reason exceeds 2048 characters');
      const action = input.action, manager = input.manager ?? 'pip';
      if (!['pip', 'uv'].includes(manager)) throw new Error('Unknown Python package manager');
      if (action !== 'sync' && (input.packages !== undefined || input.manager !== undefined)) throw new Error('packages and manager are only accepted for sync');
      if (action === 'sync' && input.packages === undefined) throw new Error('sync requires the full packages array (empty creates a clean environment)');
      const packages = action === 'sync' ? validatePythonPackages(input.packages) : [];
      if (action === 'sync' && (packages.length || manager === 'uv')) {
        if (!['pypi.org', 'files.pythonhosted.org'].every(host => pythonAllowsHost(domains, host, 443))) throw Object.assign(new Error(
          'Package downloads require pypi.org and files.pythonhosted.org in the host Python allowedDomains setting (or *). No environment was changed.'),
        { code: 'PYTHON_PACKAGE_NETWORK_REQUIRED' });
      }
      const timeout = integer(input.timeout_seconds, Math.min(600, maxTimeout), 1, maxTimeout, 'timeout_seconds');
      const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout * 1000)]);
      const root = await realpath(workspace); combined.throwIfAborted();
      if (action === 'status') {
        const base = await resolvePython(options.executable, process.env, combined);
        let state;
        try { state = await readPythonEnvironment(root); }
        catch (error) {
          combined.throwIfAborted();
          return textResult(JSON.stringify({ active: false, available: false, base_python: base.executable,
            error_code: error.code ?? 'PYTHON_ENVIRONMENT_INVALID', error: error.message, recovery: ['sync', 'reset'] }, null, 2));
        }
        return textResult(JSON.stringify({ environment: state, active: environmentMatchesBase(state, base),
          available: true, base_python: base.executable, python: environmentMatchesBase(state, base) ? environmentPython(state.directory) : base.executable }, null, 2));
      }
      if (action === 'list' || action === 'check') return activeTool.execute(id, { reason, timeout_seconds: timeout,
        code: action === 'list' ? "import importlib.metadata,json;print(json.dumps(sorted([{'name':d.metadata['Name'],'version':d.version} for d in importlib.metadata.distributions()],key=lambda d:d['name'].lower()),ensure_ascii=False))"
          : "import subprocess,sys;subprocess.run([sys.executable,'-I','-B','-m','pip','--isolated','--disable-pip-version-check','check'],check=True)" }, combined, onUpdate);
      const release = await acquireEnvironmentLease(root, combined);
      try {
        combined.throwIfAborted();
        if (action === 'reset') {
          await publishPythonEnvironment(root, null, combined);
          return textResult('Managed environment deactivated. Existing files retained; run_python uses the configured/bundled interpreter.');
        }
        const base = await resolvePython(options.executable, process.env, combined);
        const result = await baseTool.execute(id, { reason, timeout_seconds: timeout, code: pythonEnvironmentScript(packages, manager) }, combined, onUpdate);
        combined.throwIfAborted();
        if (result.details.cleanup_confirmed !== true) throw new Error('Environment cleanup was not confirmed; previous environment remains active');
        const directory = await realpath(join(result.details.output_directory, 'environment'));
        await validatePythonEnvironmentFiles(directory);
        await resolvePython(environmentPython(directory), process.env, combined);
        combined.throwIfAborted();
        await publishPythonEnvironment(root, { version: 1, directory, baseExecutable: base.executable, baseTarget: base.executableTarget, manager, packages, createdAt: new Date().toISOString() }, combined);
        return textResult(result.content[0].text + '\nEnvironment activated for run_python.', { ...result.details, environment: directory, manager, packages });
      } finally { await release(); }
    }
  }, PYTHON_ENV_CATALOG);
}
