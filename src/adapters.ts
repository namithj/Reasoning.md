import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, rmSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvents, journal } from './recorder.ts';
import { atomicWrite, config, identity, locked, privateDirectory, readJSON, repository, assertPlain, environment, syncDirectory } from './storage.ts';
import type { Repo } from './storage.ts';
import { hash, identifier, json, normalize, object, parseInput, redact } from './schema.ts';
import type { InputEvent, EventType } from './schema.ts';
import { bindingKey, tasks } from './history.ts';

export const ADAPTERS = {
  'claude-code': { tool: 'claude-code', parser: 'claude-jsonl-v1', config: '.claude/settings.local.json' },
  codex: { tool: 'codex', parser: 'codex-rollout-v1', config: '.codex/hooks.json' },
  'copilot-vscode': { tool: 'copilot', parser: 'copilot-events-v1', config: '.github/hooks/reasoning-vscode.json' },
  'copilot-cli': { tool: 'copilot', parser: 'copilot-events-v1', config: '.github/hooks/reasoning-cli.json' },
  'copilot-cloud': { tool: 'copilot', parser: 'copilot-events-v1', config: '.github/hooks/reasoning-cloud.json' },
  'codex-desktop': { tool: 'codex', parser: 'codex-rollout-v1', config: null },
  'chatgpt-export': { tool: 'chatgpt', parser: 'chatgpt-export-v1', config: null },
} as const;
export type Adapter = keyof typeof ADAPTERS;
type Parsed = { model?: string | null; id: string; type: EventType; content: string; timestamp: string | null; tool_call_id: string | null };
type Installation = { hook_entry?: Record<string, unknown>; node_executable?: string; recorder_executable?: string; parser: string; surface: InputEvent['source']['surface']; host_version: string | null; extension_version: string | null; config_root?: string | null; workspace_root?: string; config_path: string | null; command: string | null };
type CaptureState = { schema_version: 1; installations: Record<string, Installation>; sessions: Record<string, {
  task: string; aliases: Record<string, string>; provisional: string[]; last_capture: string; transcript: string | null;
  host: string; session: string; gaps: string[]; observed: string[]; deliveries: number;
}> };

export function captureState(repo: Repo): CaptureState {
  const path = join(repo.stateDir, 'capture.json');
  if (!existsSync(path)) return { schema_version: 1, installations: {}, sessions: {} };
  const value = readJSON(path) as CaptureState;
  if (value.schema_version !== 1 || !value.installations || !value.sessions) throw new Error('Invalid capture state');
  return value;
}
function adapter(host: string): Adapter {
  if (!Object.hasOwn(ADAPTERS, host)) throw new Error('Unknown adapter');
  return host as Adapter;
}
const iso = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
const text = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value ?? null);
const parsed = (id: string, type: EventType, content: unknown, timestamp: unknown, call: string | null = null): Parsed => ({ id, type, content: text(content), timestamp: iso(timestamp), tool_call_id: call });

function associatedPath(path: unknown, repo: Repo, workspaceRoot = repo.root) {
  if (typeof path !== 'string' || !isAbsolute(path)) return false;
  try { if (repository(path).root === repo.root) return true; } catch { /* A workspace parent need not be a Git checkout. */ }
  try { return realpathSync(path) === realpathSync(workspaceRoot); } catch { return false; }
}

