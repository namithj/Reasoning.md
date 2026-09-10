import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repository, initialize } from '../src/storage.ts';
import { journal } from '../src/recorder.ts';
import { enableAdapter as enable, capture, parseTranscript, captureState } from '../src/adapters.ts';
import { startTask, bindTask, context, decision, search } from '../src/history.ts';
const enableAdapter = (repo, host, options = {}) => enable(repo, host, { ...(process.platform === 'win32' ? { surface: 'import' } : {}), ...options });
const stamp = '2026-09-07T12:00:00.000Z';
function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'reasoning-capture-')); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  const repo = repository(cwd); initialize(repo, 'private'); const task = startTask(repo, 'Fix a greeting');
  return { cwd, repo, task };
}
const rows = (session, cwd) => [
  { type: 'user', uuid: 'u1', sessionId: session, cwd, timestamp: stamp, message: { content: 'Hello recorder' } },
  { type: 'assistant', uuid: 'a1', sessionId: session, cwd, timestamp: stamp, message: { content: [{ type: 'thinking', thinking: 'HIDDEN-DO-NOT-CAPTURE' }, { type: 'text', text: 'Hello user' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'code.txt' } }] } },
  { type: 'user', uuid: 'u2', sessionId: session, cwd, timestamp: stamp, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] } },
];
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

test('Claude reconciliation saves prompt/reply/tools once and never saves thinking blocks', t => {
  const { repo, cwd } = setup(t); enableAdapter(repo, 'claude-code');
  const path = join(cwd, 'transcript.jsonl'); writeFileSync(path, jsonl(rows('s1', cwd)));
  const payload = { hook_event_name: 'Stop', session_id: 's1', cwd, timestamp: stamp, transcript_path: path, last_assistant_message: 'Hello user' };
  capture(repo, 'claude-code', payload); capture(repo, 'claude-code', payload);
  const events = journal(repo).filter(e => e.source.tool === 'claude-code');
  assert.equal(events.filter(e => e.type === 'user_message').length, 1);
  assert.equal(events.filter(e => e.type === 'assistant_message').length, 1);
  assert.equal(events.filter(e => e.type === 'tool_call').length, 1);
  assert.equal(events.filter(e => e.type === 'tool_result').length, 1);
  assert.ok(!JSON.stringify(events).includes('HIDDEN-DO-NOT-CAPTURE'));
});

test('Claude 2.1.267 metadata rows are accepted while attachments remain explicit gaps', t => {
  const { cwd } = setup(t); const session = 'claude-structural';
  const source = [
    { type: 'custom-title', customTitle: 'Test title', sessionId: session },
    { type: 'agent-name', agentName: 'Test agent', sessionId: session },
    { type: 'attachment', uuid: 'attachment-1', sessionId: session, cwd, timestamp: stamp,
      attachment: { type: 'text', text: 'VISIBLE-ATTACHMENT-CONTEXT' } },
    { type: 'atis-latch', atis: 'metadata', sessionId: session },
    ...rows(session, cwd),
  ];
  const parsed = parseTranscript('claude-code', 'claude-jsonl-v1', jsonl(source), session, cwd);
  assert.deepEqual(parsed.filter(event => event.type === 'capture_gap').map(event => event.content),
    ['Claude transcript attachment omitted; its visible context or hook output was not imported.']);
  assert.ok(parsed.some(event => event.type === 'user_message'));
  assert.ok(parsed.some(event => event.type === 'assistant_message'));
  assert.ok(parsed.some(event => event.type === 'tool_call'));
  assert.ok(parsed.some(event => event.type === 'tool_result'));
  assert.doesNotMatch(JSON.stringify(parsed), /VISIBLE-ATTACHMENT-CONTEXT/);
  assert.throws(() => parseTranscript('claude-code', 'claude-jsonl-v1', jsonl([...source,
    { type: 'unknown-2.1.267-row', sessionId: session }]), session, cwd), /Unsupported Claude transcript row type/);
});

