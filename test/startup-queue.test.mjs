import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capture, enableAdapter } from '../src/adapters.ts';
import { journal, status } from '../src/recorder.ts';
import { initialize, repository } from '../src/storage.ts';

test('SessionStart quarantines malformed queue JSON and still captures the current session', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'reasoning-startup-queue-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  const repo = repository(cwd); initialize(repo, 'private'); enableAdapter(repo, 'claude-code');
  const queue = join(repo.stateDir, 'capture-queue'); mkdirSync(queue, { recursive: true });
  const bad = join(queue, '0-00000000-0000-0000-0000-000000000000.json'); writeFileSync(bad, '{not json');

  assert.doesNotThrow(() => capture(repo, 'claude-code', {
    hook_event_name: 'SessionStart', session_id: 'current', cwd, timestamp: '2026-09-10T00:00:00Z',
  }, 'current-start'));
  const invalid = bad.slice(0, -'.json'.length) + '.invalid.json';
  assert.ok(existsSync(invalid));
  assert.equal(status(repo).queued_capture_deliveries, 1);
  assert.doesNotThrow(() => capture(repo, 'claude-code', {
    hook_event_name: 'SessionStart', session_id: 'later', cwd, timestamp: '2026-09-10T00:01:00Z',
  }, 'later-start'));
  assert.equal(readdirSync(queue).filter(name => name.endsWith('.json')).length, 1);
  assert.equal(journal(repo).filter(event => ['current', 'later'].includes(event.source.session_id)).length, 2);
});
