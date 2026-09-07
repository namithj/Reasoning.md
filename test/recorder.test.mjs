import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, jsonl, parseLines, redact } from '../src/schema.ts';
import { config, initialize, locked, repository } from '../src/storage.ts';
import { exportSnapshot, ingest, journal, snapshot, staged, status } from '../src/recorder.ts';
import { probe } from '../src/probe.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = readFileSync(join(root, 'test/fixtures/conversation.jsonl'), 'utf8');
const inputs = () => parseLines(fixture);

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reasoning-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'hooks'));
  return dir;
}

function runGit(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Recorder Test', '-c', 'user.email=recorder@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(cwd, 'disabled-test-hooks')}`, ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setup(t) {
  const base = sandbox(t);
  const cwd = join(base, 'repo with spaces');
  mkdirSync(cwd);
  runGit(cwd, 'init', '-b', 'main');
  const repo = repository(cwd);
  initialize(repo, 'private');
  return { repo, base, cwd };
}

test('replay keeps one prompt, reply, tool call and result, including resumed surfaces', t => {
  const { repo } = setup(t);
  assert.equal(ingest(repo, fixture).added, 4);
  const resumed = inputs().map(e => ({ ...e, source: { ...e.source, surface: 'cli', host_version: 'new-runtime' } }));
  assert.deepEqual(ingest(repo, jsonl(resumed)), { added: 0, duplicates: 4, total: 4, capture_status: 'partial' });
  assert.equal(new Set(journal(repo).map(e => e.event_id)).size, 4);
  assert.equal(journal(repo)[2].tool_call_id, journal(repo)[3].tool_call_id);
  assert.equal(status(repo).capture_status, 'partial');
});

test('whole batch validation and conflicting replays leave journal byte-for-byte unchanged', t => {
  const { repo } = setup(t);
  ingest(repo, fixture);
  const path = join(repo.stateDir, 'journal.jsonl');
  const before = readFileSync(path);
  assert.throws(() => ingest(repo, fixture + '{bad json}\n'), /Invalid JSON/);
  const changed = inputs(); changed[0].content = 'A different request';
  assert.throws(() => ingest(repo, jsonl(changed)), /Conflicting replay/);
  const clash = inputs()[0]; clash.source.event_id = 'another-id';
  assert.throws(() => ingest(repo, jsonl([clash])), /same session sequence/);
  assert.deepEqual(readFileSync(path), before);
});

test('unsupported input formats fail visibly rather than claiming empty complete capture', t => {
  const { repo } = setup(t);
  const bad = inputs()[0]; bad.schema_version = 99;
  assert.throws(() => ingest(repo, jsonl([bad])), /Unsupported event schema/);
  assert.throws(() => ingest(repo, jsonl([{ role: 'assistant', text: 'raw transcript' }])), /unsupported fields/);
  assert.equal(status(repo).capture_status, 'unavailable');
  assert.equal(journal(repo).length, 0);
});

test('common credentials disappear from journal and all exported files', t => {
  const { repo } = setup(t);
  const secrets = ['ghp_' + 'x'.repeat(30), 'sk-proj-' + 'y'.repeat(30), 'AKIA' + 'Z'.repeat(16),
    'top-secret-password', 'base64bearersecret', 'PRIVATEKEYCONTENTS', 'url-pass'];
  const event = inputs()[0];
  event.content = `${secrets[0]} ${secrets[1]} ${secrets[2]}\npassword="${secrets[3]}"\nAuthorization: Bearer ${secrets[4]}\n-----BEGIN RSA PRIVATE KEY-----\n${secrets[5]}\n-----END RSA PRIVATE KEY-----\nhttps://user:${secrets[6]}@example.invalid`;
  event.source.locator = 'fixture?token=locator-secret';
  ingest(repo, jsonl([event]));
  const exported = exportSnapshot(repo);
  const data = readFileSync(join(repo.stateDir, 'journal.jsonl'), 'utf8') +
    readdirSync(exported.directory).map(name => readFileSync(join(exported.directory, name), 'utf8')).join('');
  for (const secret of [...secrets, 'locator-secret']) assert.ok(!data.includes(secret), `Unexpected secret: ${secret.slice(0, 3)}`);
  assert.match(data, /REDACTED/);
  assert.equal(JSON.parse(readFileSync(join(exported.directory, 'manifest.json'))).redaction_summary.affected_events, 1);
});

