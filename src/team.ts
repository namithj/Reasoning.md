import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, config, git, locked, privateDirectory, assertPlain } from './storage.ts';
import type { Repo } from './storage.ts';
import { verify } from './commits.ts';
import { json } from './schema.ts';

export function setPolicy(repo: Repo, mode: string) {
  if (!['warn', 'strict'].includes(mode)) throw new Error('Policy mode must be warn or strict');
  return locked(repo, () => {
    const current = config(repo); current.mode = mode as 'warn' | 'strict';
    atomicWrite(join(repo.root, '.ai-history', 'config.json'), json(current));
    return { mode, note: 'Stage the updated policy before committing. Strict mode blocks partial/unavailable capture unless an explicit override is recorded.' };
  });
}

export function installSkill(repo: Repo, host: string) {
  const locations: Record<string, string> = { codex: '.agents/skills', 'claude-code': '.claude/skills', 'copilot-vscode': '.github/skills', 'copilot-cli': '.github/skills' };
  if (!Object.hasOwn(locations, host)) throw new Error('Unknown companion skill host');
  const source = readFileSync(fileURLToPath(new URL('../skills/reasoning-md/SKILL.md', import.meta.url)), 'utf8');
  return locked(repo, () => {
    let parent = repo.root;
    for (const part of [...locations[host].split('/'), 'reasoning-md']) { parent = join(parent, part); privateDirectory(parent); }
    const path = join(parent, 'SKILL.md'); assertPlain(path, false);
    if (existsSync(path) && readFileSync(path, 'utf8') !== source) throw new Error('Existing companion skill differs; review it before replacing it');
    atomicWrite(path, source);
    return { installed: true, host, path, host_discovery_gate: 'not_tested_by_file_installation' };
  });
}

export function verifyRange(repo: Repo, range: string, requireComplete = false, allowOverrides = false) {
  const parts = range.split('..');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Use a two-dot BASE..HEAD range');
  const resolveRef = (ref: string) => git(repo.root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  const base = resolveRef(parts[0]); const tip = resolveRef(parts[1]);
  const commits = git(repo.root, ['rev-list', '--reverse', `${base}..${tip}`]).trim().split('\n').filter(Boolean);
  if (!commits.length) throw new Error('The verification range contains no commits');
  const results = commits.map(commit => {
    try {
      const result = verify(repo, commit); const primary = result.records.get(result.record_id)!;
      const complete = ['complete_for_declared_scope', 'no_assistant_activity'].includes(result.capture_status);
      if (requireComplete && !complete && !(allowOverrides && primary.manifest.capture_override)) throw new Error('Capture does not meet the required completeness policy');
      return { commit, record_id: result.record_id, capture_status: result.capture_status, verified: true };
    } catch (error) { return { commit, verified: false, error: (error as Error).message }; }
  });
  return { base, head: tip, verified: results.every(result => result.verified), results };
}