// These parsers accept declared, versioned formats only. A host upgrade is not evidence of compatibility.
export function parseTranscript(host: Adapter, parser: string, data: string, session: string, cwd: string, workspaceRoot = cwd): Parsed[] {
  if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new Error('Transcript exceeds the 32 MiB parser limit');
  if (parser === 'none') throw new Error('No verified transcript parser is available for this host');
  if (parser !== ADAPTERS[host].parser) throw new Error('Unsupported parser version for this host');
  if (parser === 'chatgpt-export-v1') {
    let source;
    try { source = JSON.parse(data); } catch { throw new Error('Invalid ChatGPT export JSON'); }
    const conversations = Array.isArray(source) ? source : [source];
    const conversation = conversations.find(item => item?.id === session || item?.conversation_id === session);
    if (!conversation?.mapping || !conversation.current_node) throw new Error('Select a conversation with a current_node and mapping');
    const seen = new Set<string>(); const branch: any[] = []; let node = conversation.current_node;
    while (node) {
      if (seen.has(node) || seen.size > 100000) throw new Error('Invalid cyclic or oversized export');
      seen.add(node); const item = conversation.mapping[node];
      if (!item) throw new Error('Missing export parent node');
      if (item.message) branch.unshift(item.message); node = item.parent;
    }
    return branch.flatMap(message => {
      const role = message.author?.role;
      if (!['user', 'assistant', 'tool'].includes(role) || message.channel === 'analysis' || message.metadata?.is_visually_hidden_from_conversation) return [];
      if (message.content?.content_type !== 'text' || !Array.isArray(message.content.parts) || !message.content.parts.every((part: unknown) => typeof part === 'string')) {
        return [parsed(String(message.id), 'capture_gap', 'Non-text export content omitted.', message.create_time * 1000)];
      }
      return [parsed(identifier(message.id, 'export message ID'), role === 'user' ? 'user_message' : role === 'tool' ? 'tool_result' : 'assistant_message', message.content.parts.join('\n'), message.create_time == null ? null : message.create_time * 1000)];
    });
  }
  // Compare the selected worktree and its explicitly bound host workspace.
  const repo = repository(cwd);
  if (data && !data.endsWith('\n')) throw new Error('Transcript has an incomplete final line; retry reconciliation after the source flushes');
  const output: Parsed[] = []; const calls = new Set<string>(); let associated = false; let model: string | null = null;
  for (const [index, line] of data.split('\n').entries()) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { throw new Error(`Invalid transcript JSON at line ${index + 1}`); }
    if (!row || typeof row !== 'object') throw new Error('Invalid transcript row');
    const firstEvent = output.length;
    if (parser === 'claude-jsonl-v1') {
      if (row.sessionId !== undefined && row.sessionId !== session) throw new Error('Transcript session does not match the hook');
      if (row.cwd && !associatedPath(row.cwd, repo, workspaceRoot)) throw new Error('Transcript belongs to a different worktree');
      if (row.sessionId === session && row.cwd) associated = true;
      if (['user', 'assistant'].includes(row.type)) {
        const id = identifier(row.uuid, 'transcript UUID');
        const content = typeof row.message?.content === 'string' ? [{ type: 'text', text: row.message.content }] : row.message?.content;
        if (!Array.isArray(content)) throw new Error('Unsupported Claude message content');
        content.forEach((block: any, part: number) => {
          if (block.type === 'thinking' || block.type === 'redacted_thinking') return;
          if (block.type === 'text') output.push(parsed(`${id}:${part}`, row.type === 'user' ? 'user_message' : 'assistant_message', block.text, row.timestamp));
          else if (block.type === 'tool_use') output.push(parsed(`call:${block.id}`, 'tool_call', { name: block.name, input: block.input }, row.timestamp, block.id));
          else if (block.type === 'tool_result') output.push(parsed(`result:${block.tool_use_id}`, 'tool_result', block.content, row.timestamp, block.tool_use_id));
          else output.push(parsed(`${id}:${part}`, 'capture_gap', 'Unsupported non-text Claude content omitted.', row.timestamp));
        });
      } else if (row.type === 'system' && row.subtype === 'compact_boundary') {
        output.push(parsed(`compact:${row.uuid ?? index}`, 'compaction_boundary', 'Source reported compaction; earlier source availability must be checked.', row.timestamp));
      } else if (!['system', 'progress', 'file-history-snapshot', 'queue-operation', 'summary', 'last-prompt'].includes(row.type)) {
        throw new Error('Unsupported Claude transcript row type');
      }
    } else if (parser === 'copilot-events-v1') {
      const item = row.data; const id = identifier(row.id, 'Copilot event ID');
      if (row.type === 'session.start') {
        if (item?.version !== 1 || item.sessionId !== session) throw new Error('Unsupported Copilot version or repository/session mismatch');
        if (item.context?.cwd ? !associatedPath(item.context.cwd, repo, workspaceRoot) : (host !== 'copilot-vscode' || item.producer !== 'copilot-agent' || typeof item.vscodeVersion !== 'string')) throw new Error('Copilot transcript repository mismatch or missing context');
        if (!item.context?.cwd) output.push(parsed(`${id}:association`, 'capture_gap', 'VS Code transcript omits working directory; repository association comes from the supplied hook/import, not source metadata.', row.timestamp));
        associated = true;
      } else if (row.type === 'session.context_changed') {
        if (!item?.cwd || !associatedPath(item.cwd, repo, workspaceRoot)) throw new Error('Copilot session changed worktrees; split the source before importing');
      } else if (row.ephemeral || row.type.startsWith('assistant.reasoning') || row.type === 'assistant.message_delta' || row.type === 'assistant.message_start') continue;
      else if (['user.message', 'assistant.message'].includes(row.type)) {
        if (typeof item?.content !== 'string') throw new Error('Unsupported Copilot message content');
        output.push(parsed(id, row.type === 'user.message' ? 'user_message' : 'assistant_message', item.content, row.timestamp));
        // Replayed VS Code history can expose requests without execution entries.
        for (const call of item.toolRequests ?? []) {
          const callId = identifier(call.toolCallId, 'Copilot tool call ID');
          let input = call.arguments;
          if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* Preserve exposed text. */ } }
          if (!calls.has(callId)) { calls.add(callId); output.push(parsed(`call:${callId}`, 'tool_call', { name: call.name, input }, row.timestamp, callId)); }
        }
        if (item.attachments?.length) output.push(parsed(`${id}:attachments`, 'capture_gap', 'Copilot attachments omitted; only visible text is captured.', row.timestamp));
      } else if (row.type === 'tool.execution_start') {
        if (!calls.has(item.toolCallId)) { calls.add(item.toolCallId); output.push(parsed(`call:${item.toolCallId}`, 'tool_call', { name: item.toolName, input: item.arguments }, row.timestamp, item.toolCallId)); }
      }
      else if (row.type === 'tool.execution_complete') output.push(parsed(`result:${item.toolCallId}`, 'tool_result', item.result?.detailedContent ?? item.result?.content ?? item.error?.message ?? 'Tool completed without exposed text.', row.timestamp, item.toolCallId));
      else if (row.type === 'session.compaction_complete') output.push(parsed(id, 'compaction_boundary', 'Copilot reported compaction; generated summaries are not original conversation.', row.timestamp));
      else if (!['session.resume', 'session.idle', 'session.shutdown', 'session.info', 'session.warning', 'session.error', 'session.model_change', 'session.mode_changed', 'session.compaction_start', 'session.context_cleared', 'assistant.turn_start', 'assistant.turn_end', 'assistant.usage', 'tool.execution_progress', 'tool.execution_partial_result'].includes(row.type)) {
        output.push(parsed(`${id}:unsupported`, 'capture_gap', 'Unmapped Copilot event type; its payload was omitted.', row.timestamp));
      }
    } else {
      if (row.type === 'session_meta') {
        if (row.payload?.id !== session || !row.payload?.cwd || !associatedPath(row.payload.cwd, repo, workspaceRoot)) throw new Error('Codex transcript repository/session mismatch');
        associated = true;
      } else if (row.type === 'turn_context') {
        model = typeof row.payload?.model === 'string' ? row.payload.model : null;
      } else if (row.type === 'response_item') {
        const item = row.payload;
        const id = `row:${index}`;
        if (item?.type === 'reasoning' || item?.channel === 'analysis') continue;
        if (item?.type === 'message') {
          if (!['user', 'assistant'].includes(item.role)) continue;
          if (!Array.isArray(item.content)) throw new Error('Unsupported Codex message content');
          item.content.forEach((part: any, i: number) => {
            if (['input_text', 'output_text'].includes(part.type)) output.push(parsed(`${id}:${i}`, item.role === 'user' ? 'user_message' : 'assistant_message', part.text, row.timestamp));
            else output.push(parsed(`${id}:${i}`, 'capture_gap', 'Unsupported non-text Codex content omitted.', row.timestamp));
          });
        } else if (['function_call', 'custom_tool_call'].includes(item?.type)) output.push(parsed(`call:${item.call_id}`, 'tool_call', { name: item.name, input: item.arguments ?? item.input }, row.timestamp, item.call_id));
        else if (['function_call_output', 'custom_tool_call_output'].includes(item?.type)) output.push(parsed(`result:${item.call_id}`, 'tool_result', item.output, row.timestamp, item.call_id));
        else throw new Error('Unsupported Codex response item');
      } else if (row.type === 'compacted') output.push(parsed(`compact:${index}`, 'compaction_boundary', 'Source reported compaction. Its generated summary is not an original exchange.', row.timestamp));
      else if (!['event_msg', 'turn_context', 'token_usage_record', 'world_state'].includes(row.type)) throw new Error('Unsupported Codex rollout row type');
    }
    const exposedModel = parser === 'claude-jsonl-v1' ? row.message?.model : parser === 'codex-rollout-v1' ? model : row.data?.model;
    if (typeof exposedModel === 'string') {
      if (exposedModel.length > 160) throw new Error('Unsupported source model identity');
      for (let i = firstEvent; i < output.length; i++) output[i].model = exposedModel;
    }
  }
  if (!associated) throw new Error('Transcript lacks verified repository/session metadata');
  return output;
}

