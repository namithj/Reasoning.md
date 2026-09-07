#!/usr/bin/env node
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exportSnapshot, ingest, status } from './recorder.ts';
import { config, initialize, repository } from './storage.ts';
import { installSkill, setPolicy, verifyRange } from './team.ts';
import { installNative, uninstallNative, nativeHook } from './native.ts';
import { ADAPTERS, capture, captureState, enableAdapter, reconcile, captureCheck } from './adapters.ts';
import { startTask, bindTask, tasks, decision, search, context, explain } from './history.ts';
import { commit, commitPreview, recover, runHook, show, verify } from './commits.ts';
import { HOSTS, probe } from './probe.ts';
import { INPUT_LIMIT, json, redact, VERSION } from './schema.ts';

const help = `Reasoning.md ${VERSION} — experimental development conversation archive

Usage:
  reasoning init --publication private|public
  reasoning import --input events.jsonl|- 
  reasoning status
  reasoning preview --staged [--task task-id]
  reasoning export --staged [--task task-id]
  reasoning probe claude-code|codex|copilot-vscode [--input hook.json|-] [--extension-dir directory]
  reasoning doctor [--extension-dir directory]
  reasoning commit -m "message" [--task task-id] [--no-assistant-activity] [--allow-partial "reason"]
  reasoning recover
  reasoning task start "objective" | task list | task bind TOOL SESSION --task ID
  reasoning adapter enable HOST [--parser VERSION] [--surface extension|cli|desktop|import]
  reasoning adapter list | adapter check HOST --session ID --prompt TEXT --reply TEXT
  reasoning capture HOST --input FILE|- [--delivery-id ID]
  reasoning reconcile
  reasoning hooks install | hooks uninstall
  reasoning skill install --host HOST
  reasoning policy --mode warn|strict
  reasoning verify-range BASE..HEAD [--require-complete] [--allow-overrides]
  reasoning decision "rationale" [--task ID]
  reasoning search "text"
  reasoning context --task ID [--limit 12000]
  reasoning explain --file PATH
  reasoning show [commit]
  reasoning verify [commit]

Requires Node.js 24+ and Git. Run repository commands from the target worktree.
Import accepts normalized JSONL v1 or a declared host transcript with --host HOST --session ID.
Export creates an untracked snapshot; it never stages, commits or consumes events.
Host capture and native Git hooks are opt-in; real IDE compatibility remains unverified.
The controlled commit wrapper runs only when you invoke reasoning commit.
Public exports are readable by everyone receiving the repository. Review before sharing.
`;

