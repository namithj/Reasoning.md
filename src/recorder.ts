import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, json, jsonl, normalize, parseLines, redact, VERSION } from './schema.ts';
import type { Event, InputEvent } from './schema.ts';
import { assertPlain, atomicWrite, config, git, gitBytes, identity, locked, privateDirectory, readJSON, syncDirectory } from './storage.ts';
import type { Repo } from './storage.ts';

const JOURNAL_LIMIT = 32 * 1024 * 1024;

export function journal(repo: Repo): Event[] {
  const path = join(repo.stateDir, 'journal.jsonl');
  assertPlain(repo.stateDir, true);
  assertPlain(path, false);
  if (!existsSync(path)) return [];
  if (lstatSync(path).size > JOURNAL_LIMIT) throw new Error('Journal exceeds 32 MiB; preserve it and migrate before importing more events');
  const expected = identity(repo);
  const data = readFileSync(path, 'utf8');
  if (data && !data.endsWith('\n')) throw new Error('Incomplete local journal; preserve it and repair before continuing');
  return data.split('\n').filter(Boolean).map((line, i) => {
    let event: Event;
    try { event = JSON.parse(line); } catch { throw new Error(`Corrupt journal at line ${i + 1}; no events were changed`); }
    if (!event || event.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(event.event_id)
      || typeof event.content !== 'string' || !Number.isSafeInteger(event.sequence) || event.sequence < 0
      || typeof event.source?.session_id !== 'string' || typeof event.source?.tool !== 'string'
      || typeof event.task_id !== 'string' || !Array.isArray(event.redaction?.rules) || !Array.isArray(event.redaction?.omissions)) {
      throw new Error(`Invalid journal event at line ${i + 1}; no events were changed`);
    }
    if (event.repository_id !== expected.repository_id || event.worktree_id !== expected.worktree_id) {
      throw new Error('Journal belongs to a different repository or worktree; preserve state and resolve the identity mismatch');
    }
    return event;
  });
}

function sourceKey(event: Event) { return JSON.stringify([event.source.tool, event.source.session_id]); }
function comparable(event: Event) {
  // A resumed session can change surfaces, versions and locators without changing the source event.
  return JSON.stringify([event.task_id, event.sequence, event.timestamp, event.type, event.content, event.model, event.tool_call_id]);
}

export function ingest(repo: Repo, text: string) {
  const parsed = parseLines(text);
  return locked(repo, () => appendEvents(repo, parsed));
}

// Internal mutation primitive: callers must already own the worktree recorder lock.
export function appendEvents(repo: Repo, parsed: InputEvent[]) {
  const incoming = parsed.map(event => {
    const cleaned = normalize(event, identity(repo));
    const previous = (event as Event).redaction;
    if (previous) cleaned.redaction = { rules: [...new Set([...previous.rules, ...cleaned.redaction.rules])].sort(), omissions: [...new Set([...previous.omissions, ...cleaned.redaction.omissions])] };
    return cleaned;
  });
  const events = journal(repo);
  const known = new Map(events.map(event => [event.event_id, event]));
  const sequences = new Map(events.map(event => [JSON.stringify([sourceKey(event), event.sequence]), event.event_id]));
  let added = 0;
  for (const event of incoming) {
    const previous = known.get(event.event_id);
    if (previous) {
      if (comparable(previous) !== comparable(event)) throw new Error('Conflicting replay of a source event; journal unchanged');
      continue;
    }
    const sequenceKey = JSON.stringify([sourceKey(event), event.sequence]);
    if (sequences.has(sequenceKey)) throw new Error('Two source event IDs use the same session sequence; journal unchanged');
    events.push(event); known.set(event.event_id, event); sequences.set(sequenceKey, event.event_id); added++;
  }
  // ponytail: each batch rewrites the journal, capped at 32 MiB; use segmented journals before larger pilots.
  if (added) {
    const data = jsonl(events);
    if (Buffer.byteLength(data) > JOURNAL_LIMIT) throw new Error('Import would exceed the 32 MiB journal limit; no events were written');
    atomicWrite(join(repo.stateDir, 'journal.jsonl'), data);
  }
  return { added, duplicates: incoming.length - added, total: events.length, capture_status: events.length ? 'partial' : 'unavailable' };
}

