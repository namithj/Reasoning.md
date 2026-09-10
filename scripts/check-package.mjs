import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

assert.ok(process.env.npm_execpath, 'Run this check with npm run check:package');
const [pack] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }));
const paths = pack.files.map(file => file.path);
assert.ok(paths.includes('dist/cli.js') && paths.includes('skills/reasoning-md/SKILL.md'), 'Build the CLI and include the companion skill before packaging');
assert.ok(paths.every(path => !/^(?:docs\/private|\.ai-history|release|\.git)(?:\/|$)/.test(path)), 'Private or local-only files would be published');
console.log(`Package boundary check passed: ${paths.length} files; private documentation and local state excluded.`);

// Install the actual tarball offline, then exercise the documented workflow from a fresh clone.
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const directory = mkdtempSync(join(tmpdir(), 'reasoning-package-'));
try {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(directory, 'empty-git-config') };
  const run = (executable, args, cwd) => execFileSync(executable, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const [artifact] = JSON.parse(run(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory]));
  const prefix = join(directory, 'installed package with spaces');
  run(process.execPath, [process.env.npm_execpath, 'install', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', '--ignore-scripts', join(directory, artifact.filename)]);
  const cli = join(prefix, 'node_modules', '@namithj', 'reasoning.md', 'dist', 'cli.js');
  const cwd = join(directory, 'project with spaces'); mkdirSync(cwd);
  const git = (...args) => run('git', args, cwd);
  const reasoning = (...args) => run(process.execPath, [cli, ...args], cwd);
  git('init', '-b', 'main'); git('config', 'user.name', 'Package Check'); git('config', 'user.email', 'test@example.invalid'); git('config', 'commit.gpgsign', 'false');
  const setup = JSON.parse(reasoning('setup', '--host', 'claude-code', '--publication', 'private'));
  const task = setup.task;
  const hook = JSON.parse(readFileSync(join(cwd, '.claude/settings.local.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(execFileSync(hook.command, hook.args, { cwd, env, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'package-host', cwd, prompt: 'Packaged direct capture', timestamp: '2026-09-08T00:00:00Z' }) }), '');
  reasoning('import', '--input', resolve('test/fixtures/conversation.jsonl'));
  reasoning('decision', 'Preserve partial staging and saved history', '--task', task.task_id);
  reasoning('skill', 'install', '--host', 'codex');
  writeFileSync(join(cwd, 'code.txt'), 'staged\n'); git('add', '.ai-history/config.json', 'code.txt');
  writeFileSync(join(cwd, 'code.txt'), 'unstaged\n');
  assert.match(reasoning('preview', '--staged', '--task', task.task_id), /Preserve partial staging/);
  reasoning('commit', '-m', 'Packaged commit', '--task', task.task_id);
  assert.equal(JSON.parse(reasoning('verify', 'HEAD')).verified, true);
  assert.equal(git('show', 'HEAD:code.txt'), 'staged\n');
  assert.equal(readFileSync(join(cwd, 'code.txt'), 'utf8'), 'unstaged\n');
  git('add', 'code.txt'); git('commit', '-m', 'Packaged native hook');
  assert.equal(JSON.parse(reasoning('verify', 'HEAD')).verified, true);
  const clone = join(directory, 'clone'); git('clone', cwd, clone);
  const fromClone = (...args) => run(process.execPath, [cli, ...args], clone);
  assert.equal(JSON.parse(fromClone('verify', 'HEAD')).verified, true);
  assert.ok(JSON.parse(fromClone('task', 'list')).tasks[task.task_id]);
  fromClone('task', 'resume', task.task_id);
  assert.equal(JSON.parse(fromClone('task', 'list')).active, task.task_id);
  assert.match(fromClone('context', '--task', task.task_id), /Preserve partial staging/);
  assert.match(fromClone('context', '--task', task.task_id), /Packaged direct capture/);
  assert.match(fromClone('show', 'HEAD'), /Preserve partial staging/);
  assert.ok(JSON.parse(fromClone('explain', '--file', 'code.txt')).records.length);
  assert.equal(JSON.parse(fromClone('verify-range', 'HEAD~1..HEAD')).verified, true);
  console.log('Installed package end-to-end check passed: setup, direct host hook, import, decision, skill, preview, partial staging, wrapper/native commits, clone, task resume, context and CI verification.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
