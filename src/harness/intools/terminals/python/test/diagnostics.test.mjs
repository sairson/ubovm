import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosePythonFailure } from '../diagnostics.mjs';

test('diagnoses missing modules with dependency recovery guidance', () => {
  const result = diagnosePythonFailure("Traceback\nModuleNotFoundError: No module named 'requests.adapters'");
  assert.equal(result.kind, 'missing-module');
  assert.equal(result.module, 'requests');
  assert.match(result.recovery, /manage_python_environment/);
});

test('diagnoses argparse and missing-file failures without inventing fixes', () => {
  assert.match(diagnosePythonFailure('error: the following arguments are required: --input').recovery, /run_python.arguments/);
  assert.match(diagnosePythonFailure("FileNotFoundError: [Errno 2] No such file or directory: 'data.csv'").recovery, /cwd/);
  assert.equal(diagnosePythonFailure('ValueError: invalid value'), undefined);
});
