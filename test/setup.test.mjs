import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reasoning-setup-'));
  const cwd = join(dir, 'project'); mkdirSync(cwd);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'global-git-config') };
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 20000 });
  const ok = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Setup Test'); git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  return { cwd, env, git, run, ok };
}

test('setup is repeatable and preserves policy, task bindings, unrelated hooks and customized skills', t => {
  const { cwd, git, run, ok } = project(t);
  ok('init', '--publication', 'private');
  ok('policy', '--mode', 'strict');
  const task = ok('task', 'start', 'Existing task');
  ok('task', 'bind', 'claude-code', 'existing-session', '--task', task.task_id);
  ok('adapter', 'enable', 'claude-code', '--surface', 'import', '--parser', 'none');

  const hooks = join(cwd, 'existing hooks'); mkdirSync(hooks);
  const preCommit = join(hooks, 'pre-commit'); writeFileSync(preCommit, '#!/bin/sh\nprintf ran > existing-hook-ran\n'); chmodSync(preCommit, 0o755);
  git('config', '--local', 'core.hooksPath', hooks);

  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(cwd, '.claude/settings.local.json'), JSON.stringify({
    keep: 'unchanged',
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'unrelated-command' }] }] },
  }));
  const skill = join(cwd, '.claude/skills/reasoning-md/SKILL.md');
  mkdirSync(join(cwd, '.claude/skills/reasoning-md'), { recursive: true });
  writeFileSync(skill, 'custom project instructions\n');

  const first = ok('setup', '--host', 'claude-code', '--publication', 'private');
  rmSync(first.git_hooks.directory, { recursive: true });
  const second = ok('setup', '--host', 'claude-code', '--publication', 'private');
  assert.equal(first.task.task_id, task.task_id);
  assert.equal(first.adapter.parser, 'none');
  assert.equal(first.adapter.surface, 'extension');
  assert.equal(second.task.task_id, task.task_id);
  assert.equal(second.skill.preserved, true);
  assert.equal(readFileSync(skill, 'utf8'), 'custom project instructions\n');
  assert.equal(second.setup_health.adapters['claude-code'].capture_configuration_ready, true);
  assert.equal(second.setup_health.git.automatic_commit_configuration_ready, true);

  const config = JSON.parse(readFileSync(join(cwd, '.ai-history/config.json'), 'utf8'));
  assert.equal(config.publication, 'private');
  assert.equal(config.mode, 'strict');
  const beforeMismatch = readFileSync(join(cwd, '.ai-history/config.json'), 'utf8');
  assert.notEqual(run('setup', '--host', 'claude-code', '--publication', 'public').status, 0);
  assert.equal(readFileSync(join(cwd, '.ai-history/config.json'), 'utf8'), beforeMismatch);
  const tasks = ok('task', 'list');
  assert.equal(tasks.active, task.task_id);
  assert.equal(tasks.bindings['["claude-code","existing-session"]'], task.task_id);
  const settings = JSON.parse(readFileSync(join(cwd, '.claude/settings.local.json'), 'utf8'));
  assert.equal(settings.keep, 'unchanged');
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'unrelated-command');
  assert.equal(settings.hooks.UserPromptSubmit.length, 2);
  assert.equal(git('diff', '--cached', '--name-only'), '');
});

test('setup rejects invalid choices before changing the repository', t => {
  const { cwd, git, run } = project(t);
  for (const args of [
    ['setup', '--host', 'unknown', '--publication', 'private'],
    ['setup', '--host', 'claude-code', '--publication', 'internal'],
  ]) {
    const result = run(...args);
    assert.notEqual(result.status, 0);
  }
  assert.equal(existsSync(join(cwd, '.ai-history')), false);
  assert.equal(existsSync(join(cwd, '.claude')), false);
  assert.throws(() => git('config', '--local', '--get', 'core.hooksPath'));
});

test('setup supports a code-only first commit and captures two later sessions through ordinary Git commits', t => {
  const { cwd, env, git, ok } = project(t);
  const setup = ok('setup', '--host', 'claude-code', '--publication', 'private');
  const settingsPath = join(cwd, '.claude/settings.local.json');
  const hook = event => {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return settings.hooks[event].flatMap(group => group.hooks ?? [group])
      .find(entry => Array.isArray(entry.args) && entry.args.includes('capture'));
  };
  const emit = (event, session, fields = {}) => {
    const installed = hook(event);
    const result = spawnSync(installed.command, installed.args, {
      cwd, env, encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: event, session_id: session, cwd, timestamp: new Date().toISOString(), ...fields }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  };

  writeFileSync(join(cwd, 'code.txt'), 'first\n');
  git('add', '.ai-history/config.json', 'code.txt');
  git('commit', '-m', 'Code only');
  assert.equal(ok('verify', 'HEAD').capture_status, 'unavailable');

  for (const [session, content] of [['session-one', 'second'], ['session-two', 'third']]) {
    emit('SessionStart', session);
    emit('UserPromptSubmit', session, { prompt: 'Change code for ' + session });
    emit('Stop', session, { last_assistant_message: 'Changed code for ' + session });
    writeFileSync(join(cwd, 'code.txt'), content + '\n');
    git('add', 'code.txt');
    git('commit', '-m', content);
    assert.equal(ok('verify', 'HEAD').capture_status, 'partial');
    assert.match(ok('show', 'HEAD', '--format', 'json').text, new RegExp(session));
  }

  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '3');
  const tasks = ok('task', 'list');
  assert.equal(tasks.active, setup.task.task_id);
  assert.equal(Object.keys(tasks.tasks).length, 1);
  assert.doesNotMatch(ok('show', 'HEAD', '--format', 'json').text, /Task objective \(user supplied\)/);
});

test('Windows setup rejects unsupported automatic hosts before mutation', { skip: process.platform !== 'win32' }, t => {
  const { cwd, run } = project(t);
  const result = run('setup', '--host', 'codex', '--publication', 'private');
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(cwd, '.ai-history')), false);
});