function hookEvents(value: Record<string, any>, event: string, delivery: string): Parsed[] {
  const timestamp = value.timestamp;
  const call = value.tool_use_id ?? value.tool_call_id ?? null;
  if (event === 'UserPromptSubmit' && typeof value.prompt === 'string') return [parsed(`prompt:${value.prompt_id ?? value.turn_id ?? delivery}`, 'user_message', value.prompt, timestamp)];
  if (event === 'PreToolUse') return [parsed(`call:${call ?? delivery}`, 'tool_call', { name: value.tool_name, input: value.tool_input }, timestamp, call)];
  if (event === 'PostToolUse') return [parsed(`result:${call ?? delivery}`, 'tool_result', value.tool_response ?? value.tool_result?.text_result_for_llm ?? value.tool_result, timestamp, call)];
  if (event === 'PostToolUseFailure') return [parsed(`failure:${call ?? delivery}`, 'tool_result', { error: value.error ?? 'Tool failed' }, timestamp, call)];
  if (event === 'Stop' && typeof value.last_assistant_message === 'string') return [parsed(`reply:${value.turn_id ?? value.message_id ?? delivery}`, 'assistant_message', value.last_assistant_message, timestamp)];
  if (['PreCompact', 'PostCompact'].includes(event)) return [parsed(`compact-hook:${delivery}`, 'compaction_boundary', 'Source emitted ' + event + '. Any summary is generated, not original conversation.', timestamp)];
  return [];
}

