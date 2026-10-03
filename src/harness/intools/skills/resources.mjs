import { open, realpath, stat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { Type } from 'typebox';
import { contained, expandHome, requireText, integer, textResult, jsonResult } from '../shared/common.mjs';
import { flagHelpProperties, withProgressiveDisclosure } from '../shared/disclosure.mjs';
import { SKILL_RESOURCE_CATALOG } from '../shared/tool-catalogs.mjs';

/** The host supplies only skills loaded for this worker, never model-selected roots. */
export class SkillRegistry {
  constructor(skills = []) {
    this.skills = new Map();
    for (const skill of skills) {
      const name = requireText(skill.name, 'skill.name');
      if (this.skills.has(name)) throw new Error(`Duplicate skill: ${name}`);
      this.skills.set(name, Object.freeze({ name, directory: resolve(expandHome(requireText(skill.directory, 'skill.directory'))) }));
    }
  }
  names() { return [...this.skills.keys()].sort(); }
  async resolve(skill, path) {
    const entry = this.skills.get(requireText(skill, 'skill'));
    if (!entry) throw new Error(`Skill is not loaded or allowed: ${skill}`);
    path = requireText(path, 'path');
    if (isAbsolute(path) || /^[a-z]:/i.test(path)) throw new Error('Skill resource path must be relative');
    const root = await realpath(entry.directory);
    const candidate = resolve(root, path);
    if (!contained(root, candidate)) throw new Error('Path escapes the skill directory');
    const actual = await realpath(candidate);
    if (!contained(root, actual)) throw new Error('Symlink escapes the skill directory');
    return { path: actual, directory: root };
  }
}

export function createSkillResourceTool({ skills = [], registry = new SkillRegistry(skills), cwd = process.cwd(), maxBytes = 1 << 20 } = {}) {
  maxBytes = integer(maxBytes, 1 << 20, 1, 100 << 20, 'maxBytes');
  return withProgressiveDisclosure({
    name: 'read_skills_resource', label: 'Read skill resource',
    description: SKILL_RESOURCE_CATALOG.description,
    parameters: Type.Object({
      skill: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      ...flagHelpProperties()
    }, { additionalProperties: false }),
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const requested = requireText(input.path, 'path');
      let path = input.skill ? requested : resolve(cwd, expandHome(requested));
      try {
        if (input.skill) path = (await registry.resolve(input.skill, requested)).path;
        else path = await realpath(path);
        if (!(await stat(path)).isFile()) return jsonResult({ status: 'not_a_file', path, message: 'Path is not a regular file' });
        const file = await open(path, 'r');
        try {
          const info = await file.stat();
          if (!info.isFile()) return jsonResult({ status: 'not_a_file', path, message: 'Path is not a regular file' });
          if (info.size > maxBytes) throw new Error(`Resource exceeds ${maxBytes} bytes`);
          // Allocate for the actual resource, not the host's maximum. Grow only
          // if a file changes while being read, retaining the extra limit byte.
          let buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
          let size = 0;
          while (size <= maxBytes) {
            signal?.throwIfAborted();
            if (size === buffer.length) {
              const larger = Buffer.alloc(Math.min(maxBytes + 1, Math.max(buffer.length * 2, 4096)));
              buffer.copy(larger, 0, 0, size);
              buffer = larger;
            }
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
          }
          signal?.throwIfAborted();
          if (size > maxBytes) throw new Error(`Resource exceeds ${maxBytes} bytes`);
          const bytes = buffer.subarray(0, size);
          let text;
          try { if (!bytes.includes(0)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* binary */ }
          return text === undefined ? jsonResult({ status: 'ok', path, encoding: 'base64', content: bytes.toString('base64') }) : textResult(text, { path, encoding: 'utf-8' });
        } finally { await file.close(); }
      } catch (error) {
        if (error.code === 'ENOENT') return jsonResult({ status: 'not_found', path, message: 'File was not found' });
        throw error;
      }
    }
  }, { ...SKILL_RESOURCE_CATALOG, mode: 'flag' });
}
