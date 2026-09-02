import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/retag-live.sh', import.meta.url));

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** A bare "remote" repo plus a working clone with one commit on main, pushed to it. */
function setup(t) {
  const remote = mkdtempSync(join(tmpdir(), 'retag-remote-'));
  const work = mkdtempSync(join(tmpdir(), 'retag-work-'));
  t.after(() => {
    rmSync(remote, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  git(remote, ['init', '-q', '--bare', '-b', 'main']);

  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  writeFileSync(join(work, 'f.txt'), 'a\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'one']);
  git(work, ['remote', 'add', 'fake', remote]);
  git(work, ['push', '-q', 'fake', 'main']);

  return { remote, work };
}

// Merges stderr into the captured output (`2>&1`) — the "not moving live" / warning
// paths write there, and the test assertions need to see them too.
function runScript(dir, extraArgs = [], extraEnv = {}) {
  return execFileSync('bash', ['-c', '"$0" "$@" 2>&1', SCRIPT, ...extraArgs], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, REMOTE: 'fake', ...extraEnv },
  });
}

test('retag-live.sh: real run against a fake REMOTE tags and pushes live + live-history, never touching origin', (t) => {
  const { remote, work } = setup(t);
  const out = runScript(work);
  assert.match(out, /live -> .* on fake/);
  const remoteTags = git(remote, ['tag']);
  assert.match(remoteTags, /^live$/m);
  assert.match(remoteTags, /^live-history\/1$/m);
});

test('retag-live.sh: DRY_RUN=1 tags locally (inspectable) but never pushes to the remote', (t) => {
  const { remote, work } = setup(t);
  const out = runScript(work, [], { DRY_RUN: '1' });
  assert.match(out, /DRY_RUN: git push/);
  assert.match(out, /\[dry-run\]/);
  assert.equal(git(remote, ['tag']), '', 'nothing pushed to the remote in dry-run');
  assert.match(git(work, ['tag']), /^live$/m, 'local tag still created without touching the remote');
});

test('retag-live.sh: a target that is not the remote tip is a no-op (exit 0), no push attempted', (t) => {
  const { remote, work } = setup(t);
  writeFileSync(join(work, 'f.txt'), 'b\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'two']);
  git(work, ['push', '-q', 'fake', 'main']);
  const oldSha = git(work, ['rev-parse', 'HEAD~1']);

  const out = runScript(work, [oldSha]);
  assert.match(out, /not moving live/);
  assert.equal(git(remote, ['tag']), '', 'no push attempted for a non-tip target');
});
