import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, redact } from './schema.ts';
import { config, git, gitBytes, identity, locked, privateDirectory, atomicWrite, readJSON, syncDirectory, assertPlain } from './storage.ts';
import type { Repo } from './storage.ts';
import { journal, snapshot, staged, writeRecord } from './recorder.ts';
import type { RecordData } from './recorder.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const FILES = ['reasoning.txt', 'events.jsonl', 'manifest.json'] as const;
const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction'] as const;
const pathFor = (id: string, file: string) => `.ai-history/records/${id}/${file}`;
const transactionPath = (repo: Repo) => join(repo.stateDir, 'transaction.json');

type Transaction = {
  schema_version: 1; native?: boolean; phase: 'prepared' | 'committed' | 'finalized'; record_id: string;
  ref: string; parent: string | null; tree: string | null; commit: string | null; original_hooks: string;
  repository_id: string; worktree_id: string; files: Record<string, string>;
};

export function installedNative(repo: Repo): { original_hooks: string; prior_local: string | null; directory: string } | null {
  const path = join(repo.commonState, 'native-installation.json');
  if (!existsSync(path)) return null;
  const value = readJSON(path) as any;
  if (typeof value.original_hooks !== 'string' || typeof value.directory !== 'string') throw new Error('Invalid native hook installation state');
  return value;
}

export function head(repo: Repo): string | null {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo.root, encoding: 'utf8' });
  if (result.status === 0 && OID.test(result.stdout.trim())) return result.stdout.trim();
  // Only a genuinely unborn branch is treated as having no HEAD.
  const branch = git(repo.root, ['symbolic-ref', '-q', 'HEAD']).trim();
  const ref = spawnSync('git', ['show-ref', '--verify', '--quiet', branch], { cwd: repo.root });
  if (ref.status !== 1) throw new Error('Cannot resolve HEAD safely');
  return null;
}

function currentRef(repo: Repo) {
  const result = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: repo.root, encoding: 'utf8' });
  if (result.status === 1) return 'HEAD';
  if (result.status !== 0) throw new Error('Cannot resolve the current branch');
  return result.stdout.trim();
}

