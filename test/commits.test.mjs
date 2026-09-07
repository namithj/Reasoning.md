import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize, repository } from '../src/storage.ts';
import { ingest, journal } from '../src/recorder.ts';
import { commitPreview, verify } from '../src/commits.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = readFileSync(new URL('fixtures/conversation.jsonl', import.meta.url), 'utf8');
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reasoning-commit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'repo with spaces'); mkdirSync(cwd);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'empty-config') };
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Recorder Test'); git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const hooks = join(dir, 'existing hooks'); mkdirSync(hooks); git('config', 'core.hooksPath', hooks);
  const repo = repository(cwd); initialize(repo, 'private');
  git('add', '.ai-history/config.json');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 20000 });
  const ok = (...args) => {
    const result = run(...args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const stage = (content = 'staged\n') => { writeFileSync(join(cwd, 'code.txt'), content); git('add', 'code.txt'); };
  const hook = (name, text) => { writeFileSync(join(hooks, name), '#!/bin/sh\n' + text + '\n'); chmodSync(join(hooks, name), 0o755); };
  return { cwd, repo, hooks, git, run, ok, stage, hook, dir };
}

test('first controlled commit preserves partial staging, trailers, hashes and existing hooks', t => {
  const { cwd, repo, hooks, git, ok, stage, hook } = setup(t);
  stage(); writeFileSync(join(cwd, 'code.txt'), 'unstaged later edit\n');
  writeFileSync(join(cwd, 'unrelated.txt'), 'untouched');
  ingest(repo, fixture);
  hook('pre-commit', 'echo pre >> hook-log');
  hook('prepare-commit-msg', 'echo prepare >> hook-log');
  hook('commit-msg', 'echo message >> hook-log');
  hook('post-commit', 'echo post >> hook-log');
  hook('reference-transaction', 'cat >> reference-log');
  const result = ok('commit', '-m', 'Fix greeting\n\nPreserve this message body.');
  assert.equal(git('show', 'HEAD:code.txt'), 'staged\n');
  assert.equal(readFileSync(join(cwd, 'code.txt'), 'utf8'), 'unstaged later edit\n');
  assert.match(git('show', '-s', '--format=%B', 'HEAD'), /Preserve this message body/);
  assert.match(git('show', '-s', '--format=%B', 'HEAD'), new RegExp(`Reasoning-Record: ${result.record_id}`));
  assert.equal(git('config', 'core.hooksPath').trim(), hooks);
  assert.deepEqual(readFileSync(join(cwd, 'hook-log'), 'utf8').trim().split('\n'), ['pre', 'prepare', 'message', 'post']);
  assert.match(readFileSync(join(cwd, 'reference-log'), 'utf8'), /refs\/heads\/main/);
  assert.equal(verify(repo).record_id, result.record_id);
  assert.equal(journal(repo).length, 4);
  assert.equal(commitPreview(repo).manifest.capture_boundary.event_ids.length, 0);
  assert.equal(existsSync(join(repo.stateDir, 'transaction.json')), false);
});

test('incremental records export each event once and reference prior context', t => {
  const { repo, git, ok, stage } = setup(t);
  stage(); ingest(repo, fixture); const first = ok('commit', '-m', 'First');
  const next = JSON.parse(fixture.split('\n')[0]); next.sequence = 4; next.source.event_id = 'late-reply';
  next.type = 'assistant_message'; next.content = 'Reply after the first commit boundary.';
  ingest(repo, JSON.stringify(next) + '\n'); stage('second\n');
  const preview = commitPreview(repo); assert.equal(preview.manifest.capture_boundary.event_ids.length, 1);
  assert.deepEqual(preview.manifest.referenced_records, [first.record_id]);
  const second = ok('commit', '-m', 'Second');
  const events = git('show', `HEAD:.ai-history/records/${second.record_id}/events.jsonl`).trim().split('\n');
  assert.equal(events.length, 1);
  assert.equal(verify(repo).records.size, 2);
  const show = spawnSync(process.execPath, [cli, 'show', 'HEAD'], { cwd: repo.root, encoding: 'utf8' });
  assert.equal(show.status, 0, show.stderr); assert.match(show.stdout, /Make the greeting more friendly/);
});

test('a rejecting hook preserves staged code and pending events and permits retry', t => {
  const { repo, git, ok, run, stage, hook, hooks } = setup(t);
  stage(); ingest(repo, fixture);
  const before = git('ls-files', '--stage');
  hook('pre-commit', 'exit 1');
  const failed = run('commit', '-m', 'Rejected'); assert.notEqual(failed.status, 0);
  assert.equal(git('ls-files', '--stage'), before);
  assert.equal(journal(repo).length, 4);
  assert.equal(existsSync(join(repo.stateDir, 'transaction.json')), false);
  rmSync(join(hooks, 'pre-commit'));
  ok('commit', '-m', 'Retry'); assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1');
});

test('hooks changing staged code or stripping the trailer abort before creating a commit', t => {
  const { cwd, repo, git, run, stage, hook, hooks } = setup(t);
  stage(); ingest(repo, fixture);
  hook('commit-msg', 'echo changed-by-hook > code.txt\ngit add code.txt');
  let result = run('commit', '-m', 'Changed index'); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /staged content changed/);
  assert.equal(git('show', ':code.txt'), 'changed-by-hook\n');
  assert.equal(commitPreview(repo).manifest.capture_boundary.event_ids.length, 4);
  hook('commit-msg', 'echo stripped > "$1"');
  result = run('commit', '-m', 'Stripped trailer'); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /valid Reasoning-Record trailer/);
  rmSync(join(hooks, 'commit-msg'));
  assert.equal(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd }).status, 128);
});