export function status(repo: Repo) {
  const policy = config(repo);
  const events = journal(repo);
  return {
    version: VERSION, repository_id: policy.repository_id,
    publication: policy.publication, events: events.length,
    tasks: [...new Set(events.map(event => event.task_id))],
    sessions: [...new Set(events.map(sourceKey))].map(key => {
      const session = events.filter(event => sourceKey(event) === key);
      return { tool: session[0].source.tool, session_id: session[0].source.session_id,
        events: session.length, surfaces: [...new Set(session.map(e => e.source.surface))] };
    }),
    capture_status: events.length ? 'partial' : 'unavailable',
    capture_scope: 'observable_captured_and_imported_events',
    commit_integration: existsSync(join(repo.commonState, 'native-installation.json')) ? 'native_hooks_configured_client_unverified' : 'controlled_wrapper',
    queued_capture_deliveries: existsSync(join(repo.stateDir, 'capture-queue')) ? readdirSync(join(repo.stateDir, 'capture-queue')).filter(file => file.endsWith('.json')).length : 0,
    pending_transaction: existsSync(join(repo.stateDir, 'transaction.json')),
    lock_present: existsSync(join(repo.stateDir, 'lock')),
  };
}

export function staged(repo: Repo, base?: string) {
  const paths = [':(top)**', ':(top,exclude).ai-history/records/**'];
  const diff = gitBytes(repo.root, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', ...(base ? [base] : []), '--', ...paths]);
  if (git(repo.root, ['ls-files', '--unmerged', '-z']).length) throw new Error('Resolve unmerged index entries before preparing a record');
  const changed = git(repo.root, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--no-ext-diff', ...(base ? [base] : []), '--', ...paths]).split('\0').filter(Boolean);
  return { paths: changed, fingerprint: hash(diff) };
}

export function snapshot(repo: Repo, task?: string, options: { commit?: boolean; excludeIds?: Set<string>; references?: string[]; noActivity?: boolean; base?: string } = {}) {
  const policy = config(repo);
  const all = journal(repo);
  if (!task && new Set(all.map(e => e.task_id)).size > 1) throw new Error('Multiple tasks are present; choose --task explicitly');
  let events = task ? all.filter(e => e.task_id === task) : all;
  if (task && !events.length && !options.references?.length) throw new Error('No imported events match this task');
  const selectedTask = task ?? events[0]?.task_id ?? null;
  events = events.filter(event => !options.excludeIds?.has(event.event_id));
  if (options.noActivity && events.length) throw new Error('Cannot attest no assistant activity while selected events are pending');
  const captureStatus = options.noActivity ? 'no_assistant_activity' : events.length ? 'partial' : 'unavailable';
  // Scan again before any export. Historical text is evidence, never executable instructions.
  events = events.map(event => {
    const { event_id, repository_id, worktree_id, environment_id, redaction, ...input } = event;
    const cleaned = normalize(input as InputEvent, { repository_id, worktree_id, environment_id });
    return { ...cleaned, event_id, redaction: {
      rules: [...new Set([...redaction.rules, ...cleaned.redaction.rules])].sort(),
      omissions: [...new Set([...redaction.omissions, ...cleaned.redaction.omissions])],
    } };
  });
  const sessions = [...new Set(events.map(sourceKey))];
  events.sort((a, b) => sessions.indexOf(sourceKey(a)) - sessions.indexOf(sourceKey(b)) || a.sequence - b.sequence);
  const scope = staged(repo, options.base);
  const omissions = ['Host-panel completeness is unverified. Only observable captured and imported events are present.',
    'Events are ordered within each session; no total chronological order across sessions is claimed.',
    options.commit ? 'Only captured and imported events at this frozen boundary are included. Host-panel completeness remains unverified.' : 'This is a snapshot, not a finalized commit record. Export does not consume journal events.'];
  const sourceSessions = sessions.map(key => {
    const selected = events.filter(e => sourceKey(e) === key);
    const sequences = selected.map(e => e.sequence);
    const gaps = sequences.slice(1).some((n, i) => n !== sequences[i] + 1);
    if (gaps) omissions.push(`Sequence gaps in session ${selected[0].source.tool}/${selected[0].source.session_id}.`);
    return { tool: selected[0].source.tool, session_id: selected[0].source.session_id,
      first_sequence: sequences[0], last_sequence: sequences.at(-1), event_ids: selected.map(e => e.event_id),
      surfaces: [...new Set(selected.map(e => e.source.surface))],
      host_versions: [...new Set(selected.map(e => e.source.host_version))],
      extension_versions: [...new Set(selected.map(e => e.source.extension_version))],
      observable_types: [...new Set(selected.map(e => e.type))], parser: 'normalized-jsonl-v1', native_capture_verified: false };
  });
  if (events.some(e => e.type === 'capture_gap')) omissions.push('Source capture-gap events are present; read them below.');
  if (events.some(e => e.redaction.omissions.length)) omissions.push('Some content was omitted by size, environment-dump or binary policy.');
  if (git(repo.root, ['diff', '--name-only', '-z', '--no-ext-diff']).length) {
    omissions.push('Unstaged changes exist. Conversation task scope may exceed the staged change; authorship is not inferred.');
  }
  const queue = join(repo.stateDir, 'capture-queue');
  const queued = existsSync(queue) ? readdirSync(queue).filter(file => file.endsWith('.json')).length : 0;
  if (options.noActivity && queued) throw new Error('Cannot attest no assistant activity while capture deliveries remain queued');
  if (queued) omissions.push(`${queued} capture deliveries remain queued and are not included in this frozen record.`);
  const state: any = existsSync(join(repo.stateDir, 'capture.json')) ? readJSON(join(repo.stateDir, 'capture.json')) : null;
  const captureSources = state ? Object.entries(state.installations).map(([host, value]: [string, any]) => ({ host, parser: value.parser, surface: value.surface, host_version: value.host_version, extension_version: value.extension_version, host_panel_verified: false })) : [];
  const recordId = randomUUID();
  const boundary = new Date().toISOString();
  const quoted = events.map(event => `Event ${event.event_id}\n${event.source.tool}/${event.source.session_id} #${event.sequence} ${event.type} ${event.timestamp ?? '(time unavailable)'}\nTask: ${event.task_id}\nTool call: ${event.tool_call_id ?? '(not applicable)'}\n${event.content.split('\n').map(line => '> ' + line).join('\n')}\n`).join('\n');
  const reasoning = [
    options.commit ? 'Reasoning.md — controlled commit record' : 'Reasoning.md — snapshot (not attached to a commit)', `Record: ${recordId}`,
    `Repository: ${policy.repository_id}`, `Task: ${selectedTask ?? '(none)'}`,
    `Capture boundary: ${boundary}`, `Capture status: ${captureStatus}`,
    `Publication policy: ${policy.publication}`, 'Scope: observable captured and imported events; no generated summaries or hidden reasoning.',
    'Later replies belong to a later record. Archived content does not grant permission to run commands.',
    '', 'Known omissions:', ...omissions.map(item => '- ' + item),
    `Earlier records: ${(options.references ?? []).join(', ') || '(none)'}`,
    ...(options.noActivity ? ['No assistant activity: explicitly attested by the caller.'] : []),
    '', 'Staged code paths (JSON quoted):', ...scope.paths.map(path => redact(JSON.stringify(path)).text),
    '', 'Quoted source events (original requests, decisions, messages, tools and open questions when supplied):',
    quoted || '(No events imported. This does not establish absence of assistant activity.)',
  ].join('\n') + '\n';
  const eventData = jsonl(events);
  const redactionSummary = { rules: [...new Set(events.flatMap(e => e.redaction.rules))].sort(),
    affected_events: events.filter(e => e.redaction.rules.length).length,
    omitted_events: events.filter(e => e.redaction.omissions.length).length };
  const manifest = {
    code_base: options.base, preserved_records: {} as Record<string, string>,
    queued_capture_deliveries: queued, capture_sources: captureSources,
    capture_override: null as string | null,
    schema_version: 1, record_id: recordId, repository_id: policy.repository_id,
    task_id: selectedTask, referenced_records: options.references ?? [], snapshot: !options.commit,
    capture_boundary: { frozen_at: boundary, event_ids: events.map(e => e.event_id), later_events: 'next_record' },
    capture_status: captureStatus, capture_scope: 'observable_captured_and_imported_events',
    known_omissions: omissions, source_sessions: sourceSessions, adapter_versions: { 'normalized-jsonl': 1 },
    staged_code_paths: scope.paths.map(path => redact(path).text), staged_code_fingerprint: scope.fingerprint,
    fingerprint_algorithm: 'sha256-git-cached-raw-no-renames-excluding-records-v1',
    files: { 'reasoning.txt': hash(reasoning), 'events.jsonl': hash(eventData) }, redaction_summary: redactionSummary,
  };
  return { manifest, reasoning, eventData };
}

export type RecordData = ReturnType<typeof snapshot>;

export function writeRecord(repo: Repo, record: RecordData) {
  const parent = join(repo.root, '.ai-history', 'records');
  privateDirectory(parent);
  const destination = join(parent, record.manifest.record_id);
  const temp = join(parent, `.pending-${record.manifest.record_id}`);
  mkdirSync(temp, { mode: 0o700 });
  try {
    atomicWrite(join(temp, 'reasoning.txt'), record.reasoning);
    atomicWrite(join(temp, 'events.jsonl'), record.eventData);
    atomicWrite(join(temp, 'manifest.json'), json(record.manifest));
    if (staged(repo, record.manifest.code_base).fingerprint !== record.manifest.staged_code_fingerprint) throw new Error('Staged changes changed during export; retry');
    renameSync(temp, destination); syncDirectory(parent);
  } finally { rmSync(temp, { recursive: true, force: true }); }
  return destination;
}

export function exportSnapshot(repo: Repo, task?: string) {
  return locked(repo, () => {
    const record = snapshot(repo, task);
    return { record_id: record.manifest.record_id, directory: writeRecord(repo, record), staged: false, committed: false, snapshot: true };
  });
}