test('late transcript flush reconciles provisional prompts without losing repeated prompts', t => {
  const { repo, cwd } = setup(t); enableAdapter(repo, 'claude-code');
  capture(repo, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd, prompt: 'Hello recorder' }, 'delivery1');
  capture(repo, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd, prompt: 'Hello recorder' }, 'delivery2');
  const path = join(cwd, 'transcript.jsonl'); const source = rows('s1', cwd);
  source.push({ ...source[0], uuid: 'u3' }); writeFileSync(path, jsonl(source));
  const payload = { hook_event_name: 'Stop', session_id: 's1', cwd, transcript_path: path };
  capture(repo, 'claude-code', payload, 'stop'); capture(repo, 'claude-code', payload, 'stop');
  assert.equal(journal(repo).filter(e => e.type === 'user_message').length, 2);
});

test('a delayed timestamp-less hook does not duplicate a transcript reply', t => {
  const { repo, cwd } = setup(t); enableAdapter(repo, 'codex');
  const path = join(cwd, 'rollout.jsonl');
  writeFileSync(path, jsonl([
    { type: 'session_meta', payload: { id: 'late-hook', cwd } },
    { type: 'response_item', timestamp: stamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Already imported reply' }] } },
  ]));
  capture(repo, 'codex', { hook_event_name: 'SessionStart', session_id: 'late-hook', cwd, transcript_path: path }, 'start');
  capture(repo, 'codex', { hook_event_name: 'Stop', session_id: 'late-hook', cwd, last_assistant_message: 'Already imported reply' }, 'late-stop');
  assert.equal(journal(repo).filter(event => event.source.session_id === 'late-hook' && event.type === 'assistant_message').length, 1);
});

test('capture batch replay remains redacted and preserves redaction metadata', t => {
  const { repo, cwd } = setup(t); enableAdapter(repo, 'codex', { parser: 'none' });
  const secret = 'ghp_' + 'x'.repeat(30);
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd, prompt: 'Use ' + secret };
  capture(repo, 'codex', payload, 'one'); capture(repo, 'codex', payload, 'one');
  const event = journal(repo).find(e => e.source.tool === 'codex' && e.type === 'user_message');
  assert.ok(!event.content.includes(secret)); assert.ok(event.redaction.rules.includes('github_token'));
  assert.equal(journal(repo).filter(e => e.type === 'user_message').length, 1);
  assert.equal(existsSync(join(repo.stateDir, 'capture-pending.json')), false);
});

test('source errors are journaled as explicit gaps without importing foreign conversations', t => {
  const { repo, cwd } = setup(t); enableAdapter(repo, 'claude-code');
  const path = join(cwd, 'transcript.jsonl'); writeFileSync(path, jsonl(rows('foreign', cwd)));
  const result = capture(repo, 'claude-code', { hook_event_name: 'Stop', session_id: 's1', cwd, transcript_path: path }, 'stop');
  assert.ok(result.gaps.some(gap => gap.includes('session')));
  assert.equal(journal(repo).filter(e => e.type === 'user_message').length, 0);
  writeFileSync(path, '{incomplete');
  assert.ok(capture(repo, 'claude-code', { hook_event_name: 'Stop', session_id: 's1', cwd, transcript_path: path }, 'stop2').gaps.some(gap => gap.includes('incomplete')));
  assert.throws(() => parseTranscript('codex', 'unknown-v9', '', 's1', cwd), /Unsupported parser/);
});

test('Codex rollout ignores hidden reasoning and duplicate event_msg summaries', t => {
  const { cwd } = setup(t);
  const source = [
    { type: 'session_meta', payload: { id: 's1', cwd } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate' } },
    { type: 'token_usage_record', payload: { total_token_usage: { input_tokens: 1 } } },
    { type: 'world_state', payload: { internal: 'HIDDEN' } },
    { type: 'response_item', payload: { type: 'reasoning', content: 'HIDDEN' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'HIDDEN' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: 'Visible response' }] } },
  ];
  const parsed = parseTranscript('codex', 'codex-rollout-v1', jsonl(source), 's1', cwd);
  assert.equal(parsed.length, 1); assert.equal(parsed[0].content, 'Visible response');
});