test('fresh clone can verify and show records with no recorder journal or local index', t => {
  const { repo, dir, git, stage, ok } = setup(t);
  stage(); ingest(repo, fixture); ok('commit', '-m', 'Recorded');
  const clone = join(dir, 'clone'); git('clone', repo.root, clone);
  const result = spawnSync(process.execPath, [cli, 'verify', 'HEAD'], { cwd: clone, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).verified, true);
  assert.equal(existsSync(join(clone, '.git/reasoning-recorder')), false);
});

test('ordinary bypassed commits and tampered records fail verification', t => {
  const { repo, cwd, git, stage, ok } = setup(t);
  stage(); ingest(repo, fixture); const record = ok('commit', '-m', 'Recorded');
  stage('ordinary\n'); git('commit', '-m', 'Bypassed wrapper');
  assert.throws(() => verify(repo), /valid Reasoning-Record trailer/);
  writeFileSync(join(cwd, `.ai-history/records/${record.record_id}/reasoning.txt`), 'modified');
  git('add', '.ai-history/records'); git('commit', '-m', `Tampered\n\nReasoning-Record: ${record.record_id}`);
  assert.throws(() => verify(repo), /file hash mismatch/);
});

test('manual no-activity status requires explicit attestation and rejects pending events', t => {
  const { repo, stage, ok, run } = setup(t);
  stage(); const first = ok('commit', '-m', 'Manual', '--no-assistant-activity');
  assert.equal(first.capture_status, 'no_assistant_activity');
  stage('next'); ingest(repo, fixture);
  assert.notEqual(run('commit', '-m', 'Wrong attestation', '--no-assistant-activity').status, 0);
  assert.equal(commitPreview(repo).manifest.capture_boundary.event_ids.length, 4);
});

test('no activity is never inferred from an empty journal', t => {
  const { stage, ok } = setup(t); stage();
  assert.equal(ok('commit', '-m', 'Unknown coverage').capture_status, 'unavailable');
});

test('staged archive edits and unsupported commit forms are rejected', t => {
  const { cwd, repo, git, stage, ok, run } = setup(t);
  stage(); ingest(repo, fixture); const record = ok('commit', '-m', 'Recorded');
  writeFileSync(join(cwd, `.ai-history/records/${record.record_id}/reasoning.txt`), 'edited');
  git('add', '.ai-history/records');
  assert.match(run('commit', '-m', 'Mutate archive').stderr, /Archive changes are already staged/);
  assert.notEqual(run('commit', '--amend', '-m', 'Unsupported').status, 0);
  assert.notEqual(run('commit', '-a', '-m', 'Unsupported').status, 0);
});

// The hooks below kill only the separate recorder CLI whose PID is recorded in its worktree lock.
function crashHook(repo, reject = false) {
  const script = join(repo.stateDir, 'crash-test.cjs');
  writeFileSync(script, `const fs = require('node:fs'); const lock = JSON.parse(fs.readFileSync(${JSON.stringify(join(repo.stateDir, 'lock'))}, 'utf8')); process.kill(lock.pid, 'SIGKILL');`);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return `${quote(process.execPath)} ${quote(script)}\n${reject ? 'exit 1' : 'exit 0'}`;
}

test('crash after Git succeeds recovers without creating a second commit', { skip: process.platform === 'win32' }, t => {
  const { repo, hooks, git, stage, hook, run, ok } = setup(t);
  stage(); ingest(repo, fixture); hook('post-commit', crashHook(repo));
  const crashed = run('commit', '-m', 'Created before crash');
  assert.equal(crashed.signal, 'SIGKILL');
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1');
  assert.equal(existsSync(join(repo.stateDir, 'transaction.json')), true);
  rmSync(join(hooks, 'post-commit')); rmSync(join(repo.stateDir, 'lock'));
  const result = ok('commit', '-m', 'Must only reconcile');
  assert.equal(result.recovered, true);
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1');
  assert.equal(commitPreview(repo).manifest.capture_boundary.event_ids.length, 0);
  assert.equal(ok('recover').pending, false);
});