function revision(repo: Repo, ref: string) {
  const oid = git(repo.root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  if (!OID.test(oid)) throw new Error('Invalid commit revision');
  return oid;
}

export function recordAt(repo: Repo, commit: string, id: string): RecordData {
  if (!UUID.test(id)) throw new Error('Invalid record ID');
  let manifest: RecordData['manifest'];
  try { manifest = JSON.parse(git(repo.root, ['show', `${commit}:${pathFor(id, 'manifest.json')}`])); }
  catch { throw new Error('Missing or invalid committed manifest'); }
  if (!manifest || manifest.schema_version !== 1 || manifest.record_id !== id || manifest.snapshot !== false
    || !UUID.test(manifest.repository_id) || !Array.isArray(manifest.referenced_records)
    || !manifest.referenced_records.every(ref => typeof ref === 'string' && UUID.test(ref))
    || !Array.isArray(manifest.capture_boundary?.event_ids)
    || !manifest.capture_boundary.event_ids.every(event => typeof event === 'string' && /^[a-f0-9]{64}$/.test(event))
    || !['partial', 'unavailable', 'no_assistant_activity'].includes(manifest.capture_status)
    || !manifest.files || Object.keys(manifest.files).sort().join(',') !== 'events.jsonl,reasoning.txt'
    || manifest.fingerprint_algorithm !== 'sha256-git-cached-raw-no-renames-excluding-records-v1') {
    throw new Error('Unsupported or malformed committed record');
  }
  const entries = git(repo.root, ['ls-tree', '-r', '-z', commit, '--', `.ai-history/records/${id}`]).split('\0').filter(Boolean);
  if (entries.length !== 3 || entries.some(entry => !/^100644 blob [a-f0-9]+\t/.test(entry))
    || !FILES.every(file => entries.some(entry => entry.endsWith('\t' + pathFor(id, file))))) {
    throw new Error('Committed record must contain exactly three regular, non-executable files');
  }
  const reasoning = git(repo.root, ['show', `${commit}:${pathFor(id, 'reasoning.txt')}`]);
  const eventData = git(repo.root, ['show', `${commit}:${pathFor(id, 'events.jsonl')}`]);
  if (hash(reasoning) !== manifest.files['reasoning.txt'] || hash(eventData) !== manifest.files['events.jsonl']) {
    throw new Error('Committed record file hash mismatch');
  }
  let eventIds: string[];
  try {
    if (eventData && !eventData.endsWith('\n')) throw new Error();
    eventIds = eventData.split('\n').filter(Boolean).map(line => {
      const event = JSON.parse(line);
      if (event.schema_version !== 1 || event.repository_id !== manifest.repository_id || typeof event.content !== 'string') throw new Error();
      return event.event_id;
    });
  } catch { throw new Error('Malformed committed events'); }
  if (JSON.stringify(eventIds) !== JSON.stringify(manifest.capture_boundary.event_ids) || new Set(eventIds).size !== eventIds.length) {
    throw new Error('Committed event boundary mismatch');
  }
  return { manifest, reasoning, eventData };
}

function trailer(message: string): string {
  const matches = [...message.matchAll(/^Reasoning-Record:\s*([^\r\n]+)\s*$/gm)];
  if (matches.length !== 1 || !UUID.test(matches[0][1].trim())) throw new Error('Commit must have exactly one valid Reasoning-Record trailer');
  const id = matches[0][1].trim();
  // Require the trailer in the final paragraph, not a quote in the message body.
  if (!message.trimEnd().split(/\r?\n\s*\r?\n/).at(-1)!.split(/\r?\n/).includes(`Reasoning-Record: ${id}`)) {
    throw new Error('Reasoning-Record must be in the final commit-message paragraph');
  }
  return id;
}

export function verify(repo: Repo, ref = 'HEAD') {
  const commit = revision(repo, ref);
  const id = trailer(git(repo.root, ['show', '-s', '--format=%B', commit]));
  const primary = recordAt(repo, commit, id);
  const parents = git(repo.root, ['show', '-s', '--format=%P', commit]).trim().split(' ').filter(Boolean);
  if (parents.length > 1) throw new Error('Merge commit verification is not supported by the controlled wrapper');
  const raw = gitBytes(repo.root, ['diff-tree', '--root', '--no-commit-id', '--raw', '-r', '-z', '--no-abbrev', '--no-renames',
    commit, '--', ':(top)**', ':(top,exclude).ai-history/records/**']);
  const archiveChanges = git(repo.root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--no-renames', commit, '--', '.ai-history/records']).split('\0').filter(Boolean);
  if (archiveChanges.length !== 6 || !FILES.every(file => {
    const i = archiveChanges.indexOf(pathFor(id, file));
    return i > 0 && archiveChanges[i - 1] === 'A';
  })) throw new Error('Commit must add only its new record and preserve earlier archives');
  if (hash(raw) !== primary.manifest.staged_code_fingerprint) throw new Error('Committed code fingerprint differs from the record');
  if (parents.length && git(repo.root, ['ls-tree', parents[0], '--', `.ai-history/records/${id}`]).length) {
    throw new Error('Containing commit reused an earlier record ID');
  }
  const records = new Map([[id, primary]]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(current: string) {
    if (visiting.has(current)) throw new Error('Cyclic record references');
    if (visited.has(current)) return;
    if (records.size > 10000) throw new Error('Record reference limit exceeded');
    visiting.add(current);
    const record = records.get(current) ?? recordAt(repo, commit, current);
    records.set(current, record);
    if (record.manifest.repository_id !== primary.manifest.repository_id) throw new Error('Cross-repository record reference');
    for (const previous of record.manifest.referenced_records) visit(previous);
    visiting.delete(current); visited.add(current);
  }
  visit(id);
  return { commit, record_id: id, capture_status: primary.manifest.capture_status, records };
}

export function show(repo: Repo, ref = 'HEAD') {
  const result = verify(repo, ref);
  return [...result.records.values()].map(record => record.reasoning).join('\n');
}

export function commitPreview(repo: Repo, task?: string, noActivity = false) {
  const parent = head(repo);
  const excludeIds = new Set<string>();
  const priorRecords: RecordData['manifest'][] = [];
  const repositoryId = config(repo).repository_id;
  // ponytail: scan manifests in HEAD on each preparation; add a rebuildable cache before large archives.
  if (parent) {
    const paths = git(repo.root, ['ls-tree', '-r', '--name-only', '-z', parent, '--', '.ai-history/records']).split('\0');
    for (const path of paths) {
      const match = /^\.ai-history\/records\/([^/]+)\/manifest\.json$/.exec(path);
      if (!match || !UUID.test(match[1])) continue;
      let value: RecordData['manifest'];
      try { value = JSON.parse(git(repo.root, ['show', `${parent}:${path}`])); } catch { throw new Error('Invalid archived manifest in HEAD'); }
      if (value.snapshot === true) continue;
      const record = recordAt(repo, parent, match[1]);
      if (record.manifest.repository_id !== repositoryId) continue;
      record.manifest.capture_boundary.event_ids.forEach(id => excludeIds.add(id));
      priorRecords.push(record.manifest);
    }
  }
  const selectedTask = task ?? journal(repo)[0]?.task_id ?? null;
  const relevant = priorRecords.filter(previous => previous.task_id === selectedTask);
  const alreadyReferenced = new Set(relevant.flatMap(previous => previous.referenced_records));
  const references = relevant.filter(previous => !alreadyReferenced.has(previous.record_id)).map(previous => previous.record_id);
  return snapshot(repo, task, { commit: true, excludeIds, references, noActivity });
}

export function pending(repo: Repo): Transaction {
  const value = readJSON(transactionPath(repo)) as Transaction;
  const ids = identity(repo);
  if (!value || value.schema_version !== 1 || !UUID.test(value.record_id)
    || !['prepared', 'committed', 'finalized'].includes(value.phase)
    || typeof value.ref !== 'string' || !(value.ref === 'HEAD' || value.ref.startsWith('refs/heads/'))
    || (value.parent !== null && !OID.test(value.parent)) || (value.tree !== null && !OID.test(value.tree))
    || (value.commit !== null && !OID.test(value.commit)) || typeof value.original_hooks !== 'string'
    || value.repository_id !== ids.repository_id || value.worktree_id !== ids.worktree_id
    || !value.files || Object.keys(value.files).sort().join(',') !== [...FILES].sort().join(',')
    || !Object.values(value.files).every(digest => /^[a-f0-9]{64}$/.test(digest))) {
    throw new Error('Invalid transaction; preserve local state for recovery');
  }
  return value;
}

function guard(repo: Repo, tx: Transaction) {
  if (currentRef(repo) !== tx.ref || head(repo) !== tx.parent || git(repo.root, ['write-tree']).trim() !== tx.tree) {
    throw new Error('HEAD or staged content changed after preparation; commit aborted. Review hook changes before retrying');
  }
}

// Internal hook entry point: the wrapper creates these launchers only in local Git metadata.
export function runHook(repo: Repo, hook: string, args: string[], stdin?: string) {
  if (!(HOOKS as readonly string[]).includes(hook)) throw new Error('Unsupported internal hook');
  const tx = pending(repo);
  if (!tx.native && process.env.REASONING_TRANSACTION !== tx.record_id) throw new Error('Internal hook is only available during its controlled commit');
  const inputFile = join(repo.stateDir, 'reference-input');
  if (stdin !== undefined) atomicWrite(inputFile, stdin);
  const inherited = spawnSync('git', ['-c', `core.hooksPath=${tx.original_hooks}`, 'hook', 'run', '--ignore-missing', ...(stdin === undefined ? [] : [`--to-stdin=${inputFile}`]), hook, '--', ...args], {
    cwd: repo.root, encoding: 'utf8', input: stdin,
    stdio: [stdin === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  });
  if (inherited.status !== 0) throw new Error(`Existing ${hook} hook failed`);
  if (hook === 'commit-msg') {
    guard(repo, tx);
    if (trailer(readFileSync(args[0], 'utf8')) !== tx.record_id) throw new Error('Commit hook changed the record trailer');
  }
  if (hook === 'reference-transaction' && args[0] === 'prepared') {
    // This gate also runs after signing, before Git updates the branch reference.
    const updates = (stdin ?? '').trim().split('\n').map(line => line.split(' '));
    const candidate = updates.find(([old, next, ref]) => ref === tx.ref && old === (tx.parent ?? '0'.repeat(next?.length ?? 40)) && OID.test(next ?? '') && !/^0+$/.test(next))?.[1];
    if (candidate) {
      const result = verify(repo, candidate);
      if (result.record_id !== tx.record_id || git(repo.root, ['show', '-s', '--format=%T', candidate]).trim() !== tx.tree) {
        throw new Error('Candidate commit does not match the prepared record');
      }
    }
  }
}

export function cleanFailed(repo: Repo, tx: Transaction) {
  for (const directory of ['.ai-history', '.ai-history/records', `.ai-history/records/${tx.record_id}`]) assertPlain(join(repo.root, directory), true);
  // Only remove exact recorder-owned blobs; retain hook/user edits for manual review.
  for (const file of FILES) {
    const relative = pathFor(tx.record_id, file);
    const entry = git(repo.root, ['ls-files', '--stage', '--', relative]);
    if (entry && hash(git(repo.root, ['show', `:${relative}`])) !== tx.files[file]) {
      throw new Error('Recorder-owned staged files were modified; preserve them and resolve the pending transaction manually');
    }
    const path = join(repo.root, relative);
    assertPlain(path, false);
    if (existsSync(path) && hash(readFileSync(path)) !== tx.files[file]) {
      throw new Error('Recorder-owned working files were modified; preserve them and resolve the pending transaction manually');
    }
  }
  git(repo.root, ['update-index', '--force-remove', '--', ...FILES.map(file => pathFor(tx.record_id, file))]);
  for (const file of FILES) rmSync(join(repo.root, pathFor(tx.record_id, file)), { force: true });
  // Do not recursively remove the record directory: another process may have added files.
  try { rmdirSync(join(repo.root, '.ai-history', 'records', tx.record_id)); } catch { /* Empty directory is harmless. */ }
  rmSync(transactionPath(repo)); syncDirectory(repo.stateDir);
}

export function finalize(repo: Repo, tx: Transaction, commit: string) {
  const result = verify(repo, commit);
  if (result.record_id !== tx.record_id || git(repo.root, ['show', '-s', '--format=%T', commit]).trim() !== tx.tree) {
    throw new Error('Committed tree differs from transaction; preserve pending state');
  }
  tx.phase = 'committed'; tx.commit = commit;
  atomicWrite(transactionPath(repo), json(tx));
  // Event export boundaries are rebuilt from records in HEAD, not a mutable session cursor.
  privateDirectory(join(repo.stateDir, 'finalized'));
  atomicWrite(join(repo.stateDir, 'finalized', `${tx.record_id}.json`), json({ record_id: tx.record_id, commit }));
  tx.phase = 'finalized'; atomicWrite(transactionPath(repo), json(tx));
  rmSync(transactionPath(repo)); syncDirectory(repo.stateDir);
  return { commit, record_id: tx.record_id, capture_status: result.capture_status };
}

function recoverPending(repo: Repo) {
  const tx = pending(repo);
  // Search retained refs and reflogs as well as HEAD: a later hook may have moved the branch.
  const candidates = git(repo.root, ['log', '--all', '--reflog', '--format=%H', '--fixed-strings', `--grep=Reasoning-Record: ${tx.record_id}`])
    .trim().split('\n').filter(Boolean);
  if (tx.commit) candidates.unshift(tx.commit);
  const unique = [...new Set(candidates)];
  if (unique.length > 1) throw new Error('Multiple commits reference the pending record; preserve state and resolve the ambiguity');
  if (unique.length) return { ...finalize(repo, tx, unique[0]), recovered: true };
  if (head(repo) !== tx.parent) throw new Error('HEAD moved without a verifiable record; preserve transaction for manual recovery');
  if (tx.phase !== 'prepared') throw new Error('Finalized commit is unavailable; preserve transaction for manual recovery');
  cleanFailed(repo, tx);
  return { recovered: true, committed: false, events_retained: true };
}

export function recover(repo: Repo) {
  if (process.env.GIT_INDEX_FILE) throw new Error('Recovery requires the normal worktree index');
  return locked(repo, () => existsSync(transactionPath(repo)) ? recoverPending(repo) : { recovered: false, pending: false });
}

export function prepareCommit(repo: Repo, task?: string, noActivity = false, originalHooks?: string, nativeMode = false, override?: string) {
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    if (existsSync(resolve(repo.root, git(repo.root, ['rev-parse', '--git-path', marker]).trim()))) throw new Error('Merge/rebase/cherry-pick/revert transactions are not supported');
  }
  const hookConfig = spawnSync('git', ['config', '--get-regexp', '^hook[.]'], { cwd: repo.root, encoding: 'utf8' });
  if (hookConfig.status !== 1) throw new Error('Config-based Git hooks are not yet supported; existing hooks were not changed');
  if (git(repo.root, ['diff', '--cached', '--name-only', '--', '.ai-history/records']).length) {
    throw new Error('Archive changes are already staged; controlled commits only add their own new record');
  }
  let stagedPolicy: ReturnType<typeof config>;
  try { stagedPolicy = JSON.parse(git(repo.root, ['show', ':.ai-history/config.json'])); }
  catch { throw new Error('Stage .ai-history/config.json before the first controlled commit'); }
  if (JSON.stringify(stagedPolicy) !== JSON.stringify(config(repo))) throw new Error('Staged policy differs from the working configuration');
  if (!staged(repo).paths.length) throw new Error('No staged code or policy changes to commit');
  const version = /git version (\d+)\.(\d+)/.exec(git(repo.root, ['--version']));
  if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 43) throw new Error('Controlled commits require Git 2.43 or later');
  const parent = head(repo);
  const record = commitPreview(repo, task, noActivity);
  if (override !== undefined) {
    if (!override.trim() || override.length > 4096) throw new Error('Capture override must contain 1–4096 characters');
    record.manifest.capture_override = redact(override).text;
    record.reasoning += `\nCapture policy override (explicit caller statement): ${record.manifest.capture_override}\n`;
    record.manifest.files['reasoning.txt'] = hash(record.reasoning);
  }
  if (config(repo).mode === 'strict' && record.manifest.capture_status !== 'no_assistant_activity' && !override) throw new Error('Strict policy blocks partial/unavailable capture; resolve gaps or use --allow-partial with a recorded reason');
  if (record.manifest.capture_status !== 'no_assistant_activity') process.stderr.write('reasoning: capture is ' + record.manifest.capture_status + '; review the saved coverage and omissions.\n');
  if (head(repo) !== parent) throw new Error('HEAD changed during preparation; retry');
  const tx: Transaction = { schema_version: 1, phase: 'prepared', record_id: record.manifest.record_id,
    ref: currentRef(repo), parent, tree: null, commit: null,
    original_hooks: originalHooks ?? git(repo.root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']).trim(),
    native: nativeMode, ...identity(repo), files: { 'reasoning.txt': hash(record.reasoning), 'events.jsonl': hash(record.eventData), 'manifest.json': hash(json(record.manifest)) } };
  atomicWrite(transactionPath(repo), json(tx));
  try {
    writeRecord(repo, record);
    git(repo.root, ['add', '--', ...FILES.map(file => pathFor(tx.record_id, file))]);
    for (const file of FILES) {
      if (!git(repo.root, ['ls-files', '--stage', '--', pathFor(tx.record_id, file)]).startsWith('100644 ') || hash(git(repo.root, ['show', `:${pathFor(tx.record_id, file)}`])) !== tx.files[file]) throw new Error('Git attributes transformed an archive file; use unchanged UTF-8 archive content');
    }
    if (staged(repo).fingerprint !== record.manifest.staged_code_fingerprint) throw new Error('Staging changed during preparation');
    tx.tree = git(repo.root, ['write-tree']).trim(); atomicWrite(transactionPath(repo), json(tx));
    return tx;
  } catch (error) { cleanFailed(repo, tx); throw error; }
}

export function commit(repo: Repo, message: string, task?: string, noActivity = false, override?: string) {
  if (!message.trim() || message.includes('\0') || /^Reasoning-Record:/mi.test(message)) throw new Error('Provide a nonempty message without a Reasoning-Record trailer');
  if (process.env.GIT_INDEX_FILE) throw new Error('Controlled commits currently require the normal worktree index');
  return locked(repo, () => {
    if (existsSync(transactionPath(repo))) return recoverPending(repo); // Never retry a code commit before reconciliation.
    const tx = prepareCommit(repo, task, noActivity, installedNative(repo)?.original_hooks, false, override);
    try {
      const hooks = join(repo.stateDir, 'commit-hooks'); privateDirectory(hooks);
      const cli = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url));
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      for (const name of HOOKS) {
        const path = join(hooks, name);
        atomicWrite(path, `#!/bin/sh\nexec ${quote(process.execPath.replaceAll('\\', '/'))} ${quote(cli.replaceAll('\\', '/'))} internal-hook ${name} "$@"\n`);
        chmodSync(path, 0o755);
      }
      const messagePath = join(repo.stateDir, 'commit-message');
      atomicWrite(messagePath, `${message.trimEnd()}\n\nReasoning-Record: ${tx.record_id}\n`);
      const result = spawnSync('git', ['-c', `core.hooksPath=${hooks}`, 'commit', '--cleanup=verbatim', '-F', messagePath], {
        cwd: repo.root, encoding: 'utf8', env: { ...process.env, REASONING_TRANSACTION: tx.record_id }, stdio: ['inherit', 'pipe', 'pipe'],
      });
      if (result.stdout) process.stderr.write(redact(result.stdout).text);
      if (result.stderr) process.stderr.write(redact(result.stderr).text);
      if (result.status !== 0) throw new Error('Git commit failed; imported events remain available');
      return finalize(repo, tx, head(repo)!);
    } catch (error) {
      // A failed Git process may already have created a commit. Never remove its record or retry blindly.
      if (head(repo) === tx.parent && tx.phase === 'prepared') {
        const possible = git(repo.root, ['log', '--all', '--reflog', '--format=%H', '--fixed-strings', `--grep=Reasoning-Record: ${tx.record_id}`]).trim();
        if (!possible) cleanFailed(repo, tx);
      }
      throw error;
    }
  });
}
