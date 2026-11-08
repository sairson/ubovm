import test from 'node:test';
import assert from 'node:assert/strict';

// The delivery_workflow tool and its ledger were removed on 2026-10-28.
// The feature tests moved out with it; keep a placeholder so `node --test`
// does not report an empty module.
test('delivery_workflow tool has been removed', { skip: true }, () => {
  assert.ok(true);
});