async function readInput(path: string): Promise<string> {
  const stream = path === '-' ? process.stdin : createReadStream(path);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > INPUT_LIMIT) throw new Error('Input exceeds the 5 MiB batch limit; split it into smaller batches');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (process.argv[2] === 'native-hook') {
    const [hook, ...args] = process.argv.slice(3);
    nativeHook(repository(), hook, args, hook === 'reference-transaction' ? await readInput('-') : undefined); return;
  }
  if (process.argv[2] === 'internal-hook') {
    const [hook, ...args] = process.argv.slice(3);
    runHook(repository(), hook, args, hook === 'reference-transaction' ? await readInput('-') : undefined);
    return;
  }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'allow-partial': { type: 'string' }, 'require-complete': { type: 'boolean' }, 'allow-overrides': { type: 'boolean' }, mode: { type: 'string' }, host: { type: 'string' },
    parser: { type: 'string' }, surface: { type: 'string' }, 'host-version': { type: 'string' }, 'extension-version': { type: 'string' },
    session: { type: 'string' }, prompt: { type: 'string' }, reply: { type: 'string' }, 'delivery-id': { type: 'string' },
    file: { type: 'string' }, limit: { type: 'string' },
    message: { type: 'string', short: 'm' }, 'no-assistant-activity': { type: 'boolean' },
    publication: { type: 'string' }, input: { type: 'string' }, task: { type: 'string' },
    staged: { type: 'boolean' }, 'extension-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.help || !positionals.length && !values.version) { process.stdout.write(help); return; }
  if (values.version) { process.stdout.write(VERSION + '\n'); return; }
  const [command, host] = positionals;
  const allowed: Record<string, string[]> = {
    skill: ['host'], policy: ['mode'], 'verify-range': ['require-complete', 'allow-overrides'], hooks: [],
    adapter: ['parser', 'surface', 'host-version', 'extension-version', 'session', 'prompt', 'reply'],
    capture: ['input', 'delivery-id'], reconcile: [], task: ['task'], decision: ['task'], search: [], context: ['task', 'limit'], explain: ['file'],
    commit: ['message', 'task', 'no-assistant-activity', 'allow-partial'], recover: [], show: [], verify: [],
    init: ['publication'], import: ['input', 'host', 'session'], status: [], preview: ['staged', 'task'],
    export: ['staged', 'task'], probe: ['input', 'extension-dir'], doctor: ['extension-dir'],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown command; run reasoning --help');
  const counts = ['show', 'verify'].includes(command) ? [1, 2] : ['adapter', 'task'].includes(command) ? [2, 3, 4] : ['skill', 'verify-range', 'hooks', 'capture', 'probe', 'decision', 'search'].includes(command) ? [2] : [1];
  if (!counts.includes(positionals.length)) throw new Error('Unexpected or missing command arguments; run reasoning --help');
  if (Object.keys(values).some(key => !allowed[command].includes(key))) throw new Error('Option is not supported by this command');
  if (command === 'probe') {
    let payload: unknown;
    if (values.input) {
      const input = await readInput(values.input);
      try { payload = JSON.parse(input); } catch { throw new Error('Invalid hook JSON'); }
    }
    process.stdout.write(json(probe(host, process.cwd(), payload, values['extension-dir']))); return;
  }
  const repo = repository();
  if (command === 'init') {
    process.stdout.write(json(initialize(repo, values.publication ?? ''))); return;
  }
  if (command === 'doctor') {
    const initialized = existsSync(join(repo.root, '.ai-history', 'config.json'));
    process.stdout.write(json({ initialized, recorder_executable: process.argv[1], node_executable: process.execPath,
      local_state: repo.stateDir, recorder: initialized ? status(repo) : null,
      capture: initialized ? captureState(repo) : null, tasks: initialized ? tasks(repo) : null,
      hosts: Object.keys(HOSTS).map(name => probe(name, repo.root, undefined, values['extension-dir'])) })); return;
  }
  if (command === 'verify-range') { const result = verifyRange(repo, host, values['require-complete'], values['allow-overrides']); process.stdout.write(json(result)); if (!result.verified) process.exitCode = 1; return; }
  if (command === 'search') { process.stdout.write(json(search(repo, host))); return; }
  if (command === 'context') { if (!values.task) throw new Error('Context requires --task'); process.stdout.write(context(repo, values.task, values.limit ? Number(values.limit) : undefined)); return; }
  if (command === 'explain') { if (!values.file) throw new Error('Explain requires --file'); process.stdout.write(json(explain(repo, values.file))); return; }
  if (command === 'show') { process.stdout.write(show(repo, host)); return; }
  if (command === 'verify') {
    const { records, ...result } = verify(repo, host);
    process.stdout.write(json({ ...result, verified: true, referenced_records: records.size - 1 })); return;
  }
  config(repo);
  if (command === 'policy') { if (!values.mode) throw new Error('Policy requires --mode'); process.stdout.write(json(setPolicy(repo, values.mode))); return; }
  if (command === 'skill') { if (host !== 'install' || !values.host) throw new Error('Use skill install --host HOST'); process.stdout.write(json(installSkill(repo, values.host))); return; }
  if (command === 'hooks') {
    if (host === 'install') process.stdout.write(json(installNative(repo)));
    else if (host === 'uninstall') process.stdout.write(json(uninstallNative(repo)));
    else throw new Error('Use hooks install or hooks uninstall');
    return;
  }
  if (command === 'adapter') {
    const target = positionals[2];
    if (host === 'list' && positionals.length === 2) { process.stdout.write(json({ available: ADAPTERS, state: captureState(repo) })); return; }
    if (!target || positionals.length !== 3) throw new Error('Use adapter enable HOST or adapter check HOST');
    if (host === 'enable') { process.stdout.write(json(enableAdapter(repo, target, { parser: values.parser, surface: values.surface, hostVersion: values['host-version'], extensionVersion: values['extension-version'] }))); return; }
    if (host === 'check') { if (!values.session || !values.prompt || !values.reply) throw new Error('Capture check requires --session, --prompt and --reply'); process.stdout.write(json(captureCheck(repo, target, values.session, values.prompt, values.reply))); return; }
    throw new Error('Unknown adapter operation');
  }
  if (command === 'capture') {
    if (!values.input) throw new Error('Capture requires --input file or --input -');
    let payload; try { payload = JSON.parse(await readInput(values.input)); } catch { throw new Error('Invalid capture input JSON'); }
    const result = capture(repo, host, payload, values['delivery-id']);
    // Hook stdout is host control data. Keep diagnostic JSON off it when used as a hook.
    if (values.input === '-') { if (result.gaps.length) process.stderr.write('reasoning: partial capture; run reasoning doctor for gaps.\n'); }
    else process.stdout.write(json(result));
    return;
  }
  if (command === 'reconcile') { process.stdout.write(json(reconcile(repo))); return; }
  if (command === 'task') {
    if (host === 'list' && positionals.length === 2) { process.stdout.write(json(tasks(repo))); return; }
    if (host === 'start' && positionals.length === 3) { process.stdout.write(json(startTask(repo, positionals[2]))); return; }
    if (host === 'bind' && positionals.length === 4 && values.task) { process.stdout.write(json(bindTask(repo, positionals[2], positionals[3], values.task))); return; }
    throw new Error('Use task start TITLE, task list, or task bind TOOL SESSION --task ID');
  }
  if (command === 'decision') { process.stdout.write(json(decision(repo, host, values.task))); return; }
  if (command === 'commit') {
    if (!values.message) throw new Error('Commit requires -m message');
    reconcile(repo);
    process.stdout.write(json(commit(repo, values.message, values.task, values['no-assistant-activity'], values['allow-partial']))); return;
  }
  if (command === 'recover') { process.stdout.write(json(recover(repo))); return; }
  if (command === 'import') {
    if (!values.input) throw new Error('Import requires --input events.jsonl or --input -');
    if (values.host) {
      if (!values.session || values.input === '-') throw new Error('Host transcript import requires --session and a file path');
      if (!captureState(repo).installations[values.host]) enableAdapter(repo, values.host, { surface: 'import' });
      process.stdout.write(json(capture(repo, values.host, { hook_event_name: 'Reconcile', session_id: values.session, cwd: repo.root, transcript_path: resolve(values.input) }, 'explicit-import')));
    } else process.stdout.write(json(ingest(repo, await readInput(values.input))));
  } else if (command === 'status') {
    process.stdout.write(json(status(repo)));
  } else {
    if (!values.staged) throw new Error('Preview and export require --staged; only the actual index is represented');
    if (command === 'preview') process.stdout.write(commitPreview(repo, values.task).reasoning);
    else process.stdout.write(json(exportSnapshot(repo, values.task)));
  }
}

main().catch(error => {
  process.stderr.write(`reasoning: ${redact(error instanceof Error ? error.message : 'Unexpected failure').text}\n`);
  process.exitCode = process.argv[2] === 'capture' && process.argv.includes('--input') && process.argv.includes('-') ? 0 : 1;
});
