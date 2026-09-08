import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { bindWorkspace, discoverProject, initialize, workspaceBinding } from '../src/storage.ts';
import { captureState, enableAdapter, parseTranscript } from '../src/adapters.ts';
import { journal } from '../src/recorder.ts';
import { health } from '../src/probe.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

function sandbox(t) {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'reasoning-workspace-')));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

function gitInit(path) {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: path, stdio: 'ignore' });
}

test('discovers and initializes a sole nested worktree from its workspace parent', t => {
  const workspace = sandbox(t); const root = join(workspace, 'public'); gitInit(root);
  const run = spawnSync(process.execPath, [cli, 'init', '--publication', 'private'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.workspace.workspace_root, workspace);
  assert.equal(result.workspace.repository_root, root);
  assert.equal(result.workspace.discovery, 'descendant');
  assert.equal(existsSync(join(root, '.ai-history/config.json')), true);
  assert.equal(existsSync(join(workspace, '.ai-history/config.json')), false);
  assert.equal(workspaceBinding(discoverProject(workspace).repo).workspace_root, workspace);
});

test('ambiguous descendant worktrees require an explicit repository', t => {
  const workspace = sandbox(t); gitInit(join(workspace, 'one')); gitInit(join(workspace, 'two'));
  assert.throws(() => discoverProject(workspace), /Multiple Git checkouts.*one, two.*--repo PATH/);
  const selected = discoverProject(workspace, 'two');
  assert.equal(selected.repo.root, join(workspace, 'two'));
  assert.equal(selected.workspaceRoot, workspace);
  assert.equal(selected.discovery, 'explicit');
});

test('workspace hooks target the nested repository and capture parent-cwd events and transcripts', { skip: process.platform === 'win32' }, t => {
  const workspace = sandbox(t); const root = join(workspace, 'public'); gitInit(root);
  const project = discoverProject(workspace); initialize(project.repo, 'private');
  bindWorkspace(project.repo, project.workspaceRoot, project.discovery);
  enableAdapter(project.repo, 'codex');
  const stale = join(root, '.codex/hooks.json');
  assert.equal(JSON.parse(readFileSync(stale, 'utf8')).hooks.UserPromptSubmit.length, 1);
  enableAdapter(project.repo, 'codex', { workspaceRoot: workspace });
  assert.equal(JSON.parse(readFileSync(stale, 'utf8')).hooks.UserPromptSubmit.length, 0);

  const installation = captureState(project.repo).installations.codex;
  assert.equal(installation.config_root, workspace);
  assert.equal(installation.workspace_root, workspace);
  const hooks = JSON.parse(readFileSync(join(workspace, '.codex/hooks.json'), 'utf8'));
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(command, / capture codex --repo /);
  assert.match(command, new RegExp(root.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));

  const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'nested', cwd: workspace,
    prompt: 'Nested workspace prompt', timestamp: '2026-09-08T12:00:00.000Z' };
  const capture = spawnSync(process.execPath, [cli, 'capture', 'codex', '--repo', root, '--input', '-'],
    { cwd: workspace, input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(capture.status, 0, capture.stderr);
  assert.equal(journal(project.repo).filter(event => event.source.session_id === 'nested').length, 1);

  const transcript = jsonl([
    { type: 'session_meta', payload: { id: 'transcript', cwd: workspace } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'Nested workspace reply' }] } },
  ]);
  assert.equal(parseTranscript('codex', 'codex-rollout-v1', transcript, 'transcript', root, workspace)[0].content, 'Nested workspace reply');
  const foreign = join(workspace, 'foreign'); mkdirSync(foreign);
  const bad = transcript.replace(workspace, foreign);
  assert.throws(() => parseTranscript('codex', 'codex-rollout-v1', bad, 'transcript', root, workspace), /mismatch/);

  assert.equal(health(project.repo).adapters.codex.hook_commands_present, true);
  assert.equal(health(project.repo).adapters.codex.config_root, workspace);
});