test('crash before Git succeeds recovers owned staging and retains pending events', { skip: process.platform === 'win32' }, t => {
  const { repo, hooks, git, stage, hook, run, ok } = setup(t);
  stage(); ingest(repo, fixture); const before = git('ls-files', '--stage');
  hook('pre-commit', crashHook(repo, true));
  const crashed = run('commit', '-m', 'Interrupted'); assert.equal(crashed.signal, 'SIGKILL');
  rmSync(join(hooks, 'pre-commit')); rmSync(join(repo.stateDir, 'lock'));
  assert.equal(ok('recover').committed, false);
  assert.equal(git('ls-files', '--stage'), before);
  assert.equal(commitPreview(repo).manifest.capture_boundary.event_ids.length, 4);
  ok('commit', '-m', 'Retry after recovery');
});


test('controlled commits isolate linked worktree activity', t => {
  const { repo, cwd, dir, git, stage, ok } = setup(t);
  git('commit', '-m', 'Policy fixture');
  const sibling = join(dir, 'linked worktree'); git('worktree', 'add', '-b', 'sibling', sibling);
  const otherRepo = repository(sibling);
  stage(); ingest(repo, fixture); ok('commit', '-m', 'Main activity');
  const input = JSON.parse(fixture.split('\n')[0]); input.source.session_id = 'sibling-session';
  ingest(otherRepo, JSON.stringify(input) + '\n');
  writeFileSync(join(sibling, 'sibling.txt'), 'sibling edit');
  execFileSync('git', ['add', 'sibling.txt'], { cwd: sibling });
  const result = spawnSync(process.execPath, [cli, 'commit', '-m', 'Sibling activity'], { cwd: sibling, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const record = [...verify(otherRepo).records.values()][0];
  assert.equal(record.manifest.capture_boundary.event_ids.length, 1);
  assert.equal(JSON.parse(record.eventData).source.session_id, 'sibling-session');
  assert.equal(journal(repo).length, 4);
  assert.equal(git('show', '-s', '--format=%s', 'HEAD').trim(), 'Main activity');
});

test('empty and replay-operation commits fail without preparing an archive', t => {
  const { repo, git, stage, ok, run } = setup(t);
  stage(); ok('commit', '-m', 'Initial');
  assert.match(run('commit', '-m', 'Empty').stderr, /No staged code/);
  stage('next');
  writeFileSync(join(repo.gitDir, 'MERGE_HEAD'), git('rev-parse', 'HEAD'));
  assert.match(run('commit', '-m', 'Merge').stderr, /not supported/);
  assert.equal(existsSync(join(repo.stateDir, 'transaction.json')), false);
});

test('a modified generated file is preserved on failure for manual recovery', t => {
  const { cwd, repo, stage, hook, run } = setup(t);
  stage(); ingest(repo, fixture);
  hook('pre-commit', 'for f in .ai-history/records/*/reasoning.txt; do echo user-edit >> "$f"; done\nexit 1');
  const result = run('commit', '-m', 'Preserve edits'); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /working files were modified/);
  const tx = JSON.parse(readFileSync(join(repo.stateDir, 'transaction.json')));
  assert.match(readFileSync(join(cwd, `.ai-history/records/${tx.record_id}/reasoning.txt`), 'utf8'), /user-edit/);
  assert.equal(journal(repo).length, 4);
});

test('installed native hooks attach records to ordinary Git commits and preserve partial staging', t => {
  const { repo, cwd, git, hooks, stage, ok } = setup(t);
  stage(); writeFileSync(join(cwd, 'code.txt'), 'unstaged\n'); ingest(repo, fixture);
  ok('hooks', 'install'); git('commit', '-m', 'Native commit');
  assert.equal(verify(repo).records.size, 1);
  assert.equal(git('show', 'HEAD:code.txt'), 'staged\n');
  assert.equal(readFileSync(join(cwd, 'code.txt'), 'utf8'), 'unstaged\n');
  ok('hooks', 'uninstall'); assert.equal(git('config', 'core.hooksPath').trim(), hooks);
});

test('wrapper remains usable when native integration is installed', t => {
  const { repo, stage, ok, git } = setup(t); stage(); ingest(repo, fixture);
  ok('hooks', 'install'); ok('commit', '-m', 'Wrapper and native');
  assert.equal(verify(repo).records.size, 1); assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1');
});

test('native failing message hook cleans owned staging and does not consume events', t => {
  const { repo, git, stage, hook, ok } = setup(t); stage(); ingest(repo, fixture);
  const before = git('ls-files', '--stage'); ok('hooks', 'install'); hook('commit-msg', 'exit 1');
  assert.throws(() => git('commit', '-m', 'Rejected native commit'));
  assert.equal(git('ls-files', '--stage'), before);
  assert.equal(existsSync(join(repo.stateDir, 'transaction.json')), false);
  assert.equal(commitPreview(repo).manifest.capture_boundary.event_ids.length, 4);
});

test('strict policy rejects incomplete coverage and range checks require explicit overrides', t => {
  const { repo, git, stage, ok, run } = setup(t);
  git('commit', '-m', 'Policy baseline'); const base = git('rev-parse', 'HEAD').trim();
  ok('policy', '--mode', 'strict'); git('add', '.ai-history/config.json'); stage(); ingest(repo, fixture);
  assert.match(run('commit', '-m', 'Incomplete strict commit').stderr, /Strict/);
  assert.equal(existsSync(join(repo.stateDir, 'transaction.json')), false);
  const result = ok('commit', '-m', 'Explicit pilot override', '--allow-partial', 'Pilot capture reviewed');
  assert.equal(verify(repo).records.get(result.record_id).manifest.capture_override, 'Pilot capture reviewed');
  assert.equal(ok('verify-range', `${base}..HEAD`).verified, true);
  assert.notEqual(run('verify-range', `${base}..HEAD`, '--require-complete').status, 0);
  assert.equal(ok('verify-range', `${base}..HEAD`, '--require-complete', '--allow-overrides').verified, true);
});

test('native installation delegates unrelated hooks including their stdin', t => {
  const { cwd, git, stage, hook, ok } = setup(t); stage();
  hook('pre-push', 'cat > push-input');
  ok('hooks', 'install');
  const data = join(cwd, 'input.txt'); writeFileSync(data, 'ref input\n');
  git('hook', 'run', `--to-stdin=${data}`, 'pre-push', '--', 'origin', 'unused');
  assert.equal(readFileSync(join(cwd, 'push-input'), 'utf8'), 'ref input\n');
});

test('companion skill and archived context work from a second checkout', t => {
  const { repo, cwd, dir, git, stage, ok } = setup(t);
  const task = ok('task', 'start', 'Repair greeting');
  ok('decision', 'Keep old API for existing callers', '--task', task.task_id);
  stage(); ok('commit', '-m', 'Record task context', '--task', task.task_id);
  ok('skill', 'install', '--host', 'codex');
  const skill = join(cwd, '.agents/skills/reasoning-md/SKILL.md'); assert.equal(existsSync(skill), true);
  writeFileSync(skill, 'User edited skill');
  assert.notEqual(spawnSync(process.execPath, [cli, 'skill', 'install', '--host', 'codex'], { cwd }).status, 0);
  const clone = join(dir, 'handoff'); git('clone', cwd, clone);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: clone, encoding: 'utf8' });
  const result = run('context', '--task', task.task_id); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Keep old API/); assert.match(result.stdout, /record:[0-9a-f-]{36}/);
  assert.equal(JSON.parse(run('search', 'old API').stdout).matches.length, 1);
  assert.equal(JSON.parse(run('explain', '--file', 'code.txt').stdout).records.length, 1);
  assert.equal(existsSync(join(clone, '.git/reasoning-recorder')), false);
});


