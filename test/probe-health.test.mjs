import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableAdapter } from '../src/adapters.ts';
import { installNative, uninstallNative } from '../src/native.ts';
import { health } from '../src/probe.ts';
import { initialize, repository } from '../src/storage.ts';

function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'reasoning-health-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  const repo = repository(cwd); initialize(repo, 'private');
  return { cwd, repo, git: (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }) };
}

test('native health follows the effective hooks path and checks every executable target', { skip: process.platform === 'win32' }, t => {
  const { cwd, repo, git } = setup(t);
  assert.equal(health(repo).git.automatic_commit_configuration_ready, false);
  installNative(repo);
  const installed = JSON.parse(readFileSync(join(repo.commonState, 'native-installation.json'), 'utf8'));
  let report = health(repo).git;
  assert.equal(report.configured, true);
  assert.equal(report.hooks_path_matches, true);
  assert.equal(report.expected_hooks_path, installed.directory);
  assert.equal(report.effective_hooks_path, installed.directory);
  assert.equal(report.hooks_present, true);
  assert.equal(report.hooks_executable, true);
  assert.equal(report.node_readable, true);
  assert.equal(report.node_executable, true);
  assert.equal(report.recorder_readable, true);
  assert.equal(report.automatic_commit_configuration_ready, true);
  assert.equal(report.editor_commit_verified, false);

  const inactive = join(cwd, 'inactive-hooks'); mkdirSync(inactive);
  git('config', '--local', 'core.hooksPath', inactive);
  report = health(repo).git;
  assert.equal(report.configured, true);
  assert.equal(report.hooks_path_matches, false);
  assert.equal(report.automatic_commit_configuration_ready, false);

  git('config', '--local', 'core.hooksPath', installed.directory);
  chmodSync(join(installed.directory, 'pre-merge-commit'), 0o644);
  report = health(repo).git;
  assert.equal(report.hooks_present, true);
  assert.equal(report.hooks_executable, false);
  assert.equal(report.automatic_commit_configuration_ready, false);

  chmodSync(join(installed.directory, 'pre-merge-commit'), 0o755);
  installed.recorder_executable = join(cwd, 'missing-recorder.js');
  writeFileSync(join(repo.commonState, 'native-installation.json'), JSON.stringify(installed));
  report = health(repo).git;
  assert.equal(report.recorder_readable, false);
  assert.equal(report.automatic_commit_configuration_ready, false);

  installed.recorder_executable = process.execPath;
  installed.node_executable = join(cwd, 'missing-node');
  writeFileSync(join(repo.commonState, 'native-installation.json'), JSON.stringify(installed));
  report = health(repo).git;
  assert.equal(report.node_readable, false);
  assert.equal(report.node_executable, false);
  assert.equal(report.automatic_commit_configuration_ready, false);
});

test('native hook health compares physical path identity across platform aliases', t => {
  const { cwd, repo, git } = setup(t); installNative(repo);
  const installed = JSON.parse(readFileSync(join(repo.commonState, 'native-installation.json'), 'utf8'));
  if (process.platform === 'win32') {
    git('config', '--local', 'core.hooksPath', installed.directory.toUpperCase());
    assert.equal(health(repo).git.hooks_path_matches, true);
    assert.equal(installNative(repo).installed, true);
    const short = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${installed.directory}") do @echo %~sI`], { encoding: 'utf8' }).trim();
    git('config', '--local', 'core.hooksPath', short);
    assert.equal(health(repo).git.hooks_path_matches, true);
    assert.equal(installNative(repo).installed, true);
    git('config', '--local', 'core.hooksPath', short);
    assert.equal(uninstallNative(repo).restored_original_hooks, true);
    return;
  }
  const alias = join(cwd, 'hooks-alias'); symlinkSync(installed.directory, alias, 'dir');
  git('config', '--local', 'core.hooksPath', alias);
  assert.equal(health(repo).git.hooks_path_matches, true);
  assert.equal(installNative(repo).installed, true);
  if (process.platform === 'darwin' && installed.directory.startsWith('/private/var/')) {
    git('config', '--local', 'core.hooksPath', installed.directory.slice('/private'.length));
    assert.equal(health(repo).git.hooks_path_matches, true);
    assert.equal(installNative(repo).installed, true);
  }
  git('config', '--local', 'core.hooksPath', alias);
  assert.equal(uninstallNative(repo).restored_original_hooks, true);
});

test('adapter health reports configured hooks disabled by the host separately from runtime verification', { skip: process.platform === 'win32' }, t => {
  const { cwd, repo } = setup(t); enableAdapter(repo, 'claude-code');
  let report = health(repo).adapters['claude-code'];
  assert.equal(report.hook_commands_present, true);
  assert.equal(report.hooks_enabled, true);
  assert.equal(report.capture_configuration_ready, true);
  assert.equal(report.live_panel_verified, false);

  const path = join(cwd, '.claude/settings.local.json');
  const settings = JSON.parse(readFileSync(path, 'utf8')); settings.disableAllHooks = true;
  writeFileSync(path, JSON.stringify(settings));
  report = health(repo).adapters['claude-code'];
  assert.equal(report.hook_commands_present, true);
  assert.equal(report.hooks_enabled, false);
  assert.equal(report.capture_configuration_ready, false);
  assert.equal(report.live_panel_verified, false);

  writeFileSync(path, '{invalid');
  report = health(repo).adapters['claude-code'];
  assert.equal(report.hook_commands_present, false);
  assert.equal(report.hooks_enabled, null);
  assert.equal(report.capture_configuration_ready, false);
});