test('oversized, binary and environment dumps have explicit omission markers', t => {
  const { repo } = setup(t);
  const events = inputs().slice(0, 3);
  events[0].content = 'a'.repeat(20000);
  events[1].content = 'binary\0value';
  events[2].content = 'PATH=/private/path\nUSER=private-name\nCUSTOM_ENV=private-value';
  ingest(repo, jsonl(events));
  const data = JSON.stringify(journal(repo));
  assert.ok(!data.includes('private-value'));
  assert.match(data, /content_limit/); assert.match(data, /binary_content/); assert.match(data, /environment_dump/);
  assert.equal(snapshot(repo).manifest.redaction_summary.omitted_events, 3);
});

test('partial staging and exports leave user index and working copy unchanged', t => {
  const { repo, cwd } = setup(t);
  writeFileSync(join(cwd, 'app.txt'), 'original\n');
  runGit(cwd, 'add', 'app.txt'); runGit(cwd, 'commit', '-m', 'fixture base');
  writeFileSync(join(cwd, 'app.txt'), 'staged version\n'); runGit(cwd, 'add', 'app.txt');
  writeFileSync(join(cwd, 'app.txt'), 'unstaged later edit\n');
  writeFileSync(join(cwd, 'unrelated.txt'), 'untracked\n');
  ingest(repo, fixture);
  const before = readFileSync(join(repo.gitDir, 'index'));
  const record = snapshot(repo);
  assert.deepEqual(record.manifest.staged_code_paths, ['app.txt']);
  assert.match(record.reasoning, /Unstaged changes exist/);
  const exported = exportSnapshot(repo);
  assert.equal(exported.staged, false);
  assert.deepEqual(readFileSync(join(repo.gitDir, 'index')), before);
  assert.equal(readFileSync(join(cwd, 'app.txt'), 'utf8'), 'unstaged later edit\n');
  assert.equal(journal(repo).length, 4);
  const manifest = JSON.parse(readFileSync(join(exported.directory, 'manifest.json')));
  for (const [file, digest] of Object.entries(manifest.files)) assert.equal(hash(readFileSync(join(exported.directory, file))), digest);
});

test('fingerprint changes with staged content and excludes generated records', t => {
  const { repo, cwd } = setup(t);
  writeFileSync(join(cwd, 'code.txt'), 'one'); runGit(cwd, 'add', 'code.txt');
  const before = staged(repo).fingerprint;
  ingest(repo, fixture); const record = exportSnapshot(repo);
  runGit(cwd, 'add', '.ai-history/records');
  assert.equal(staged(repo).fingerprint, before);
  writeFileSync(join(cwd, 'code.txt'), 'two'); runGit(cwd, 'add', 'code.txt');
  assert.notEqual(staged(repo).fingerprint, before);
  assert.ok(existsSync(record.directory));
});

test('fresh clone can read manually committed snapshots without local journal or host', t => {
  const { repo, cwd, base } = setup(t);
  ingest(repo, fixture); const record = exportSnapshot(repo);
  runGit(cwd, 'add', '.ai-history');
  runGit(cwd, 'commit', '-m', 'Fixture snapshot, deliberately not a controlled recorder commit');
  const clone = join(base, 'clone'); runGit(base, 'clone', cwd, clone);
  const text = runGit(clone, 'show', `HEAD:.ai-history/records/${record.record_id}/reasoning.txt`);
  assert.match(text, /Make the greeting more friendly/);
  assert.equal(journal(repository(clone)).length, 0);
  assert.equal(config(repository(clone)).repository_id, config(repo).repository_id);
  initialize(repository(clone), 'private');
  assert.equal(readFileSync(join(repository(clone).commonState, 'repository-id'), 'utf8').trim(), config(repo).repository_id);
});

test('two assistants keep provenance; multiple tasks require explicit selection', t => {
  const { repo } = setup(t);
  ingest(repo, fixture);
  const other = inputs().map(e => ({ ...e, source: { ...e.source, tool: 'claude-code' } }));
  ingest(repo, jsonl(other));
  assert.equal(snapshot(repo).manifest.source_sessions.length, 2);
  const unrelated = inputs()[0]; unrelated.task_id = 'another-task'; unrelated.source.session_id = 'unrelated';
  ingest(repo, jsonl([unrelated]));
  assert.throws(() => snapshot(repo), /Multiple tasks/);
  assert.equal(snapshot(repo, 'demo-task').manifest.capture_boundary.event_ids.length, 8);
  assert.throws(() => snapshot(repo, 'missing-task'), /No imported events/);
});