test('manual no-activity attestation rejects undrained capture deliveries', t => {
  const { repo, stage, run } = setup(t); stage();
  const queue = join(repo.stateDir, 'capture-queue'); mkdirSync(queue);
  writeFileSync(join(queue, '100-00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ host: 'codex', payload: {}, delivery: 'queued' }));
  assert.match(run('commit', '-m', 'Invalid attestation', '--no-assistant-activity').stderr, /capture deliveries remain queued/);
  assert.equal(existsSync(join(repo.stateDir, 'transaction.json')), false);
});


test('reinstalling native hooks preserves an originally unset hooksPath', t => {
  const { git, ok } = setup(t); git('config', '--local', '--unset', 'core.hooksPath');
  ok('hooks', 'install'); ok('hooks', 'install'); ok('hooks', 'uninstall');
  assert.throws(() => git('config', '--local', '--get', 'core.hooksPath'));
});

test('native hooks tolerate equivalent absolute path spellings', t => {
  const { repo, ok } = setup(t);
  ok('hooks', 'install');
  const installation = join(repo.commonState, 'native-installation.json');
  const state = JSON.parse(readFileSync(installation, 'utf8'));
  state.directory += '/.'; // Git and Node may render the same absolute path differently.
  writeFileSync(installation, JSON.stringify(state));
  ok('hooks', 'install'); ok('hooks', 'uninstall');
});