export function recorderHookMatches(entry: any, installation: { hook_entry?: Record<string, unknown>; command: string | null }) {
  const expected = installation.hook_entry;
  if (!entry || typeof entry !== 'object') return false;
  if (!expected) return installation.command !== null && entry.command === installation.command && entry.args === undefined;
  return JSON.stringify([entry.command ?? null, entry.exec ?? null, entry.args ?? null]) === JSON.stringify([expected.command ?? null, expected.exec ?? null, expected.args ?? null]);
}

export function enableAdapter(repo: Repo, hostName: string, options: { parser?: string; surface?: string; hostVersion?: string; extensionVersion?: string; workspaceRoot?: string } = {}) {
  const host = adapter(hostName); const spec = ADAPTERS[host];
  const parser = options.parser ?? spec.parser;
  if (![spec.parser, 'none'].includes(parser as any)) throw new Error('Unsupported parser version');
  const surface = options.surface ?? (host === 'codex-desktop' ? 'desktop' : host.endsWith('export') ? 'import' : host.endsWith('cli') || host.endsWith('cloud') ? 'cli' : 'extension');
  if (!['extension', 'cli', 'desktop', 'import'].includes(surface)) throw new Error('Unknown host surface');
  const configPath = surface === 'import' ? null : spec.config;
  const configRoot = realpathSync(options.workspaceRoot ?? repo.root); const rel = relative(configRoot, repo.root);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Adapter workspace must contain the selected repository');
  return locked(repo, () => {
    config(repo); finishCapture(repo); const state = captureState(repo);
    const cli = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url));
    const quote = (input: string) => "'" + input.replaceAll("'", "'\\''") + "'";
    const direct = host === 'claude-code' || host === 'copilot-cli';
    if (process.platform === 'win32' && configPath && !direct) throw new Error('Automatic Windows setup is available for claude-code and copilot-cli; use explicit imports for this host');
    const command = `${quote(process.execPath)} ${quote(cli)} capture ${host} --repo ${quote(repo.root)} --input -`;
    const entry: Record<string, unknown> = direct
      ? { type: 'command', [host === 'copilot-cli' ? 'exec' : 'command']: process.execPath, args: [cli, 'capture', host, '--repo', repo.root, '--input', '-'], timeout: 15 }
      : { type: 'command', command, timeout: 15 };
    const previous = state.installations[host];
    const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact'];
    const rewrite = (destination: string, add: boolean) => {
      assertPlain(destination, false);
      const original: any = existsSync(destination) ? readJSON(destination) : {};
      if (!original || typeof original !== 'object' || Array.isArray(original) || original.hooks && (typeof original.hooks !== 'object' || Array.isArray(original.hooks))) throw new Error('Existing hook configuration has an unsupported shape');
      original.hooks ??= {};
      if (host.startsWith('copilot-') && add) original.version ??= 1;
      for (const name of events) {
        const entries = original.hooks[name] ?? [];
        if (!Array.isArray(entries)) throw new Error('Existing hook event must be an array');
        const owns = (item: any) => recorderHookMatches(item, { hook_entry: entry, command }) || Boolean(previous && recorderHookMatches(item, previous));
        original.hooks[name] = entries.flatMap((item: any) => {
          if (owns(item)) return [];
          if (!Array.isArray(item?.hooks)) return [item];
          const hooks = item.hooks.filter((hook: any) => !owns(hook));
          return hooks.length ? [{ ...item, hooks }] : [];
        }).concat(add ? [host.startsWith('copilot-') ? entry : { hooks: [entry] }] : []);
      }
      atomicWrite(destination, json(original));
    };
    const destination = configPath ? join(configRoot, configPath) : null;
    const previousDestination = previous?.config_path ? join(previous.config_root ?? repo.root, previous.config_path) : null;
    if (previousDestination && previousDestination !== destination && existsSync(previousDestination)) rewrite(previousDestination, false);
    if (destination) {
      const parts = configPath!.split('/'); let path = configRoot;
      for (const part of parts.slice(0, -1)) { path = join(path, part); privateDirectory(path); }
      rewrite(destination, true);
    }
    state.installations[host] = { hook_entry: configPath ? entry : undefined, node_executable: process.execPath, recorder_executable: cli, parser, surface: surface as Installation['surface'], host_version: options.hostVersion ?? null, extension_version: options.extensionVersion ?? null, config_root: configPath ? configRoot : null, workspace_root: configRoot, config_path: configPath, command: configPath ? command : null };
    atomicWrite(join(repo.stateDir, 'capture.json'), json(state));
    return { host, configured: true, automatic_hook_configuration: Boolean(configPath), capture_gate: 'unverified', parser, surface };
  });
}

