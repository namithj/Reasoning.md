import { stripVTControlCharacters } from 'node:util';
import { json, redact } from './schema.ts';

export type OutputFormat = 'auto' | 'text' | 'json';

// Captured text and paths must not execute terminal control sequences.
const terminalText = (value: string) => stripVTControlCharacters(redact(value).text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const label = (key: string) => (key[0]?.toUpperCase() ?? '') + key.slice(1).replaceAll('_', ' ');
const coverage = (status: string) => status === 'partial' ? 'Capture is partial; review missing exchanges before sharing.'
  : status === 'unavailable' ? 'No conversation capture is available.'
  : status === 'no_assistant_activity' ? 'No assistant activity was explicitly declared.' : '';

function details(value: any, indent = ''): string {
  if (value === null || value === undefined) return 'Not available';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'object') return String(value).replaceAll('\n', '\n' + indent);
  const entries = Array.isArray(value) ? value.map((item, i) => [String(i + 1), item]) : Object.entries(value);
  if (!entries.length) return 'None';
  return entries.map(([key, item]) => {
    const nested = item !== null && typeof item === 'object' && Object.keys(item).length > 0;
    return `${indent}${label(key)}:${nested ? '\n' : ' '}${details(item, indent + '  ')}`;
  }).join('\n');
}

