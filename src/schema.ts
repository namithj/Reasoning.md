import { createHash } from 'node:crypto';

export const VERSION = '0.1.0-alpha.3';
export const INPUT_LIMIT = 5 * 1024 * 1024;
export const CONTENT_LIMIT = 16 * 1024;
export const TYPES = ['user_message', 'assistant_message', 'tool_call', 'tool_result',
  'explicit_decision', 'compaction_boundary', 'capture_gap', 'imported_content'] as const;
export type EventType = typeof TYPES[number];
export type Source = {
  tool: string; session_id: string; event_id: string;
  surface: 'extension' | 'cli' | 'desktop' | 'import';
  host_version: string | null; extension_version: string | null; locator: string;
};
export type InputEvent = {
  schema_version: 1; source: Source; task_id: string; sequence: number;
  timestamp: string | null; type: EventType; content: string; model: string | null; tool_call_id: string | null;
};
export type Event = InputEvent & {
  event_id: string; repository_id: string; worktree_id: string; environment_id: string;
  redaction: { rules: string[]; omissions: string[] };
};

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export const jsonl = (events: unknown[]) => events.map(e => JSON.stringify(e) + '\n').join('');

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value)) {
    throw new Error(`${label} must be a 1–160 character identifier (letters, digits, . _ : / -)`);
  }
  return value;
}

function string(value: unknown, label: string, limit = 1024): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${label} must be a string of at most ${limit} characters`);
  return value;
}

function fields(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} contains unsupported fields`);
}

export function parseInput(value: unknown): InputEvent {
  const v = object(value, 'event');
  fields(v, ['schema_version', 'source', 'task_id', 'sequence', 'timestamp', 'type', 'content', 'model', 'tool_call_id'], 'event');
  if (v.schema_version !== 1) throw new Error('Unsupported event schema_version; expected 1');
  const s = object(v.source, 'source');
  fields(s, ['tool', 'session_id', 'event_id', 'surface', 'host_version', 'extension_version', 'locator'], 'source');
  const tool = identifier(s.tool, 'source.tool');
  if (!['claude-code', 'codex', 'copilot-vscode', 'copilot', 'chatgpt', 'manual'].includes(tool)) throw new Error('Unsupported source.tool');
  if (!['extension', 'cli', 'desktop', 'import'].includes(s.surface as string)) throw new Error('Unsupported source.surface');
  if (!Number.isSafeInteger(v.sequence) || (v.sequence as number) < 0) throw new Error('sequence must be a non-negative safe integer');
  if (!TYPES.includes(v.type as EventType)) throw new Error('Unsupported event type');
  const timestamp = v.timestamp == null ? null : string(v.timestamp, 'timestamp', 40);
  if (timestamp !== null && (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)))) {
    throw new Error('timestamp must be an ISO 8601 timestamp with timezone, or null');
  }
  return {
    schema_version: 1,
    source: {
      tool, session_id: identifier(s.session_id, 'source.session_id'),
      event_id: identifier(s.event_id, 'source.event_id'), surface: s.surface as Source['surface'],
      host_version: s.host_version == null ? null : string(s.host_version, 'source.host_version', 160),
      extension_version: s.extension_version == null ? null : string(s.extension_version, 'source.extension_version', 160),
      locator: string(s.locator, 'source.locator'),
    },
    task_id: identifier(v.task_id, 'task_id'), sequence: v.sequence as number, timestamp,
    type: v.type as EventType, content: string(v.content, 'content', INPUT_LIMIT),
    model: v.model == null ? null : string(v.model, 'model', 160),
    tool_call_id: v.tool_call_id == null ? null : identifier(v.tool_call_id, 'tool_call_id'),
  };
}

export function parseLines(text: string): InputEvent[] {
  if (Buffer.byteLength(text) > INPUT_LIMIT) throw new Error('Input exceeds the 5 MiB batch limit; split it into smaller batches');
  return text.split('\n').flatMap((line, i) => {
    if (!line.trim()) return [];
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid JSON at line ${i + 1}`); }
    try { return [parseInput(value)]; } catch (error) { throw new Error(`Line ${i + 1}: ${(error as Error).message}`); }
  });
}

const RULES: [string, RegExp, string][] = [
  ['private_key', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/g, '[REDACTED:private_key]'],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED:github_token]'],
  ['api_token', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api_token]'],
  ['aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED:aws_access_key]'],
  ['authorization', /\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, '$1 [REDACTED:authorization]'],
  ['credential_assignment', /(["']?\b(?:[A-Z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Z0-9_]*|authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;\]}]+)/gi, '$1"[REDACTED:credential_assignment]"'],
  ['url_password', /(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1[REDACTED:url_password]@'],
];

export function redact(text: string): { text: string; rules: string[] } {
  const rules: string[] = [];
  for (const [name, pattern, replacement] of RULES) {
    let matched = false;
    text = text.replace(pattern, (...args) => {
      matched = true;
      return replacement.replace(/\$(\d)/g, (_, n) => args[Number(n)] ?? '');
    });
    if (matched) rules.push(name);
  }
  return { text, rules };
}

export function normalize(input: InputEvent, identity: { repository_id: string; worktree_id: string; environment_id: string }): Event {
  const rules = new Set<string>();
  const clean = (value: string) => {
    const result = redact(value);
    result.rules.forEach(rule => rules.add(rule));
    return result.text;
  };
  // Scan the complete content before truncation, including multiline private keys.
  let content = clean(input.content);
  const omissions: string[] = [];
  if ((input.content.match(/^[A-Z_][A-Z0-9_]*=.+$/gm) ?? []).length >= 3) {
    content = '[OMITTED: environment dump]'; omissions.push('environment_dump');
  } else if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.content) || /data:[^;\s]+;base64,/.test(input.content)) {
    content = '[OMITTED: binary content]'; omissions.push('binary_content');
  } else if (content.length > CONTENT_LIMIT) {
    content = content.slice(0, CONTENT_LIMIT) + '\n[OMITTED: content exceeds 16384 characters]';
    omissions.push('content_limit');
  }
  const source = Object.fromEntries(Object.entries(input.source).map(([key, value]) => [key, value === null ? null : clean(value)])) as Source;
  return {
    ...input, source, task_id: clean(input.task_id), model: input.model === null ? null : clean(input.model),
    tool_call_id: input.tool_call_id === null ? null : clean(input.tool_call_id), content,
    event_id: hash(JSON.stringify([input.source.tool, input.source.session_id, input.source.event_id])),
    ...identity, redaction: { rules: [...rules].sort(), omissions },
  };
}