// A durable redacted batch bridges journal and adapter-state writes, so crash replay does not mint new IDs.
function finishCapture(repo: Repo) {
  const path = join(repo.stateDir, 'capture-pending.json');
  if (!existsSync(path)) return;
  const pending: any = readJSON(path);
  if (!Array.isArray(pending.events) || pending.state?.schema_version !== 1) throw new Error('Invalid pending capture transaction');
  appendEvents(repo, pending.events);
  atomicWrite(join(repo.stateDir, 'capture.json'), json(pending.state));
  rmSync(path); syncDirectory(repo.stateDir);
}

function captureNow(repo: Repo, hostName: string, raw: unknown, deliveryId?: string, spoolRedaction?: { rules: string[]; omissions: string[] }) {
  const host = adapter(hostName); const value = object(raw, 'hook input') as Record<string, any>;
  const session = identifier(value.session_id ?? value.sessionId, 'session_id');
  const configured = captureState(repo).installations[host];
  if (!configured) throw new Error('Enable this adapter before capture');
  if (!associatedPath(value.cwd, repo, configured.workspace_root ?? repo.root)) throw new Error('Hook cwd must belong to the current worktree or its bound workspace');
  const event = value.hook_event_name;
  if (!['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd', 'Reconcile'].includes(event)) throw new Error('Unsupported hook event');
  const delivery = deliveryId ? identifier(deliveryId, 'delivery ID') : typeof value.timestamp === 'string' ? hash(value.timestamp + event) : randomUUID();
  return locked(repo, () => {
    finishCapture(repo);
    const state = captureState(repo); const installed = state.installations[host];
    if (!installed) throw new Error('Enable this adapter before capture');
    const key = bindingKey(ADAPTERS[host].tool, session); const taskState = tasks(repo);
    const existing = state.sessions[key];
    const task = existing?.task ?? taskState.bindings[key] ?? taskState.active ?? `session-${hash(key)}`;
    if (!taskState.tasks[task]) {
      taskState.tasks[task] = { title: `Captured ${ADAPTERS[host].tool} session`, created_at: new Date().toISOString() };
      atomicWrite(join(repo.stateDir, 'tasks.json'), json(taskState));
    }
    const entry = existing ?? { task, aliases: {}, provisional: [], last_capture: '', transcript: null, host, session, gaps: [], observed: [], deliveries: 0 };
    const gapMessages: string[] = [];
    const native = hookEvents(value, event, delivery);
    let transcript: Parsed[] = [];
    const transcriptPath = value.transcript_path ?? value.transcriptPath ?? entry.transcript;
    if (transcriptPath && installed.parser !== 'none') {
      try {
        if (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath)) throw new Error('Transcript path must be absolute');
        // Keep delayed sources reachable even when the final hook precedes their first flush.
        entry.transcript = transcriptPath;
        if (!statSync(transcriptPath).isFile() || statSync(transcriptPath).size > 32 * 1024 * 1024) throw new Error('Transcript is not a supported-size regular file');
        let data = readFileSync(transcriptPath, 'utf8');
        if (data && !data.endsWith('\n') && installed.parser !== 'chatgpt-export-v1') {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          data = readFileSync(transcriptPath, 'utf8');
        }
        transcript = parseTranscript(host, installed.parser, data, session, repo.root, installed.workspace_root ?? repo.root);
        entry.transcript = transcriptPath;
      } catch (error) { gapMessages.push(redact((error as Error).message).text); }
    } else if (['Stop', 'Reconcile', 'SessionStart'].includes(event)) gapMessages.push('No supported transcript source; only available hook fields are captured.');
    if ((value._generated_delivery || !deliveryId) && !value.timestamp && !value.turn_id && !value.prompt_id && !value.tool_use_id && native.length) gapMessages.push('Hook has no stable delivery identity; ambiguous retries cannot be deduplicated safely.');
    const all = journal(repo); const source = all.filter(e => e.source.tool === ADAPTERS[host].tool && e.source.session_id === session);
    const byId = new Map(source.map(e => [e.source.event_id, e]));
    let sequence = source.reduce((n, e) => Math.max(n, e.sequence + 1), 0);
    const incoming: ReturnType<typeof normalize>[] = [];
    const signature = (item: { type: string; content: string; tool_call_id: string | null }) => {
      const content = normalize(parseInput({ schema_version: 1, source: { tool: 'manual', session_id: 'signature', event_id: 'signature', surface: 'import', locator: 'signature' }, task_id: 'signature', sequence: 0, type: 'imported_content', content: item.content }), identity(repo)).content;
      return hash(JSON.stringify([item.type, content, item.tool_call_id]));
    };
    const add = (item: Parsed, origin: 'transcript' | 'hook') => {
      const alias = `${origin}:${item.id}`;
      if (Object.hasOwn(entry.aliases, alias)) {
        const old = byId.get(entry.aliases[alias]);
        if (old && signature(old) !== signature(item)) gapMessages.push('A previously captured source event changed; original journal event retained.');
        return;
      }
      let match;
      if (origin === 'transcript') {
        match = entry.provisional.find(id => byId.has(id) && signature(byId.get(id)!) === signature(item));
        if (match) entry.provisional = entry.provisional.filter(id => id !== match);
      } else {
        // The transcript and current hook often expose the same tool event or most recent message.
        const paired = new Set(Object.entries(entry.aliases).filter(([key]) => key.startsWith('hook:')).map(([, id]) => id));
        const same = transcript.find(other => !paired.has(entry.aliases[`transcript:${other.id}`]) && signature(other) === signature(item) && (item.tool_call_id !== null || item.timestamp !== null && item.timestamp === other.timestamp));
        if (same) match = entry.aliases[`transcript:${same.id}`];
      }
      if (match) { entry.aliases[alias] = match; return; }
      const id = hash(alias);
      const input = parseInput({ schema_version: 1, task_id: task, sequence: sequence++, timestamp: item.timestamp,
        source: { tool: ADAPTERS[host].tool, session_id: session, event_id: id, surface: installed.surface,
          host_version: installed.host_version, extension_version: installed.extension_version, locator: `${installed.parser}:${alias}` },
        type: item.type, content: item.content, model: item.model ?? null, tool_call_id: item.tool_call_id });
      const cleaned = normalize(input, identity(repo));
      if (spoolRedaction) cleaned.redaction = { rules: [...new Set([...cleaned.redaction.rules, ...spoolRedaction.rules])].sort(), omissions: [...new Set([...cleaned.redaction.omissions, ...spoolRedaction.omissions])] };
      incoming.push(cleaned); byId.set(id, cleaned); entry.aliases[alias] = id;
      if (origin === 'hook') entry.provisional.push(id);
      entry.observed = [...new Set([...entry.observed, item.type])];
    };
    transcript.forEach(item => add(item, 'transcript')); native.forEach(item => add(item, 'hook'));
    if (source.length && transcript.length && incoming.some(item => item.source.locator.includes(':transcript:'))) gapMessages.push('Late source reconciliation retains capture-arrival sequence; source locators preserve original positions.');
    for (const message of [...new Set(gapMessages)]) {
      if (!entry.gaps.includes(message)) { entry.gaps.push(message); add(parsed(`gap:${hash(message)}`, 'capture_gap', message, null), 'hook'); }
    }
    entry.last_capture = new Date().toISOString(); entry.deliveries++; state.sessions[key] = entry;
    atomicWrite(join(repo.stateDir, 'capture-pending.json'), json({ events: incoming, state }));
    finishCapture(repo);
    return { host, session_id: session, task_id: task, added: incoming.length, capture_status: 'partial', observed: entry.observed, gaps: entry.gaps, capture_gate: 'unverified' };
  });
}

