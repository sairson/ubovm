import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../../webview/team/' + name, import.meta.url), 'utf8');

test('team surfaces use neutral ink accents instead of the blue business token', () => {
  for (const file of ['team-panel.css', 'team-member-view.css']) {
    const css = read(file);
    assert.doesNotMatch(css, /--dsw-alias-state-business-primary/, `${file} must not use the blue business token`);
    assert.doesNotMatch(css, /var\(--accent\)/, `${file} must not use the blue brand accent`);
    assert.match(css, /--team-active:/, `${file} must define the neutral active accent`);
  }
});

test('semantic error and warning colors stay available after the neutral swap', () => {
  for (const file of ['team-panel.css', 'team-member-view.css']) {
    const css = read(file);
    assert.match(css, /--dsw-alias-state-error-primary/, `${file} must keep the error color`);
    assert.match(css, /--dsw-alias-state-warn/, `${file} must keep the warning color`);
  }
});