test('host setup preserves unrelated JSON and is idempotent', { skip: process.platform === 'win32' && 'Automatic Windows host configuration is not supported' }, t => {
  const { repo, cwd } = setup(t); mkdirSync(join(cwd, '.claude'));
  const path = join(cwd, '.claude/settings.local.json');
  writeFileSync(path, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-tool' }] }] } }));
  enableAdapter(repo, 'claude-code'); enableAdapter(repo, 'claude-code'); enableAdapter(repo, 'codex');
  const value = JSON.parse(readFileSync(path)); assert.deepEqual(value.permissions, { allow: ['Read'] }); assert.equal(value.hooks.Stop.length, 2);
  assert.equal(Object.keys(captureState(repo).installations).length, 2);
});

test('task bindings survive active task changes and context is bounded and grounded', t => {
  const { repo, cwd, task } = setup(t); enableAdapter(repo, 'codex', { parser: 'none' });
  bindTask(repo, 'codex', 's1', task.task_id); startTask(repo, 'Unrelated work');
  const result = capture(repo, 'codex', { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd, prompt: 'Use a capability check' }, 'one');
  assert.equal(result.task_id, task.task_id);
  decision(repo, 'Use capability checks because permissions vary by user.', task.task_id);
  const packet = context(repo, task.task_id, 2000);
  assert.ok(packet.length <= 2000); assert.match(packet, /event:/); assert.match(packet, /capability/); assert.doesNotMatch(packet, /> Task objective.*Unrelated/);
  assert.ok(search(repo, 'capability').matches.length >= 2);
});

test('ChatGPT export imports only the selected visible conversation branch', t => {
  const { cwd } = setup(t);
  const exportData = [{ id: 'c1', current_node: 'a', mapping: {
    u: { parent: null, message: { id: 'u', author: { role: 'user' }, content: { content_type: 'text', parts: ['Question'] } } },
    a: { parent: 'u', message: { id: 'a', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Answer'] } } },
    other: { parent: 'u', message: { id: 'other', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Not the selected branch'] } } },
  } }];
  const entries = parseTranscript('chatgpt-export', 'chatgpt-export-v1', JSON.stringify(exportData), 'c1', cwd);
  assert.deepEqual(entries.map(e => e.content), ['Question', 'Answer']);
});

test('busy recorder queues redacted input and reconciles it once', async t => {
  const { repo, cwd } = setup(t); enableAdapter(repo, 'codex', { parser: 'none' });
  const { locked } = await import('../src/storage.ts');
  const { reconcile } = await import('../src/adapters.ts');
  const { readdirSync } = await import('node:fs');
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: 'queue-session', cwd, prompt: 'password=queue-secret-value', reasoning: 'HIDDEN' };
  locked(repo, () => assert.equal(capture(repo, 'codex', payload, 'delivery-one').queued, true));
  const directory = join(repo.stateDir, 'capture-queue');
  const queued = readFileSync(join(directory, readdirSync(directory)[0]), 'utf8');
  assert.doesNotMatch(queued, /queue-secret-value|HIDDEN/);
  reconcile(repo); reconcile(repo);
  assert.equal(journal(repo).filter(e => e.source.session_id === 'queue-session' && e.type === 'user_message').length, 1);
  assert.equal(readdirSync(directory).length, 0);
});

test('SessionStart recovers queued delivery and delayed known transcript exactly once', async t => {
  const { repo, cwd } = setup(t); enableAdapter(repo, 'claude-code');
  const delayed = join(cwd, 'delayed-on-start.jsonl');
  capture(repo, 'claude-code', { hook_event_name: 'Stop', session_id: 'late', cwd, transcript_path: delayed }, 'late-stop');
  const { locked } = await import('../src/storage.ts');
  locked(repo, () => assert.equal(capture(repo, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'queued', cwd, prompt: 'Recover this queued prompt' }, 'queued-prompt').queued, true));
  writeFileSync(delayed, jsonl(rows('late', cwd)));
  capture(repo, 'claude-code', { hook_event_name: 'SessionStart', session_id: 'new-session', cwd }, 'new-start');
  capture(repo, 'claude-code', { hook_event_name: 'SessionStart', session_id: 'new-session', cwd }, 'new-start');
  const events = journal(repo);
  assert.equal(events.filter(event => event.source.session_id === 'late' && event.type === 'assistant_message').length, 1);
  assert.equal(events.filter(event => event.source.session_id === 'queued' && event.content.includes('Recover this queued prompt')).length, 1);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(join(repo.stateDir, 'capture-queue')), []);
});

test('explicit host import configuration creates no automatic hooks', t => {
  const { repo, cwd } = setup(t);
  const result = enableAdapter(repo, 'claude-code', { surface: 'import' });
  assert.equal(result.automatic_hook_configuration, false);
  assert.equal(existsSync(join(cwd, '.claude/settings.local.json')), false);
});

test('Copilot event source captures full visible replies and rejects foreign sessions', t => {
  const { cwd } = setup(t);
  const source = [
    { id: 'start', type: 'session.start', data: { version: 1, sessionId: 's1', context: { cwd } } },
    { id: 'u', type: 'user.message', data: { content: 'Question', transformedContent: 'INTERNAL' } },
    { id: 'reason', type: 'assistant.reasoning', data: { content: 'HIDDEN' } },
    { id: 'a', type: 'assistant.message', data: { content: 'Full reply', reasoningText: 'HIDDEN', encryptedContent: 'HIDDEN' } },
    { id: 'call', type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'Read', arguments: { file: 'file.txt' } } },
    { id: 'result', type: 'tool.execution_complete', data: { toolCallId: 't1', result: { content: 'short', detailedContent: 'Full tool result' } } },
  ];
  const result = parseTranscript('copilot-cli', 'copilot-events-v1', jsonl(source), 's1', cwd);
  assert.deepEqual(result.map(e => e.type), ['user_message', 'assistant_message', 'tool_call', 'tool_result']);
  assert.equal(result.at(-1).content, 'Full tool result');
  assert.doesNotMatch(JSON.stringify(result), /HIDDEN|INTERNAL/);
  assert.throws(() => parseTranscript('copilot-cli', 'copilot-events-v1', jsonl(source), 'other', cwd), /mismatch/);
});

test('capture registers a session without requiring manual task setup', t => {
  const { repo, cwd } = setup(t); rmSync(join(repo.stateDir, 'tasks.json'));
  enableAdapter(repo, 'codex', { parser: 'none' });
  const result = capture(repo, 'codex', { hook_event_name: 'UserPromptSubmit', session_id: 'auto', cwd, prompt: 'Automatic session task' }, 'auto');
  assert.match(result.task_id, /^session-/);
  assert.equal(journal(repo).filter(e => e.source.session_id === 'auto').length, 1);
});


test('binding an already captured session cannot silently move its history', t => {
  const { repo, cwd } = setup(t); enableAdapter(repo, 'codex', { parser: 'none' });
  capture(repo, 'codex', { hook_event_name: 'UserPromptSubmit', session_id: 'bound', cwd, prompt: 'Original task' }, 'bound');
  const next = startTask(repo, 'Different task');
  assert.throws(() => bindTask(repo, 'codex', 'bound', next.task_id), /already belongs/);
});

test('Copilot VS Code v1 reuses the parser, captures replayed tool requests once and omits reasoning', t => {
  const { repo, cwd } = setup(t); enableAdapter(repo, 'copilot-vscode');
  const source = [
    { id: 'start', type: 'session.start', data: { version: 1, sessionId: 'vscode-session', producer: 'copilot-agent', vscodeVersion: '1.110.0', copilotVersion: '0.38.0' } },
    { id: 'u', type: 'user.message', data: { content: 'Read greeting' } },
    { id: 'a', type: 'assistant.message', data: { content: 'Full visible reply', reasoningText: 'HIDDEN', toolRequests: [{ toolCallId: 'call1', name: 'Read', arguments: '{"file":"greeting"}' }] } },
    { id: 'call', type: 'tool.execution_start', data: { toolCallId: 'call1', toolName: 'Read', arguments: { file: 'greeting' } } },
    { id: 'result', type: 'tool.execution_complete', data: { toolCallId: 'call1', result: { content: 'password=secret-value' } } },
  ];
  const path = join(cwd, 'vscode.jsonl'); writeFileSync(path, jsonl(source));
  const payload = { hook_event_name: 'Stop', session_id: 'vscode-session', cwd, transcript_path: path };
  capture(repo, 'copilot-vscode', payload, 'stop'); capture(repo, 'copilot-vscode', payload, 'stop');
  const events = journal(repo).filter(event => event.source.tool === 'copilot');
  for (const type of ['user_message', 'assistant_message', 'tool_call', 'tool_result']) assert.equal(events.filter(e => e.type === type).length, 1);
  assert.doesNotMatch(JSON.stringify(events), /HIDDEN|secret-value/);
  assert.ok(events.some(e => e.type === 'capture_gap' && e.content.includes('repository association')));
  source[0].data.version = 2;
  assert.throws(() => parseTranscript('copilot-vscode', 'copilot-events-v1', jsonl(source), 'vscode-session', cwd), /version/);
});

test('reconcile retries a source whose first flush happens after the last hook', async t => {
  const { reconcile } = await import('../src/adapters.ts');
  const { repo, cwd } = setup(t); enableAdapter(repo, 'claude-code');
  const path = join(cwd, 'delayed.jsonl');
  capture(repo, 'claude-code', { hook_event_name: 'Stop', session_id: 'late', cwd, transcript_path: path }, 'last-hook');
  assert.equal(captureState(repo).sessions['["claude-code","late"]'].transcript, path);
  writeFileSync(path, jsonl(rows('late', cwd)));
  reconcile(repo); reconcile(repo);
  assert.equal(journal(repo).filter(e => e.source.session_id === 'late' && e.type === 'assistant_message').length, 1);
});

test('doctor health detects removed hook commands instead of trusting installation state', { skip: process.platform === 'win32' }, async t => {
  const { health } = await import('../src/probe.ts');
  const { repo, cwd } = setup(t); enableAdapter(repo, 'codex');
  assert.equal(health(repo).adapters.codex.hook_commands_present, true);
  const path = join(cwd, '.codex/hooks.json'); const configuration = JSON.parse(readFileSync(path, 'utf8'));
  configuration.hooks.Stop = []; writeFileSync(path, JSON.stringify(configuration));
  assert.equal(health(repo).adapters.codex.hook_commands_present, false);
  assert.equal(health(repo).adapters.codex.live_panel_verified, false);
});

test('Claude and Copilot CLI launch capture directly and preserve unrelated Node hooks', t => {
  for (const host of ['claude-code', 'copilot-cli']) {
    const { repo, cwd } = setup(t);
    enable(repo, host);
    const spec = captureState(repo).installations[host];
    const path = join(cwd, spec.config_path);
    const configuration = JSON.parse(readFileSync(path, 'utf8'));
    const wrapper = configuration.hooks.UserPromptSubmit[0];
    const entry = host === 'claude-code' ? wrapper.hooks[0] : wrapper;
    assert.equal(entry.command ?? entry.exec, process.execPath);
    assert.ok(Array.isArray(entry.args));
    const sibling = { type: 'command', command: process.execPath, args: ['unrelated-script.js'] };
    if (host === 'claude-code') wrapper.hooks.push(sibling);
    else configuration.hooks.UserPromptSubmit.push(sibling);
    writeFileSync(path, JSON.stringify(configuration));
    enable(repo, host); enable(repo, host);
    const rewritten = JSON.parse(readFileSync(path, 'utf8')).hooks.UserPromptSubmit;
    const flattened = rewritten.flatMap(item => item.hooks ?? [item]);
    assert.equal(flattened.filter(item => item.args?.includes('unrelated-script.js')).length, 1);
    assert.equal(flattened.filter(item => item.args?.includes('capture')).length, 1);
    const result = spawnSync(entry.command ?? entry.exec, entry.args, { cwd, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'direct', cwd, prompt: 'Literal $HOME and `text` remain text', timestamp: stamp }), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
    assert.equal(journal(repo).find(event => event.source.session_id === 'direct').content, 'Literal $HOME and `text` remain text');
  }
});

test('capture preserves exposed source model identity and handles Codex model switches', t => {
  const { repo, cwd } = setup(t); enableAdapter(repo, 'codex', { surface: 'import' });
  const path = join(cwd, 'models.jsonl');
  writeFileSync(path, jsonl([
    { type: 'session_meta', payload: { id: 'models', cwd } },
    { type: 'turn_context', payload: { model: 'model-one' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First reply' }] } },
    { type: 'turn_context', payload: { model: 'model-two' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Second reply' }] } },
  ]));
  capture(repo, 'codex', { hook_event_name: 'Reconcile', session_id: 'models', cwd, transcript_path: path }, 'models');
  assert.deepEqual(journal(repo).filter(event => event.type === 'assistant_message').map(event => event.model), ['model-one', 'model-two']);
  const claude = rows('claude-model', cwd); claude[1].message.model = 'claude-exposed-model';
  assert.equal(parseTranscript('claude-code', 'claude-jsonl-v1', jsonl(claude), 'claude-model', cwd).find(event => event.type === 'assistant_message').model, 'claude-exposed-model');
});
