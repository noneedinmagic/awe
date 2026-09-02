import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const labels = JSON.parse(readFileSync(new URL('../templates/labels.json', import.meta.url), 'utf8'));

// GitHub's label API rejects any description over 100 chars (422 Validation Failed) —
// caught live via `gh label edit` after `ai:ready`'s description grew past it in #204's
// PR, undetected until someone actually ran the bootstrap step against a real repo.
test('templates/labels.json: every description fits GitHub label API\'s 100-char limit', () => {
  for (const l of labels) {
    assert.ok(l.description.length <= 100, `"${l.name}" description is ${l.description.length} chars: ${l.description}`);
  }
});

test('templates/labels.json: every name and color is present and non-empty', () => {
  for (const l of labels) {
    assert.ok(l.name, 'a label with no name');
    assert.match(l.color, /^[0-9a-fA-F]{6}$/, `"${l.name}" has an invalid color: ${l.color}`);
  }
});

test('templates/labels.json: no duplicate label names', () => {
  const names = labels.map((l) => l.name);
  assert.deepEqual(names, [...new Set(names)]);
});