// Each hook first writes its own sanitized queue item. A busy commit lock must not lose conversation.
export function capture(repo: Repo, hostName: string, raw: unknown, deliveryId?: string) {
  const host = adapter(hostName); const value = object(raw, 'hook input');
  const ids = identity(repo); const rules = new Set<string>(); const omissions = new Set<string>();
  const sanitize = (value: any, depth = 0): any => {
    if (depth > 20) { omissions.add('nesting_limit'); return '[OMITTED: nesting limit]'; }
    if (typeof value === 'string') {
      const cleaned = normalize(parseInput({ schema_version: 1, source: { tool: 'manual', session_id: 'spool', event_id: 'spool', surface: 'import', locator: 'spool' }, task_id: 'spool', sequence: 0, type: 'imported_content', content: value }), ids);
      cleaned.redaction.rules.forEach(rule => rules.add(rule)); cleaned.redaction.omissions.forEach(reason => omissions.add(reason));
      return cleaned.content;
    }
    if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, content]) => {
      if (/(password|passwd|secret|token|api[_-]?key|authorization)/i.test(key)) { rules.add('credential_assignment'); return [key, '[REDACTED:credential_assignment]']; }
      return [key, sanitize(content, depth + 1)];
    }));
    return value;
  };
  const payload: Record<string, unknown> = {};
  for (const key of ['hook_event_name', 'session_id', 'sessionId', 'cwd', 'transcript_path', 'transcriptPath', 'timestamp', 'tool_use_id', 'tool_call_id', 'prompt_id', 'turn_id', 'message_id']) {
    if (value[key] !== undefined) payload[key] = value[key];
  }
  for (const key of ['prompt', 'last_assistant_message', 'tool_name', 'tool_input', 'tool_response', 'tool_result', 'error']) {
    if (value[key] !== undefined) payload[key] = sanitize(value[key]);
  }
  payload._generated_delivery = !deliveryId;
  const delivery = deliveryId ?? (typeof value.timestamp === 'string' ? hash(value.timestamp + value.hook_event_name) : randomUUID());
  const directory = join(repo.stateDir, 'capture-queue'); privateDirectory(repo.stateDir); privateDirectory(directory);
  const path = join(directory, `${Date.now()}-${randomUUID()}.json`);
  const redaction = { rules: [...rules], omissions: [...omissions] };
  atomicWrite(path, json({ host, payload, delivery, redaction }));
  try {
    const result = captureNow(repo, host, payload, delivery, redaction);
    rmSync(path); syncDirectory(directory); return result;
  } catch (error) {
    if ((error as Error).message.startsWith('Recorder is locked')) return { host, added: 0, capture_status: 'partial', queued: true, gaps: ['Capture queued while recorder is busy; reconciliation is required.'] };
    throw error;
  }
}

