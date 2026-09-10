import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, config, git, locked, privateDirectory, samePath, syncDirectory, repository } from './storage.ts';
import type { Repo } from './storage.ts';
import { cleanFailed, finalize, head, installedNative, pending, prepareCommit, runHook } from './commits.ts';
import { reconcile } from './adapters.ts';
import { tasks } from './history.ts';
import { json } from './schema.ts';

const NATIVE_HOOKS = ['pre-merge-commit', 'pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction'];
const sameHookPath = (actual: string, expected: string) => resolve(actual) === resolve(expected) || (() => { try { return samePath(actual, expected); } catch { return false; } })();
const DELEGATED_HOOKS = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change'];

export function installNative(repo: Repo) {
  config(repo);
  return locked({ ...repo, stateDir: repo.commonState }, () => {
    const existing = installedNative(repo);
    const directory = join(repo.commonState, 'native-hooks');
    const scope = spawnSync('git', ['config', '--show-scope', '--get', 'core.hooksPath'], { cwd: repo.root, encoding: 'utf8' });
    if (scope.stdout?.startsWith('worktree\t')) throw new Error('A worktree-specific hook manager needs a manual integration; repository hooks were not changed');
    const prior = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repo.root, encoding: 'utf8' });
    const original_hooks = existing?.original_hooks ?? git(repo.root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']).trim();
    if (existing && !sameHookPath(git(repo.root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']).trim(), existing.directory)) throw new Error('Hook configuration changed since installation; resolve it before reinstalling');
    privateDirectory(directory);
    const cli = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url));
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const name of [...NATIVE_HOOKS, ...DELEGATED_HOOKS]) {
      const path = join(directory, name);
      const target = quote(join(original_hooks, name).replaceAll('\\', '/'));
      atomicWrite(path, NATIVE_HOOKS.includes(name)
        ? `#!/bin/sh\nexec ${quote(process.execPath.replaceAll('\\', '/'))} ${quote(cli.replaceAll('\\', '/'))} native-hook ${name} "$@"\n`
        : `#!/bin/sh\nif test -x ${target}; then exec ${target} "$@"; fi\n`);
      chmodSync(path, 0o755);
    }
    const installation = { node_executable: process.execPath, recorder_executable: cli, original_hooks, prior_local: existing ? existing.prior_local : (prior.status === 0 ? prior.stdout.trim() : null), directory };
    atomicWrite(join(repo.commonState, 'native-installation.json'), json(installation));
    git(repo.root, ['config', '--local', 'core.hooksPath', directory]);
    return { installed: true, scope: 'repository_and_linked_worktrees', original_hooks, directory, ide_commit_gate: 'unverified' };
  });
}

export function uninstallNative(repo: Repo) {
  return locked({ ...repo, stateDir: repo.commonState }, () => {
    const state = installedNative(repo); if (!state) return { installed: false };
    const actual = git(repo.root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']).trim();
    if (!sameHookPath(actual, state.directory)) throw new Error('Hook configuration changed; refusing to overwrite it');
    for (const field of git(repo.root, ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
      if (field.startsWith('worktree ') && existsSync(join(repository(field.slice(9)).stateDir, 'transaction.json'))) throw new Error('Recover pending transactions in every worktree before removing native hooks');
    }
    if (state.prior_local === null) git(repo.root, ['config', '--local', '--unset', 'core.hooksPath']);
    else git(repo.root, ['config', '--local', 'core.hooksPath', state.prior_local]);
    rmSync(join(repo.commonState, 'native-installation.json')); syncDirectory(repo.commonState);
    return { installed: false, restored_original_hooks: true };
  });
}

export function original(repo: Repo, name: string, args: string[], input?: string) {
  const state = installedNative(repo); if (!state) throw new Error('Native hooks are missing installation state');
  const inputFile = join(repo.stateDir, 'native-reference-input');
  if (input !== undefined) { privateDirectory(repo.stateDir); atomicWrite(inputFile, input); }
  const result = spawnSync('git', ['-c', `core.hooksPath=${state.original_hooks}`, 'hook', 'run', '--ignore-missing',
    ...(input === undefined ? [] : [`--to-stdin=${inputFile}`]), name, '--', ...args], { cwd: repo.root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Existing ${name} hook failed`);
}

export function nativeHook(repo: Repo, name: string, args: string[], input?: string) {
  if (!NATIVE_HOOKS.includes(name)) throw new Error('Unsupported native hook');
  const installation = installedNative(repo); if (!installation) throw new Error('Native integration is not installed');
  if (name === 'pre-merge-commit') { original(repo, name, args); throw new Error('Automatic merge trees are frozen before recorder hooks. Finish with reasoning commit -m MESSAGE, or start merges with git merge --no-commit'); }
  const transaction = join(repo.stateDir, 'transaction.json');
  const normalIndex = resolve(repo.gitDir, 'index');
  const actualIndex = process.env.GIT_INDEX_FILE ? resolve(repo.root, process.env.GIT_INDEX_FILE) : normalIndex;
  // Git copies its full temporary index back after -a; path-limited indexes have different semantics.
  if (actualIndex !== normalIndex && actualIndex !== normalIndex + '.lock' && ['pre-commit', 'prepare-commit-msg'].includes(name)) throw new Error('This Git commit uses a temporary index; use an ordinary staged commit');
  // Replays preserve their original records. New resolution discussion stays pending for a follow-up.
  if (!existsSync(transaction) && ['CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'].some(marker => existsSync(join(repo.gitDir, marker)))) {
    original(repo, name, args, input); return;
  }
  try {
    if (name === 'pre-commit') {
      original(repo, name, args);
      if (existsSync(transaction)) throw new Error('A transaction is pending; run reasoning recover before retrying');
      reconcile(repo);
      locked(repo, () => prepareCommit(repo, tasks(repo).active ?? undefined, false, installation.original_hooks, true));
      return;
    }
    if (name === 'prepare-commit-msg') {
      if (args[1] === 'commit') throw new Error('Native amend/reuse-message commits are not yet supported');
      // prepare-commit-msg still runs when --no-verify bypasses pre-commit.
      if (!existsSync(transaction)) {
        reconcile(repo);
        locked(repo, () => prepareCommit(repo, tasks(repo).active ?? undefined, false, installation.original_hooks, true));
      }
      const tx = pending(repo);
      const message = readFileSync(args[0], 'utf8');
      if (/^Reasoning-Record:/mi.test(message)) throw new Error('New commits must not reuse an existing record trailer');
      atomicWrite(args[0], `${message.trimEnd()}\n\nReasoning-Record: ${tx.record_id}\n`);
      original(repo, name, args); return;
    }
    if (!existsSync(transaction)) { original(repo, name, args, input); return; }
    if (name === 'post-commit') {
      const tx = pending(repo);
      locked(repo, () => finalize(repo, tx, head(repo)!));
      original(repo, name, args); return;
    }
    runHook(repo, name, args, input);
  } catch (error) {
    if (existsSync(transaction)) {
      const tx = pending(repo);
      if (tx.native && tx.phase === 'prepared' && head(repo) === tx.parent) locked(repo, () => cleanFailed(repo, tx));
    }
    throw error;
  }
}
