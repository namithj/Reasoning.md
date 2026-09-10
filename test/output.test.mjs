import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatOutput, formatError } from '../src/output.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const state = { events: 0, sessions: [], capture_status: 'unavailable', queued_capture_deliveries: 0, pending_transaction: false, lock_present: false };

test('interactive results explain next steps while pipes and explicit JSON preserve result data', () => {
  const human = formatOutput('status', state, 'auto', true);
  assert.match(human, /No conversation capture is available/);
  assert.match(human, /Events: 0/);
  assert.match(human, /reasoning doctor/);
  assert.deepEqual(JSON.parse(formatOutput('status', state)), state);
  assert.deepEqual(JSON.parse(formatOutput('status', state, 'json', true)), state);
  assert.equal(formatOutput('status', state, 'text'), human);
  const prose = 'Historical evidence\n> Keep the API\n';
  assert.equal(formatOutput('context', prose), prose);
  assert.deepEqual(JSON.parse(formatOutput('context', prose, 'json')), { text: prose });
});

test('doctor distinguishes initialization, configuration and capture without dumping internal aliases', () => {
  const missing = formatOutput('doctor', { initialized: false, hosts: [] }, 'text');
  assert.match(missing, /not been initialized/);
  assert.match(missing, /reasoning setup --host HOST --publication private/);
  const empty = formatOutput('doctor', { initialized: true, recorder: state, capture: { installations: {}, sessions: {} }, hosts: [] }, 'text');
  assert.match(empty, /No adapters are configured/);
  const pending = formatOutput('doctor', {
    initialized: true,
    recorder: { ...state, pending_transaction: true, lock_present: true, queued_capture_deliveries: 1 },
    capture: { installations: { codex: { parser: 'codex-rollout-v1', surface: 'import', config_path: null } },
      sessions: { s1: { session: 's1', host: 'codex', task: 'task-1', gaps: ['Transcript is missing'], aliases: { INTERNAL_ALIAS: 'event-1' } } } },
    hosts: [],
  }, 'text');
  assert.match(pending, /transaction is pending/);
  assert.match(pending, /recorder lock exists/);
  assert.match(pending, /Transcript is missing/);
  assert.match(pending, /reasoning reconcile/);
  assert.match(pending, /compatibility remains unverified/);
  assert.doesNotMatch(pending, /INTERNAL_ALIAS/);
});

test('failures, incomplete coverage and recovery never produce misleading success messages', () => {
  const failure = formatOutput('verify-range', { verified: false, results: [{ commit: 'abc', verified: false, error: 'Missing record' }] }, 'text');
  assert.match(failure, /failed verification/);
  assert.match(failure, /Missing record/);
  assert.doesNotMatch(failure, /checks passed/);
  const recovery = formatOutput('commit', { recovered: true, committed: false, events_retained: true }, 'text');
  assert.match(recovery, /no new commit was created/);
  assert.doesNotMatch(recovery, /Commit created/);
  assert.match(formatOutput('commit', { commit: 'abc', capture_status: 'partial' }, 'text'), /Capture is partial/);
  assert.match(formatOutput('reconcile', [{ queued: true, error: 'Unreadable source' }], 'text'), /still need attention/);
  assert.match(formatOutput('search', { matches: [], truncated: false }, 'text'), /No matching/);
});

test('human output removes terminal controls and common credentials from displayed content', () => {
  const secret = 'ghp_' + 'x'.repeat(30);
  const text = formatOutput('task start', { task_id: 'task-1', title: `hello\x1b[2J\x1b]0;spoofed title\x07${secret}\r\bworld` }, 'text');
  assert.doesNotMatch(text, /\x1b|\x07|\r|\x08|spoofed title/);
  assert.ok(!text.includes(secret));
  assert.match(text, /REDACTED/);
  assert.match(formatError('Multiple tasks are present', true), /reasoning task list/);
  assert.equal(formatError('No staged changes', false), 'reasoning: No staged changes\n');
});

test('CLI format selection and hook failures work without any Git writes', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'reasoning-output-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', input: '{}', timeout: 15000 });
  const args = ['probe', 'codex', '--extension-dir', cwd];
  const piped = run(...args);
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(JSON.parse(piped.stdout).host, 'codex');
  const human = run(...args, '--format', 'text');
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Environment inspection for codex/);
  assert.match(human.stdout, /Repository detected: No/);
  const machine = run(...args, '--format', 'json');
  assert.equal(machine.status, 0, machine.stderr);
  assert.deepEqual(JSON.parse(machine.stdout), JSON.parse(piped.stdout));
  const error = run('status', '--format', 'text');
  assert.equal(error.status, 1);
  assert.match(error.stderr, /^Error:/);
  assert.match(error.stderr, /Git checkout/);
  const invalid = run('init', '--publication', 'private', '--format', 'xml');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Output format must be text or json/);
  const hook = run('capture', 'codex', '--input', '-', '--format', 'text');
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, '');
  assert.match(hook.stderr, /^reasoning:/);
});


test("setup output distinguishes installed configuration from runtime verification", () => {
  const ready = formatOutput("setup", {
    host: "codex", publication: "private",
    workspace: { repository_root: "/repo", workspace_root: "/repo" },
    task: { task_id: "task-1" }, adapter: { configured: true }, skill: { installed: true }, git_hooks: { installed: true },
    setup_health: {
      adapters: { codex: { hooks_enabled: true, capture_configuration_ready: true } },
      git: { automatic_commit_configuration_ready: true },
    },
    staged_by_setup: false, runtime_verified: false,
  }, "text");
  assert.match(ready, /are ready for codex/);
  assert.match(ready, /\/hooks/);
  assert.match(ready, /setup staged nothing/);
  assert.match(ready, /everyone who receives the repository/);
  assert.match(ready, /does not prove live assistant or editor execution/);

  const attention = formatOutput("setup", {
    host: "claude-code", workspace: {}, task: {}, adapter: { configured: true },
    skill: { preserved: true, warning: "Customized skill preserved" }, git_hooks: { installed: true },
    setup_health: {
      adapters: { "claude-code": { hooks_enabled: false, capture_configuration_ready: false } },
      git: { automatic_commit_configuration_ready: false },
    },
  }, "text");
  assert.match(attention, /still needs attention/);
  assert.match(attention, /hooks are disabled/);
  assert.match(attention, /Customized skill preserved/);
  assert.doesNotMatch(attention, /are ready/);
});

test("doctor gives commands for disabled adapters and Git hook drift", () => {
  const report = formatOutput("doctor", {
    initialized: true, recorder: state,
    capture: { installations: { "claude-code": { parser: "claude-jsonl-v1", config_path: ".claude/settings.local.json" } }, sessions: {} },
    health: {
      adapters: { "claude-code": { hooks_enabled: false, capture_configuration_ready: false, config_path: ".claude/settings.local.json" } },
      git: { configured: true, hooks_path_matches: false, automatic_commit_configuration_ready: false },
    },
    hosts: [],
  }, "text");
  assert.match(report, /settings disable hooks/);
  assert.match(report, /reasoning setup again/);
  assert.match(report, /core\.hooksPath changed/);
  assert.match(report, /reasoning hooks install/);
});
