import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningValidationError, validateReflectionCandidates } from '../validation.mjs';
import { MemoryStore } from '../../intools/shared/store/memory-store.mjs';
import { createKnowledge } from '../index.mjs';
import { learningFingerprint, learningRequestFingerprint } from '../fingerprint.mjs';

const candidate = { title: 'Inspect source', trigger: 'Inspect source after recovery', steps: ['Check the path', 'Read source', 'Verify the contents'], tool_call_ids: ['success'], failure_call_ids: ['failure'], portable: true };
const record = (id, isError = false, resource = id) => ({ sessionId: 's', workerId: 'w', toolName: 'read_file',
  status: 'completed', toolCallId: id, attemptId: `attempt-${id}`, isError, digest: id, observations: isError ? 'ENOENT' : 'Read',
  learningFingerprint: learningFingerprint({ toolName: 'read_file', args: { resource }, isError }),
  learningRequestFingerprint: learningRequestFingerprint({ toolName: 'read_file', args: { resource } }) });

test('reflection cannot relabel failure, cite evidence outside its window, or use success before failure', () => {
  const records = [record('failure', true), record('success')];
  assert.deepEqual(validateReflectionCandidates([candidate], records), [candidate]);
  for (const value of [
    { ...candidate, tool_call_ids: ['failure'] },
    { ...candidate, tool_call_ids: ['outside-window'] },
    { ...candidate, failure_call_ids: ['success'] },
    { ...candidate, portable: 'true' },
    { ...candidate, action: 'publish' },
    { ...candidate, tool_call_ids: [] }
  ]) assert.throws(() => validateReflectionCandidates([value], records), LearningValidationError);
  assert.throws(() => validateReflectionCandidates([candidate], [...records].reverse()), /subsequent recovery/);
  assert.throws(() => validateReflectionCandidates([candidate], [{ ...records[0], workerId: 'foreign' }, records[1]]), /subsequent recovery/);
});

test('success for another request does not clear repeated failures or authorize blind retry', async () => {
  const store = new MemoryStore({ sessionId: 's' });
  await store.commit(state => { state.toolEvidence = [record('failure1', true, 'missing'), record('failure2', true, 'missing'), record('unrelated', false, 'other')]; });
  const knowledge = createKnowledge({ store });
  let capability = knowledge.inspect().capabilities[0];
  assert.equal(capability.lastFailed, false);
  assert.equal(capability.unresolvedFailureRequests, 1);
  assert.equal(capability.failurePattern.count, 2);
  assert.equal(capability.attribution, 'env_prereq');
  assert.match(capability.retryAdvice, /confirm the path exists/);
  assert.equal(capability.needsPractice, true);
  assert.equal(knowledge.inspect().warnings[0].status, 'prerequisite');
  assert.equal(knowledge.inspect().warnings[0].familyFailures, 0);
  await store.commit(state => { state.toolEvidence.push({ ...record('foreign-success', false, 'missing'), workerId: 'other' }); });
  assert.equal(knowledge.inspect().capabilities[0].unresolvedFailureRequests, 1);
  assert.match(knowledge.inspect().warnings[0].reason, /not a tool defect/);
  const tight = await createKnowledge({ store, maxContextChars: 900 }).context();
  assert.match(tight, /not a tool defect/);
  await store.commit(state => { state.toolEvidence.push(record('recovery', false, 'missing')); });
  capability = knowledge.inspect().capabilities[0];
  assert.equal(capability.unresolvedFailureRequests, 0);
  assert.equal(capability.retryAdvice, 'none');
});