test('late imports sort by source sequence and gaps and compaction stay explicit', t => {
  const { repo } = setup(t);
  const events = inputs(); events[2].type = 'compaction_boundary';
  ingest(repo, jsonl([events[3], events[0]]));
  assert.match(snapshot(repo).reasoning, /Sequence gaps/);
  ingest(repo, jsonl([events[2], events[1]]));
  const record = snapshot(repo);
  assert.doesNotMatch(record.reasoning, /Sequence gaps/);
  assert.deepEqual(record.eventData.trim().split('\n').map(line => JSON.parse(line).sequence), [0, 1, 2, 3]);
  assert.match(record.reasoning, /compaction_boundary/);
  assert.equal(record.manifest.capture_status, 'partial');
});

test('worktrees have separate journals and share repository identity', t => {
  const { repo, cwd, base } = setup(t);
  runGit(cwd, 'add', '.ai-history/config.json'); runGit(cwd, 'commit', '-m', 'fixture policy');
  const second = join(base, 'second'); runGit(cwd, 'worktree', 'add', '-b', 'second', second);
  const sibling = repository(second); initialize(sibling, 'private');
  ingest(repo, fixture);
  assert.equal(journal(sibling).length, 0);
  assert.equal(config(repo).repository_id, config(sibling).repository_id);
  ingest(sibling, fixture);
  assert.notEqual(journal(repo)[0].worktree_id, journal(sibling)[0].worktree_id);
});

test('alternate Git index is read without touching the normal index', t => {
  const { repo, cwd } = setup(t);
  writeFileSync(join(cwd, 'normal.txt'), 'normal'); runGit(cwd, 'add', 'normal.txt');
  const before = readFileSync(join(repo.gitDir, 'index'));
  const prior = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = join(repo.gitDir, 'alternate-index');
  try {
    writeFileSync(join(cwd, 'alternate.txt'), 'alternate'); runGit(cwd, 'add', 'alternate.txt');
    assert.deepEqual(staged(repo).paths, ['alternate.txt']);
    assert.deepEqual(readFileSync(join(repo.gitDir, 'index')), before);
  } finally {
    if (prior === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = prior;
  }
});

test('live lock and damaged journal block writes without discarding events', t => {
  const { repo } = setup(t);
  ingest(repo, fixture);
  locked(repo, () => assert.throws(() => ingest(repo, fixture), /Recorder is locked/));
  const path = join(repo.stateDir, 'journal.jsonl');
  const damaged = readFileSync(path, 'utf8') + '{unfinished'; writeFileSync(path, damaged);
  assert.throws(() => ingest(repo, fixture), /Incomplete local journal/);
  assert.equal(readFileSync(path, 'utf8'), damaged);
});

test('symlinked archive directory is rejected without writing outside the repository', { skip: process.platform === 'win32' }, t => {
  const { repo, cwd, base } = setup(t);
  const target = join(base, 'external'); mkdirSync(target);
  symlinkSync(target, join(cwd, '.ai-history', 'records'));
  assert.throws(() => exportSnapshot(repo), /never a symlink/);
  assert.deepEqual(readdirSync(target), []);
});

test('probe reports missing transcript and foreign worktree without retaining message bodies', t => {
  const { cwd, base } = setup(t);
  const report = probe('codex', cwd, { hook_event_name: 'Stop', cwd: base,
    transcript_path: null, last_assistant_message: 'secret-message-body', session_id: 'secret-session-id' }, join(base, 'empty-extensions'));
  assert.equal(report.hook.transcript, 'not_provided');
  assert.equal(report.hook.worktree_association, 'inaccessible');
  assert.equal(report.hook.final_reply_field_present, true);
  assert.equal(report.capture_gate, 'unverified');
  assert.equal(report.automatic_capture, 'unverified');
  assert.ok(!JSON.stringify(report).includes('secret-'));
  assert.throws(() => probe('unknown', cwd), /Unknown host/);
});

test('CLI validates arguments and exposes a working import/preview/export workflow', t => {
  const { cwd } = setup(t);
  const cli = (...args) => execFileSync(process.execPath, [join(root, 'src/cli.ts'), ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(cli('--help'), /Host capture and native Git hooks are opt-in/);
  assert.equal(JSON.parse(cli('import', '--input', join(root, 'test/fixtures/conversation.jsonl'))).added, 4);
  assert.match(cli('preview', '--staged'), /Make the greeting more friendly/);
  assert.equal(JSON.parse(cli('export', '--staged')).committed, false);
  assert.throws(() => cli('preview'), /Command failed/);
  assert.throws(() => cli('status', '--publication', 'public'), /Command failed/);
});

test('redaction is stable across repeated export scans', () => {
  const sample = 'password="sample secret"\nAuthorization: Bearer abcdefghijklmnop\nhttps://me:secret@example.invalid';
  assert.equal(redact(redact(sample).text).text, redact(sample).text);
});
