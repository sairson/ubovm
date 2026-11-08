import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSkillsMiddleware } from '../skills.mjs';

const skill = name => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n\nInstructions.\n`;

test('skills middleware discovers flat Markdown skills and loads them', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ubovm-skills-flat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'flat.md'), skill('flat'));
  const skills = await createSkillsMiddleware({ directories: [root] });
  t.after(() => skills.close());
  assert.deepEqual(skills.list().map(item => item.name), ['flat']);
  const context = await skills.contextProvider({ node: { id: 'flat-worker' } });
  assert.match(context, /Load a skill proactively before the first action it governs/);
  assert.match(context, /do not wait for the user to name the skill/);
  const [load] = await skills.tools({ node: { id: 'flat-worker' } });
  const result = await load.execute('call', { name: 'flat' }, undefined);
  assert.match(result.content[0].text, /Instructions\./);
});
