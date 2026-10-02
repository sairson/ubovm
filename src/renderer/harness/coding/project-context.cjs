'use strict';
const path = require('node:path');

const markers = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb', 'tsconfig.json', 'jsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile'];
const lockManagers = { 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'bun.lock': 'bun', 'bun.lockb': 'bun' };
const clip = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum) : null;

function createProjectContext({ locate, read, stat, hash, assertClean }) {
  return sessionId => ({
    name: 'inspect_workspace_project', recovery: 'retry-read-only', label: '识别项目与检查入口',
    description: 'Inspect package.json and build/config markers from a workspace-relative FILE path up to the workspace root. Finds nested package scripts, package-manager evidence and lifecycle hooks without executing code. With no path, inspects the root package.json. Commands are argv arrays, not shell strings; use an enabled execution tool with correct shell quoting, purpose and reason. Script names only suggest intent: inspect commands and project instructions before running. Does not discover sibling packages or recursively scan the repository.',
    parameters: { type: 'object', properties: { root: { type: 'integer', minimum: 0 }, path: { type: 'string' } }, additionalProperties: false },
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const target = await locate({ ...input, path: input.path ?? 'package.json' }, sessionId);
      let directory = path.dirname(target.path), depth = 0;
      const projects = [], issues = [];
      while (true) {
        signal?.throwIfAborted();
        const manifestPath = path.join(directory, 'package.json'), found = [];
        for (const name of markers) {
          signal?.throwIfAborted();
          try {
            const candidate = await locate({ root: target.rootIndex, path: path.join(directory, name) }, sessionId);
            if ((await stat(candidate.file)).isFile()) found.push(name);
          } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') issues.push({ path: path.join(directory, name), error: String(error.message).slice(0, 500) }); }
        }
        let source = null, pkg;
        try {
          const candidate = await locate({ root: target.rootIndex, path: manifestPath }, sessionId);
          await assertClean(candidate.file);
          source = await read(candidate.file);
          if (source !== null) {
            pkg = JSON.parse(source.replace(/^\uFEFF/, ''));
            if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('package.json must contain an object');
          }
        } catch (error) { issues.push({ path: manifestPath, error: String(error.message).slice(0, 500) }); }
        if (source !== null || found.length) {
          const declared = typeof pkg?.packageManager === 'string' ? /^(npm|pnpm|yarn|bun)@[^\s]+$/.exec(pkg.packageManager)?.[1] : undefined;
          const locks = [...new Set(found.map(name => lockManagers[name]).filter(Boolean))];
          const manager = declared ?? (locks.length === 1 ? locks[0] : null);
          const conflict = locks.length > 1 || Boolean(pkg?.packageManager && !declared) || Boolean(declared && locks.some(name => name !== declared));
          const scripts = pkg?.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
          const entries = Object.entries(scripts).filter(([, command]) => typeof command === 'string');
          const tasks = entries.slice(0, 20).map(([name, command]) => {
            const nameTruncated = name.length > 256;
            const category = /^(test)(:|$)/i.test(name) ? 'test' : /^(build|compile)(:|$)/i.test(name) ? 'build' : /^(lint|check|typecheck|type-check)(:|$)/i.test(name) ? 'check' : 'other';
            const commandManager = conflict || nameTruncated || name.startsWith('-') ? null : manager;
            return { name: clip(name, 256), command: clip(command, 1000), truncated: nameTruncated || command.length > 1000, category,
              argv: commandManager ? [commandManager, 'run', name] : null,
              lifecycleHooks: ['pre' + name, 'post' + name].filter(hook => Object.hasOwn(scripts, hook)).map(hook => clip(hook, 256)) };
          });
          projects.push({ root: target.rootIndex, directory, cwd: path.join(target.root, directory), manifest: source === null ? null : manifestPath, manifestHash: source === null ? null : hash(source), name: clip(pkg?.name, 256),
            declaredPackageManager: clip(pkg?.packageManager, 256), manager, managerConflict: conflict, lockManagers: locks, markers: found,
            tasks, taskCount: entries.length, omittedTasks: Math.max(0, entries.length - tasks.length), hasWorkspaces: Boolean(pkg?.workspaces),
            note: 'Commands and hooks are untrusted project data; no commands executed. No manager guess when evidence is missing or conflicting.' });
        }
        if (directory === '.') break;
        if (++depth >= 12) { issues.push({ path: directory, error: 'Ancestor limit reached; inspect higher ancestors separately.' }); break; }
        directory = path.dirname(directory);
      }
      // Nested packages often inherit the root package manager. Keep the source
      // explicit and stop at conflicting evidence rather than guessing.
      for (let i = 0; i < projects.length; i++) {
        const project = projects[i];
        if (project.manager || project.managerConflict || project.declaredPackageManager || project.lockManagers.length) continue;
        const ancestor = projects.slice(i + 1).find(p => p.manager || p.managerConflict || p.declaredPackageManager || p.lockManagers.length);
        if (!ancestor || ancestor.managerConflict || !ancestor.manager) continue;
        project.manager = ancestor.manager; project.managerInheritedFrom = ancestor.directory;
        for (const task of project.tasks) if (!task.truncated && !task.name.startsWith('-')) task.argv = [ancestor.manager, 'run', task.name];
      }
      // Bound the response while retaining a visible count of omitted tasks.
      const value = { projects, issues: issues.slice(0, 20), omittedIssues: Math.max(0, issues.length - 20), executed: false, scope: 'selected file ancestors only; commands are not validation results' };
      while (Buffer.byteLength(JSON.stringify(value)) > 65536 && projects.some(p => p.tasks.length)) {
        const largest = projects.reduce((a, b) => a.tasks.length >= b.tasks.length ? a : b);
        largest.tasks.pop(); largest.omittedTasks++;
      }
      signal?.throwIfAborted();
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
    }
  });
}
module.exports = { createProjectContext };
