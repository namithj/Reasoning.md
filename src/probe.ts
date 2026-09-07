import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { environment, git, repository } from './storage.ts';
import { object, redact, VERSION } from './schema.ts';

export const HOSTS = { 'claude-code': 'anthropic.claude-code', codex: 'openai.chatgpt', 'copilot-vscode': 'github.copilot-chat' };
export type Host = keyof typeof HOSTS;

export function probe(host: string, cwd: string, input?: unknown, extensionRoot?: string) {
  if (!(Object.hasOwn(HOSTS, host))) throw new Error('Unknown host; use claude-code, codex or copilot-vscode');
  const roots = extensionRoot ? [resolve(extensionRoot)] : ['.vscode', '.vscode-server', '.vscode-insiders', '.vscode-server-insiders']
    .map(dir => join(homedir(), dir, 'extensions'));
  const extensions: { id: string; version: string }[] = [];
  const inspectionErrors: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      for (const name of readdirSync(root)) {
        if (!name.toLowerCase().startsWith(HOSTS[host as Host] + '-')) continue;
        try {
          const path = join(root, name, 'package.json');
          if (statSync(path).size > 2 * 1024 * 1024) throw new Error('Oversized extension metadata');
          const pkg = JSON.parse(readFileSync(path, 'utf8'));
          if (`${pkg.publisher}.${pkg.name}`.toLowerCase() === HOSTS[host as Host] && typeof pkg.version === 'string') {
            extensions.push({ id: HOSTS[host as Host], version: redact(pkg.version.slice(0, 160)).text });
          }
        } catch { inspectionErrors.push('Could not read matching extension metadata.'); }
      }
    } catch { inspectionErrors.push('Could not inspect an extension directory.'); }
  }
  let repoRoot: string | null = null;
  try { repoRoot = repository(cwd).root; } catch { /* A metadata probe can run before repository initialization. */ }
  let hook: Record<string, unknown> | null = null;
  if (input !== undefined) {
    const value = object(input, 'hook input');
    if (typeof value.hook_event_name !== 'string' || !/^[A-Za-z]{1,80}$/.test(value.hook_event_name)) throw new Error('Hook input needs a valid hook_event_name');
    let association = 'unavailable';
    if (typeof value.cwd === 'string' && isAbsolute(value.cwd) && repoRoot) {
      try { association = repository(value.cwd).root === repoRoot ? 'same_worktree' : 'different_worktree'; }
      catch { association = 'inaccessible'; }
    }
    let transcript = value.transcript_path == null ? 'not_provided' : 'inaccessible';
    if (typeof value.transcript_path === 'string' && isAbsolute(value.transcript_path)) {
      try {
        accessSync(value.transcript_path, constants.R_OK);
        transcript = statSync(value.transcript_path).isFile() ? 'readable_file_format_unverified' : 'not_a_regular_file';
      } catch { /* Report reduced scope without exposing the path or its contents. */ }
    }
    hook = {
      event: value.hook_event_name,
      session_id_present: typeof value.session_id === 'string' && value.session_id.length > 0,
      prompt_present: typeof value.prompt === 'string',
      final_reply_field_present: typeof value.last_assistant_message === 'string',
      tool_input_present: value.tool_input !== undefined,
      tool_result_present: value.tool_response !== undefined || value.tool_result !== undefined,
      transcript, worktree_association: association,
      hook_execution_verified: false,
      evidence: 'Supplied payload only; it may be synthetic. No transcript body was read or retained.',
    };
  }
  let gitVersion: string | null = null;
  try { gitVersion = git(cwd, ['--version']).trim(); } catch { /* Report Git separately from host capture. */ }
  return {
    recorder_version: VERSION, host, environment: environment(),
    extension_installations: extensions, inspection_errors: inspectionErrors,
    extension_detection_scope: 'package metadata in selected local extension directories; active panel/runtime not proven',
    repository_detected: Boolean(repoRoot), git_version: gitVersion, hook,
    automatic_capture: 'unverified', parser: 'not_inspected_by_metadata_probe', supported_host_versions: [],
    hook_installation: 'see_doctor_capture_installations', commit_inclusion: 'see_doctor_recorder_status_client_unverified',
    capture_gate: 'unverified',
  };
}