export function drainCapture(repo: Repo) {
  const directory = join(repo.stateDir, 'capture-queue'); if (!existsSync(directory)) return [];
  const results: unknown[] = [];
  for (const file of readdirSync(directory).sort()) {
    if (!/^\d+-[0-9a-f-]{36}\.json$/.test(file)) continue;
    const path = join(directory, file); const item = readJSON(path) as any;
    try { results.push(captureNow(repo, item.host, item.payload, item.delivery, item.redaction)); rmSync(path); syncDirectory(directory); }
    catch (error) { results.push({ host: item.host, queued: true, error: redact((error as Error).message).text }); }
  }
  return results;
}

export function reconcile(repo: Repo) {
  const results = drainCapture(repo); const state = captureState(repo);
  for (const entry of Object.values(state.sessions)) {
    if (!entry.transcript) continue;
    results.push(capture(repo, entry.host, { hook_event_name: 'Reconcile', session_id: entry.session, cwd: repo.root, transcript_path: entry.transcript }, 'reconcile'));
  }
  return results;
}

export function captureCheck(repo: Repo, hostName: string, session: string, prompt: string, reply: string) {
  const host = adapter(hostName);
  if (!prompt.trim() || !reply.trim()) throw new Error('Capture check requires nonempty prompt and reply text');
  const entries = journal(repo).filter(e => e.source.tool === ADAPTERS[host].tool && e.source.session_id === session);
  const checks = { prompt: entries.some(e => e.type === 'user_message' && e.content.includes(prompt)),
    reply: entries.some(e => e.type === 'assistant_message' && e.content.includes(reply)),
    tool_call: entries.some(e => e.type === 'tool_call'), tool_result: entries.some(e => e.type === 'tool_result'),
    gaps: entries.some(e => e.type === 'capture_gap') };
  return { host, session_id: session, checks, fixture_or_session_content_check: Object.values(checks).slice(0, 4).every(Boolean),
    host_panel_verified: false, note: 'Compare this result with the actual panel. Supplied fixtures alone cannot certify a host version.' };
}