export function formatOutput(command: string, value: any, format: OutputFormat = 'auto', terminal = false): string {
  if (format === 'json') return json(typeof value === 'string' ? { text: value } : value);
  if (format === 'auto' && !terminal) return typeof value === 'string' ? value : json(value);
  if (typeof value === 'string') return terminalText(value);

  let summary = '';
  let next = '';
  let data = value;
  switch (command) {
    case 'init':
      summary = 'Project initialized for conversation records.';
      next = 'Configure your assistant:\n  reasoning adapter enable claude-code\n  or: reasoning adapter enable codex\nThen inspect setup with reasoning doctor. Initialization alone does not enable capture. On Windows, use explicit transcript imports instead of automatic adapter setup.';
      break;
    case 'doctor': {
      const installations = value.capture?.installations ?? {};
      const sessions = Object.values(value.capture?.sessions ?? {}) as any[];
      summary = value.initialized ? 'Project initialized. Review the setup and capture checks below.' : 'This project has not been initialized.';
      data = {
        initialized: value.initialized,
        capture_status: value.recorder ? coverage(value.recorder.capture_status) : 'Initialize the project first',
        saved_events: value.recorder?.events ?? 0,
        queued_deliveries: value.recorder?.queued_capture_deliveries ?? 0,
        pending_transaction: value.recorder?.pending_transaction ?? false,
        lock_present: value.recorder?.lock_present ?? false,
        publication: value.recorder?.publication ?? null,
        commit_integration: value.recorder?.commit_integration === 'controlled_wrapper' ? 'Use reasoning commit to attach records' : value.recorder?.commit_integration ? 'Native hooks configured; editor compatibility unverified' : null,
        adapters: Object.fromEntries(Object.entries(installations).map(([host, setup]: [string, any]) => [host, { parser: setup.parser, surface: setup.surface, config_path: setup.config_path }])),
        capture_sessions: sessions.map(session => ({ session_id: session.session, host: session.host, task_id: session.task, gaps: session.gaps })),
        active_task: value.tasks?.active ?? null,
        environment: value.hosts?.[0]?.environment ? { platform: value.hosts[0].environment.platform, architecture: value.hosts[0].environment.architecture, container: value.hosts[0].environment.container, ssh: value.hosts[0].environment.ssh, wsl: value.hosts[0].environment.wsl } : null,
        assistant_extensions: value.hosts?.map((host: any) => ({ host: host.host, detected_versions: host.extension_installations.map((extension: any) => extension.version), inspection_errors: host.inspection_errors })),
        local_state: value.local_state, recorder_executable: value.recorder_executable, node_executable: value.node_executable,
      };
      const steps = [];
      if (!value.initialized) steps.push('Run reasoning init --publication private to set up this project.');
      else {
        if (value.recorder?.lock_present) steps.push('A recorder lock exists. Confirm its process has stopped before attempting recovery; do not delete live state.');
        if (value.recorder?.pending_transaction) steps.push('A commit transaction is pending. Inspect it with reasoning doctor and follow the recovery guide before retrying.');
        if (!Object.keys(installations).length) steps.push('No adapters are configured. Enable your assistant with reasoning adapter enable HOST, or import a supported transcript.');
        else if (!value.recorder?.events) steps.push('No events have been captured yet. Test a prompt, reply and tool call in your assistant, then run reasoning reconcile.');
        if (value.recorder?.queued_capture_deliveries || sessions.some(session => session.gaps?.length)) steps.push('Capture needs attention. Run reasoning reconcile, then compare the saved exchange with your assistant.');
      }
      steps.push('Detected extensions and configured adapters do not prove live capture. Assistant-panel compatibility remains unverified.');
      next = steps.join('\n');
      break;
    }
    case 'status':
      summary = `${value.events} saved events across ${value.sessions.length} sessions. ${coverage(value.capture_status)}`;
      next = value.pending_transaction ? 'A commit transaction is pending. Run reasoning doctor and follow the recovery guide.'
        : value.lock_present ? 'A recorder lock exists. Run reasoning doctor before attempting another write.'
        : value.queued_capture_deliveries ? 'Some deliveries are queued. Run reasoning reconcile to retry them.'
        : value.events ? 'Stage your changes, then run reasoning preview --staged to review the record.' : 'Run reasoning doctor to check adapter setup, or import a supported transcript.';
      break;
    case 'adapter enable':
      summary = `${value.host} configured for ${value.surface} capture. ${value.automatic_hook_configuration ? 'Assistant hook settings were written.' : 'No automatic assistant hooks were installed.'}`;
      next = value.automatic_hook_configuration ? 'Reload your assistant as its hook settings require, test an exchange, then run reasoning reconcile and reasoning doctor.' : 'Import a supported transcript, then inspect reasoning status.';
      break;
    case 'adapter list':
      summary = `${Object.keys(value.state.installations).length} adapters configured in this project.`;
      data = { adapters: Object.fromEntries(Object.entries(value.available).map(([host, spec]: [string, any]) => [host, { configured: Boolean(value.state.installations[host]), parser: value.state.installations[host]?.parser ?? spec.parser, surface: value.state.installations[host]?.surface ?? null }])) };
      next = 'Use reasoning adapter enable HOST to configure capture. Configuration does not verify assistant compatibility.';
      break;
    case 'adapter check':
      summary = value.fixture_or_session_content_check ? 'The supplied prompt, reply and tool activity were found.' : 'Some expected prompt, reply or tool activity is missing.';
      next = 'Compare the saved content with the actual assistant panel. This check does not certify complete capture.';
      break;
    case 'probe':
      summary = `Environment inspection for ${value.host}. This inspects metadata, not live capture.`;
      next = 'Run reasoning doctor for project configuration and capture status.';
      break;
    case 'skill':
      summary = `Companion skill installed for ${value.host}.`;
      next = 'Reload your assistant if needed so it can discover the skill. Skill installation does not enable capture.';
      break;
    case 'import':
    case 'capture':
      summary = `${value.added ?? 0} events added.${value.queued ? ' Delivery queued for a later retry.' : ''} ${coverage(value.capture_status)}`;
      next = 'Run reasoning status to inspect saved history and reasoning doctor for capture gaps.';
      break;
    case 'reconcile':
      summary = value.length ? `${value.reduce((count: number, item: any) => count + (item.added ?? 0), 0)} events added while reconciling known sources.` : 'No queued deliveries or transcript sessions to reconcile.';
      if (value.some((item: any) => item.error || item.queued || item.gaps?.length)) summary += ' Some sources still need attention; review the details below.';
      next = 'Run reasoning status to review capture. Reconciliation cannot discover transcripts that were never registered.';
      break;
    case 'commit':
    case 'recover':
      summary = value.committed === false ? 'The failed attempt was cleaned up. Events were retained; no new commit was created.'
        : value.commit ? `${value.recovered ? 'Recovered the existing commit' : 'Commit created with its conversation record'}. ${coverage(value.capture_status)}` : 'No pending commit transaction to recover.';
      next = value.commit ? `Read the saved conversation with reasoning show ${value.commit}. Nothing was pushed.`
        : value.events_retained ? 'Review your staged changes before running reasoning commit again.' : '';
      break;
    case 'export':
      summary = 'Standalone conversation snapshot written. Nothing was staged or committed.';
      next = 'Inspect the files in the directory below. Use reasoning commit to attach a new record to code; do not stage this snapshot.';
      break;
    case 'verify':
    case 'verify-range':
      summary = value.verified ? 'Record integrity and commit association checks passed.' : 'Some commits failed verification. Review each failure below.';
      next = 'Verification does not establish that every assistant message was captured.';
      break;
    case 'hooks install':
      summary = 'Native Git hooks installed for this repository and its linked worktrees.';
      next = 'Ordinary staged Git commits can now attach records. Test your editor separately; use reasoning hooks uninstall to restore the saved setting.';
      break;
    case 'hooks uninstall':
      summary = value.restored_original_hooks ? 'Native integration removed. The saved Git hook setting was restored.' : 'No native hook installation was found.';
      break;
    case 'policy':
      summary = `Coverage policy set to ${value.mode}.`;
      next = 'Stage .ai-history/config.json before your next commit.';
      break;
    case 'task start':
      summary = 'Task created and selected for new sessions.';
      next = `Use --task ${value.task_id} when selecting this task for a preview, commit or context handoff.`;
      break;
    case 'task list':
      summary = Object.keys(value.tasks).length ? `${Object.keys(value.tasks).length} local tasks. Use their IDs to select context or commit history.` : 'No local tasks yet.';
      next = 'Start a task with reasoning task start "Your objective". Archived tasks can still be found with reasoning search.';
      break;
    case 'task bind': summary = 'Session associated with the selected task.'; break;
    case 'decision':
      summary = 'Decision saved locally for the next conversation record.';
      next = 'Review it with reasoning preview --staged before committing.';
      break;
    case 'search':
      summary = value.matches.length ? `${value.matches.length} matching events${value.truncated ? ' shown; additional matches were omitted' : ''}.` : 'No matching conversation events found.';
      next = value.matches.length ? 'Use the task ID with reasoning context --task ID to read related discussion.' : 'Try a shorter search phrase, or run reasoning status to check available history.';
      break;
    case 'explain':
      summary = value.records.length ? `${value.records.length} conversation records mention changes to ${value.file}.` : `No conversation records found for ${value.file}.`;
      break;
  }
  return terminalText(`Reasoning.md — ${command}\n\n${summary}\n\n${details(data)}${next ? '\n\nNext steps\n' + next : ''}\n`);
}

export function formatError(message: string, human: boolean): string {
  const cleaned = redact(message).text;
  if (!human) return `reasoning: ${cleaned}\n`;
  let next = 'Run reasoning --help for command usage.';
  if (/locked|transaction|recover/i.test(message)) next = 'Run reasoning doctor and follow docs/controlled-commits.md before retrying. Preserve pending state.';
  else if (/Multiple tasks|Choose --task/i.test(message)) next = 'Run reasoning task list, then select a task with --task ID.';
  else if (/No staged|Stage .ai-history|Staged policy/i.test(message)) next = 'Review git status and stage the intended files and .ai-history/config.json before retrying.';
  else if (/Git rev-parse failed/i.test(message)) next = 'Run this command inside your project\'s Git checkout and check that Git is installed.';
  return terminalText(`Error: ${cleaned}\n\n${next}\n`);
}
