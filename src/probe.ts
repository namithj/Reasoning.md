import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ADAPTERS, captureState, recorderHookMatches } from './adapters.ts';
import { installedNative } from './commits.ts';
import type { Repo } from './storage.ts';
import { environment, git, repository, samePath } from './storage.ts';
import { object, redact, VERSION } from './schema.ts';

export const HOSTS = { 'claude-code': 'anthropic.claude-code', codex: 'openai.chatgpt', 'copilot-vscode': 'github.copilot-chat' };
export type Host = keyof typeof HOSTS;
const NATIVE_HOOKS = ['pre-merge-commit', 'pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction'];

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

// Report current on-disk reachability separately from historical installation state.
export function health(repo: Repo) {
  const file = (path?: string) => {
    if (!path) return null;
    try { return statSync(path).isFile(); } catch { return false; }
  };
  const accessible = (path: string | undefined, mode: number) => {
    if (!path) return null;
    try { accessSync(path, mode); return statSync(path).isFile(); } catch { return false; }
  };
  const capture = captureState(repo);
  const adapters = Object.fromEntries(Object.entries(capture.installations).map(([host, installation]) => {
    let hooksPresent: boolean | null = null;
    let hooksEnabled: boolean | null = null;
    const configRoot = installation.config_root ?? repo.root;
    if (installation.config_path) {
      try {
        const settings = JSON.parse(readFileSync(join(configRoot, installation.config_path), 'utf8'));
        hooksEnabled = host === 'claude-code' ? settings.disableAllHooks !== true : true;
        hooksPresent = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact'].every(event =>
          settings.hooks?.[event]?.some((entry: any) => recorderHookMatches(entry, installation) || entry.hooks?.some((hook: any) => recorderHookMatches(hook, installation))));
      } catch { hooksPresent = false; }
    }
    const recorderReadable = accessible(installation.recorder_executable, constants.R_OK);
    const nodeReadable = accessible(installation.node_executable, constants.R_OK);
    const nodeExecutable = accessible(installation.node_executable, constants.X_OK);
    return [host, { hook_commands_present: hooksPresent, config_root: configRoot, config_path: installation.config_path,
      workspace_root: installation.workspace_root ?? configRoot, repository_root: repo.root,
      hooks_enabled: hooksEnabled, recorder_readable: recorderReadable, node_readable: nodeReadable, node_executable: nodeExecutable,
      capture_configuration_ready: hooksPresent === true && hooksEnabled === true && recorderReadable === true && nodeExecutable === true,
      parser_supported: installation.parser === ADAPTERS[host as keyof typeof ADAPTERS]?.parser,
      last_capture: Object.values(capture.sessions).filter(session => session.host === host).map(session => session.last_capture).sort().at(-1) ?? null,
      live_panel_verified: false }];
  }));
  const native = installedNative(repo);
  if (!native) return { adapters, git: { configured: false, automatic_commit_configuration_ready: false, editor_commit_verified: false } };
  const effectiveHooks = git(repo.root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']).trim();
  let hooksPathMatches = false;
  try { hooksPathMatches = samePath(effectiveHooks, native.directory); } catch { /* Missing paths are unhealthy. */ }
  const hooksPresent = NATIVE_HOOKS.every(name => file(join(native.directory, name)));
  const hooksExecutable = NATIVE_HOOKS.every(name => accessible(join(native.directory, name), constants.X_OK));
  const recorderReadable = accessible(native.recorder_executable, constants.R_OK);
  const nodeReadable = accessible(native.node_executable, constants.R_OK);
  const nodeExecutable = accessible(native.node_executable, constants.X_OK);
  return { adapters, git: {
    configured: true, expected_hooks_path: native.directory, effective_hooks_path: effectiveHooks,
    hooks_path_matches: hooksPathMatches, hooks_present: hooksPresent, hooks_executable: hooksExecutable,
    recorder_readable: recorderReadable, node_readable: nodeReadable, node_executable: nodeExecutable,
    automatic_commit_configuration_ready: hooksPathMatches && hooksPresent && hooksExecutable && recorderReadable === true && nodeExecutable === true,
    editor_commit_verified: false,
  } };
}
