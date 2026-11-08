import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCompletionSurface, renderSurfaceSummary, selectScopeNote } from '../surface-gate.mjs';

const inventory = {
  seedRoots: ['example.com'],
  revision: 7,
  domains: [
    { hostname: 'example.com', test_status: 'tested' },
    { hostname: 'api.example.com', test_status: 'pending' },
    { hostname: 'cdn.example.com', test_status: 'in_progress' }
  ]
};
const notes = [
  { note_type: 'scope', scope: { targets: ['example.com', '*.example.com'], out_of_scope: ['third.example.net'], rules: 'no DoS; business hours', authorization: 'sow-2026-11' } }
];

test('surface summary shows seed, coverage counts, untested hosts and scope', () => {
  const summary = renderSurfaceSummary({ inventory, notes });
  assert.match(summary.text, /^# Attack surface \(domain ledger, navigation only\)/);
  assert.match(summary.text, /seed=example.com hosts=3 tested=1 pending=1 in_progress=1/);
  assert.match(summary.text, /coverage=33% complete=false revision=7/);
  assert.match(summary.text, /incomplete: api\.example\.com, cdn\.example\.com/);
  assert.match(summary.text, /# Authorization scope/);
  assert.match(summary.text, /in: example\.com, \*\.example\.com/);
  assert.match(summary.text, /out: third\.example\.net/);
  assert.match(summary.text, /authorization: sow-2026-11/);
  assert.equal(summary.fingerprint.includes('7'), true);
});

test('an empty ledger renders unknown coverage instead of throwing', () => {
  const summary = renderSurfaceSummary({ inventory: undefined, notes: [] });
  assert.match(summary.text, /seed=none hosts=0 coverage=unknown complete=false/);
  assert.doesNotMatch(summary.text, /Authorization scope/);
});

test('scope selection uses the latest recorded note', () => {
  const picked = selectScopeNote([{ note_type: 'note' }, { note_type: 'scope', scope: { targets: ['old'] } }, { note_type: 'scope', scope: { targets: ['new'] } }]);
  assert.deepEqual(picked.scope.targets, ['new']);
});

test('completion gate is off/non-security aware and warns when the ledger is missing', () => {
  assert.equal(evaluateCompletionSurface({ mode: 'off', goal: 'penetration test', inventory }).status, 'not_applicable');
  assert.equal(evaluateCompletionSurface({ mode: 'enforce', goal: 'build a landing page', inventory }).status, 'not_applicable');
  const missing = evaluateCompletionSurface({ mode: 'enforce', goal: 'penetration test example.com', inventory: undefined });
  assert.equal(missing.status, 'warn');
  assert.equal(missing.code, 'SURFACE_LEDGER_MISSING');
});

test('incomplete coverage blocks only in enforce mode and reports actionable hosts', () => {
  const warn = evaluateCompletionSurface({ mode: 'warn', goal: 'penetration test example.com', inventory });
  assert.equal(warn.status, 'warn');
  assert.equal(warn.code, 'COVERAGE_INCOMPLETE');
  assert.equal(warn.diagnostics.total, 3);
  const blocked = evaluateCompletionSurface({ mode: 'enforce', goal: 'penetration test example.com', inventory });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.message, /2 of 3 hosts are untested/);
  assert.match(blocked.message, /api\.example\.com/);
  assert.match(blocked.message, /do not claim completion/);
});

test('complete coverage passes and invalid modes are rejected', () => {
  const complete = { ...inventory, domains: inventory.domains.map(item => ({ ...item, test_status: 'tested' })) };
  const result = evaluateCompletionSurface({ mode: 'enforce', goal: 'penetration test example.com', inventory: complete });
  assert.equal(result.status, 'ok');
  assert.equal(result.code, 'COVERAGE_COMPLETE');
  assert.throws(() => evaluateCompletionSurface({ mode: 'strict', goal: 'penetration test', inventory }), /off, warn or enforce/);
});
