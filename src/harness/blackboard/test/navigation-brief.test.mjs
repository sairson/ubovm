import test from 'node:test';
import assert from 'node:assert/strict';
import { collectHints, renderNavigationBrief } from '../navigation-brief.mjs';

function snapshotWithHints() {
  return {
    schemaVersion: 1, sessionId: 'brief', goal: 'g', revision: 9, rootId: 'root',
    nodes: [
      { id: 'root', kind: 'root', parentIds: [], intent: null, attempts: [], fact: { content: 'g' } },
      { id: 'i1', kind: 'intent', parentIds: ['root'], intent: { description: 'queued high', hint: 'focus tenant B', keyPoints: ['k'], priority: 'high', status: 'pending' }, attempts: [], fact: null },
      { id: 'i2', kind: 'intent', parentIds: ['root'], intent: { description: 'running low', hint: 'ignore tenant A', keyPoints: ['k'], priority: 'low', status: 'running' }, attempts: [], fact: null },
      { id: 'i3', kind: 'intent', parentIds: ['root'], intent: { description: 'done', hint: 'stale', keyPoints: ['k'], priority: 'high', status: 'completed' }, attempts: [], fact: null },
      { id: 'i4', kind: 'intent', parentIds: ['root'], intent: { description: 'no hint', keyPoints: ['k'], priority: 'medium', status: 'pending' }, attempts: [], fact: null }
    ]
  };
}

const exploration = {
  findings: [{ ref: 'n3', completionEligible: true }, { ref: 'n4', completionEligible: false }],
  gaps: [{ ref: 'n3', unresolvedKeyPoints: ['Verify authz'], nextSteps: ['control with user B'], followUpRefs: ['n4'] }],
  frontier: [
    { sourceRef: 'n3', status: 'review_results', activeRefs: [], resultRefs: ['n4'], failedRefs: [] },
    { sourceRef: 'n5', status: 'needs_replan', activeRefs: [], resultRefs: [], failedRefs: ['n6'] }
  ],
  activeIntents: ['n4'], failedIntents: ['n6']
};

test('collectHints keeps human directions for open work only, in priority order', () => {
  const hints = collectHints(snapshotWithHints());
  assert.equal(hints.length, 2);
  assert.equal(hints[0].ref, 'n2');
  assert.match(hints[0].hint, /tenant B/);
  assert.equal(hints[1].ref, 'n3');
  assert(!hints.some(hint => hint.hint === 'stale'), 'completed intents drop stale hints');
});

test('the brief renders frontier lifecycle, gaps, hints and finding counts', () => {
  const snapshot = snapshotWithHints();
  const brief = renderNavigationBrief({ snapshot, exploration, hints: collectHints(snapshot), budgetChars: 1600 });
  assert.match(brief.text, /^# Navigation brief \(navigation only, not evidence\) revision=9/);
  assert.match(brief.text, /\[review_results\] n3 → n4/);
  assert.match(brief.text, /\[needs_replan\] n5 → n6/);
  assert.match(brief.text, /Verify authz/);
  assert.match(brief.text, /focus tenant B/);
  assert.match(brief.text, /findings: 2 completed, 1 completion-eligible/);
  assert.match(brief.text, /navigation only, never evidence/);
  assert.equal(brief.stats.truncated, false);
  assert.ok(brief.text.length <= 1600);
});

test('the brief is deterministic and degrades to a frontier-only view under a tight budget', () => {
  const args = { snapshot: snapshotWithHints(), exploration, hints: collectHints(snapshotWithHints()), budgetChars: 260 };
  const first = renderNavigationBrief(args);
  const second = renderNavigationBrief(args);
  assert.equal(first.text, second.text);
  assert.ok(first.text.length <= 260, `brief is ${first.text.length} chars`);
  assert.equal(first.stats.truncated, true);
  assert.match(first.text, /n3/);
  assert.match(first.text, /review_results/);
});

test('an empty board still produces a deterministic brief rather than an empty section', () => {
  const snapshot = { schemaVersion: 1, sessionId: 'empty', goal: 'g', revision: 1, rootId: 'root', nodes: [
    { id: 'root', kind: 'root', parentIds: [], intent: null, attempts: [], fact: { content: 'g' } }
  ] };
  const brief = renderNavigationBrief({ snapshot, exploration: { findings: [], gaps: [], frontier: [], activeIntents: [], failedIntents: [] }, hints: [], budgetChars: 800 });
  assert.match(brief.text, /frontier: none/);
  assert.match(brief.text, /gaps: none/);
  assert.match(brief.text, /hints: none/);
  assert.match(brief.text, /findings: 0 completed, 0 completion-eligible/);
});

test('the domain ledger summary is injected and survives a moderate budget', () => {
  const snapshot = snapshotWithHints();
  const surface = {
    text: [
      '# Attack surface (domain ledger, navigation only)',
      'seed=example.com hosts=3 tested=1 pending=1 in_progress=1 coverage=33% complete=false revision=7',
      'incomplete: api.example.com, cdn.example.com',
      '# Authorization scope (note ledger, navigation only)',
      'in: example.com, *.example.com',
      'out: third.example.net'
    ].join('\n')
  };
  const brief = renderNavigationBrief({ snapshot, exploration, hints: collectHints(snapshot), surface, budgetChars: 1600 });
  assert.match(brief.text, /# Attack surface/);
  assert.match(brief.text, /hosts=3 tested=1 pending=1/);
  assert.match(brief.text, /out: third\.example\.net/);
  const compact = renderNavigationBrief({ snapshot, exploration, hints: collectHints(snapshot), surface, budgetChars: 420 });
  assert.match(compact.text, /hosts=3/);
  assert.equal(compact.stats.truncated, true);
});
