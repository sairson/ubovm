/**
 * Domain ledger <-> exploration association.
 *
 * The domain inventory is the coverage authority for security engagements, but
 * it lives in the session memory store while Reason only reads the blackboard
 * graph. This module projects the ledger into two read-only surfaces:
 *
 * - `renderSurfaceSummary` feeds the Navigation brief so the planner sees seed
 *   scope, coverage counts, untested hosts and the authorized scope.
 * - `evaluateCompletionSurface` is the host-side coverage gate consulted before
 *   a completion decision is accepted (off / warn / enforce).
 *
 * Both functions are pure projections: they never mutate the ledger and never
 * turn ledger text into evidence.
 */
import { coverageSummary } from '../intools/domain-inventory/record.mjs';
import { isSecurityTask } from '../security-policy.mjs';

const MODES = new Set(['off', 'warn', 'enforce']);
const clip = (value, max) => {
  const text = String(value ?? '').trim().replace(/\s+/gu, ' ');
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
};
const stringList = (value, max = 8) => Array.isArray(value)
  ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, max)
  : [];

/** Last recorded authorization scope note, if any. */
export function selectScopeNote(notes = []) {
  if (!Array.isArray(notes)) return undefined;
  for (let index = notes.length - 1; index >= 0; index--) {
    const note = notes[index];
    if (note?.note_type === 'scope' && note.scope && typeof note.scope === 'object') return note;
  }
  return undefined;
}

/** Read-only planner view of the attack surface and authorization scope. */
export function renderSurfaceSummary({ inventory, notes = [] } = {}) {
  const coverage = coverageSummary(inventory);
  const seeds = Array.isArray(inventory?.seedRoots) ? inventory.seedRoots : [];
  const lines = ['# Attack surface (domain ledger, navigation only)'];
  if (!seeds.length) {
    lines.push('seed=none hosts=0 coverage=unknown complete=false');
  } else {
    lines.push(`seed=${clip(seeds.slice(0, 4).join(','), 120)}${seeds.length > 4 ? ` (+${seeds.length - 4})` : ''} hosts=${coverage.total} tested=${coverage.counts.tested} pending=${coverage.counts.pending} in_progress=${coverage.counts.in_progress} skipped=${coverage.counts.skipped} out_of_scope=${coverage.counts.out_of_scope} coverage=${Math.round(coverage.coverageRate * 100)}% complete=${coverage.complete} revision=${Number.isSafeInteger(inventory?.revision) ? inventory.revision : 0}`);
  }
  if (coverage.incomplete?.length) {
    lines.push(`incomplete: ${coverage.incomplete.slice(0, 8).join(', ')}${coverage.incomplete.length > 8 ? ` (+${coverage.incomplete.length - 8} more)` : ''}`);
  }
  const scope = selectScopeNote(notes);
  if (scope) {
    lines.push('# Authorization scope (note ledger, navigation only)');
    const targets = stringList(scope.scope.targets);
    const out = stringList(scope.scope.out_of_scope);
    if (targets.length) lines.push(`in: ${targets.join(', ')}`);
    if (out.length) lines.push(`out: ${out.join(', ')}`);
    if (scope.scope.authorization) lines.push(`authorization: ${clip(scope.scope.authorization, 200)}`);
    if (scope.scope.rules) lines.push(`rules: ${clip(scope.scope.rules, 240)}`);
  }
  const text = lines.join('\n');
  return {
    text,
    stats: { ...coverage, revision: Number.isSafeInteger(inventory?.revision) ? inventory.revision : 0 },
    fingerprint: [
      Number.isSafeInteger(inventory?.revision) ? inventory.revision : -1,
      coverage.total, coverage.counts.pending, coverage.counts.in_progress, coverage.counts.tested,
      coverage.complete ? 1 : 0, text.length
    ].join('|')
  };
}

/**
 * Decide whether a completion may be accepted under the coverage gate.
 * `warn` never blocks; `enforce` blocks only security goals with a registered
 * ledger and untested hosts. A missing/empty ledger cannot be verified and is
 * therefore a warning even in enforce mode, so an unconfigured engagement does
 * not deadlock.
 */
export function evaluateCompletionSurface({ mode = 'warn', goal, inventory } = {}) {
  if (!MODES.has(mode)) throw new TypeError('surfaceGate must be off, warn or enforce');
  if (mode === 'off') return { status: 'not_applicable', code: 'GATE_OFF' };
  if (!isSecurityTask(goal)) return { status: 'not_applicable', code: 'NOT_SECURITY' };
  const coverage = coverageSummary(inventory);
  const seeds = Array.isArray(inventory?.seedRoots) ? inventory.seedRoots : [];
  const diagnostics = {
    revision: Number.isSafeInteger(inventory?.revision) ? inventory.revision : 0,
    total: coverage.total,
    counts: { ...coverage.counts },
    incomplete: coverage.incomplete.slice(0, 12)
  };
  if (!seeds.length) {
    return {
      status: 'warn', code: 'SURFACE_LEDGER_MISSING', diagnostics,
      message: 'Coverage gate: no domain inventory seed roots are registered, so host coverage cannot be verified. Keep domain_inventory up to date for security goals.'
    };
  }
  if (coverage.complete) return { status: 'ok', code: 'COVERAGE_COMPLETE', diagnostics };
  const untested = (coverage.counts.pending ?? 0) + (coverage.counts.in_progress ?? 0);
  const message = `Coverage gate: ${untested} of ${coverage.total} hosts are untested (${coverage.incomplete.slice(0, 12).join(', ')}${coverage.incomplete.length > 12 ? ` (+${coverage.incomplete.length - 12} more)` : ''}). Mark each as tested/skipped/out_of_scope with evidence via domain_inventory, or narrow the goal scope; do not claim completion on unverified hosts.`;
  if (mode === 'enforce') return { status: 'blocked', code: 'COVERAGE_INCOMPLETE', diagnostics, message };
  return { status: 'warn', code: 'COVERAGE_INCOMPLETE', diagnostics, message };
}
