import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, json } from './schema.ts';

export type Repo = { root: string; gitDir: string; commonDir: string; stateDir: string; commonState: string };
export type Config = { schema_version: 1; repository_id: string; publication: 'private' | 'public'; mode: 'warn' | 'strict'; summarization: false };
export type ProjectContext = { repo: Repo; workspaceRoot: string; discovery: 'ancestor' | 'descendant' | 'explicit' };
export type WorkspaceBinding = { schema_version: 1; workspace_root: string; repository_root: string; discovery: ProjectContext['discovery'] };

export const canonicalPath = (path: string) => realpathSync.native(path);

export function samePath(left: string, right: string) {
  const a = statSync(left, { bigint: true }); const b = statSync(right, { bigint: true });
  return a.dev === b.dev && a.ino === b.ino && (a.ino !== 0n || canonicalPath(left) === canonicalPath(right));
}

export function containsPath(parent: string, child: string) {
  let current = child;
  while (true) {
    if (samePath(parent, current)) return true;
    const next = dirname(current);
    if (next === current) return false;
    current = next;
  }
}

export function git(cwd: string, args: string[]): string {
  return gitBytes(cwd, args).toString('utf8');
}

export function gitBytes(cwd: string, args: string[]): Buffer {
  try {
    return execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new Error(`Git ${args[0]} failed; check the repository, index and Git installation`); }
}

export function repository(cwd = process.cwd()): Repo {
  const root = canonicalPath(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  const gitDir = canonicalPath(git(cwd, ['rev-parse', '--absolute-git-dir']).trim());
  const commonDir = canonicalPath(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  // Keep the original storage directory so the Reasoning.md rename preserves existing journals and hooks.
  const stateDir = join(gitDir, 'reasoning-recorder');
  // Unusual --separate-git-dir layouts must not put the journal in trackable files.
  const rel = relative(root, gitDir);
  if (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) && rel !== '.git' && !rel.startsWith(`.git${sep}`)) {
    throw new Error('Git metadata is inside the trackable worktree; move the Git directory outside it');
  }
  return { root, gitDir, commonDir, stateDir, commonState: join(commonDir, 'reasoning-recorder') };
}

const DISCOVERY_SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor']);
// ponytail: Bound automatic scans in huge workspaces; --repo is the explicit upgrade path.
const DISCOVERY_LIMIT = 4096;

export function workspaceBinding(repo: Repo): WorkspaceBinding | null {
  const path = join(repo.stateDir, 'workspace.json');
  if (!existsSync(path)) return null;
  const value = readJSON(path) as WorkspaceBinding;
  if (value.schema_version !== 1 || !isAbsolute(value.workspace_root) || !isAbsolute(value.repository_root)
    || !['ancestor', 'descendant', 'explicit'].includes(value.discovery)) throw new Error('Invalid workspace binding');
  if (!samePath(value.repository_root, repo.root)) throw new Error('Workspace binding points to a different repository');
  const root = canonicalPath(value.workspace_root);
  if (!containsPath(root, repo.root)) throw new Error('Workspace binding does not contain the repository');
  return { ...value, workspace_root: root, repository_root: repo.root };
}

export function bindWorkspace(repo: Repo, workspaceRoot: string, discovery: ProjectContext['discovery']): WorkspaceBinding {
  const root = canonicalPath(workspaceRoot);
  if (!containsPath(root, repo.root)) throw new Error('Workspace root must contain the selected repository');
  const value: WorkspaceBinding = { schema_version: 1, workspace_root: root, repository_root: repo.root, discovery };
  privateDirectory(repo.stateDir); atomicWrite(join(repo.stateDir, 'workspace.json'), json(value));
  return value;
}

export function discoverProject(cwd = process.cwd(), selected?: string): ProjectContext {
  const invocation = canonicalPath(cwd);
  if (selected) {
    const repo = repository(resolve(invocation, selected)); const saved = workspaceBinding(repo);
    return { repo, workspaceRoot: saved?.workspace_root ?? invocation, discovery: 'explicit' };
  }
  let current: Repo | null = null;
  try { current = repository(invocation); } catch { /* Search below a non-Git workspace. */ }
  if (current) {
    const saved = workspaceBinding(current);
    return { repo: current, workspaceRoot: saved?.workspace_root ?? current.root, discovery: saved?.discovery ?? 'ancestor' };
  }

  let level = [invocation]; let inspected = 0;
  while (level.length) {
    const next: string[] = []; const candidates = new Map<string, { repo: Repo; name: string }>();
    for (const parent of level) {
      let entries;
      try { entries = readdirSync(parent, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || DISCOVERY_SKIP.has(entry.name)) continue;
        if (++inspected > DISCOVERY_LIMIT) throw new Error('Git checkout discovery exceeded its safe directory limit; use --repo PATH');
        const child = join(parent, entry.name); const marker = join(child, '.git');
        let hasMarker = false;
        try { const stat = lstatSync(marker); hasMarker = !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()); } catch { /* Not a worktree root. */ }
        if (hasMarker) {
          try { const repo = repository(child); candidates.set(repo.root, { repo, name: relative(invocation, child) || '.' }); } catch { /* Ignore invalid Git markers. */ }
        } else next.push(child);
      }
    }
    if (candidates.size === 1) return { repo: [...candidates.values()][0].repo, workspaceRoot: invocation, discovery: 'descendant' };
    if (candidates.size > 1) {
      const names = [...candidates.values()].map(candidate => candidate.name).sort().join(', ');
      throw new Error(`Multiple Git checkouts found below this workspace: ${names}. Use --repo PATH`);
    }
    level = next;
  }
  throw new Error('No Git checkout found at or below the current workspace; run from a project or use --repo PATH');
}

export function assertPlain(path: string, directory: boolean) {
  if (!existsSync(path)) {
    // existsSync follows dangling symlinks; lstat still detects those.
    try { lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('Recorder path must be a regular file or directory, never a symlink');
  }
}

export function privateDirectory(path: string) {
  assertPlain(path, true);
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function syncDirectory(path: string) {
  // Windows does not support opening directories for fsync via Node.
  if (platform() === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function atomicWrite(path: string, data: string) {
  assertPlain(path, false);
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, path); syncDirectory(resolve(path, '..')); }
  finally { rmSync(temp, { force: true }); }
}

export function locked<T>(repo: Repo, action: () => T): T {
  privateDirectory(repo.stateDir);
  const lock = join(repo.stateDir, 'lock');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Recorder is locked. Run reasoning doctor; do not remove a lock while its process is running');
    throw error;
  }
  try {
    writeFileSync(fd, json({ pid: process.pid, hostname: hostname(), started_at: new Date().toISOString() }));
    fsyncSync(fd);
    return action();
  } finally { closeSync(fd); rmSync(lock); }
}

export function readJSON(path: string): unknown {
  assertPlain(path, false);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Missing or invalid recorder JSON; inspect local state/configuration before retrying'); }
}

export function config(repo: Repo): Config {
  assertPlain(join(repo.root, '.ai-history'), true);
  const value = readJSON(join(repo.root, '.ai-history', 'config.json')) as Config;
  if (!value || value.schema_version !== 1 || !/^[0-9a-f-]{36}$/.test(value.repository_id)
    || !['private', 'public'].includes(value.publication) || !['warn', 'strict'].includes(value.mode) || value.summarization !== false) {
    throw new Error('Unsupported recorder configuration');
  }
  return value;
}

export function initialize(repo: Repo, publication: string): Config {
  if (!['public', 'private'].includes(publication)) throw new Error('Choose --publication public or --publication private; exported conversations inherit repository access');
  // A shared lock protects identity creation across worktrees.
  return locked({ ...repo, stateDir: repo.commonState }, () => {
    privateDirectory(join(repo.root, '.ai-history'));
    const path = join(repo.root, '.ai-history', 'config.json');
    const identityPath = join(repo.commonState, 'repository-id');
    assertPlain(identityPath, false);
    if (existsSync(path)) {
      const existing = config(repo);
      if (existing.publication !== publication) throw new Error('Existing publication policy differs; review and edit config.json explicitly');
      if (existsSync(identityPath) && readFileSync(identityPath, 'utf8').trim() !== existing.repository_id) {
        throw new Error('Tracked and local repository identities differ; preserve state and resolve the mismatch before initialization');
      }
      if (!existsSync(identityPath)) atomicWrite(identityPath, existing.repository_id + '\n');
      return existing;
    }
    const repository_id = existsSync(identityPath) ? readFileSync(identityPath, 'utf8').trim() : randomUUID();
    if (!/^[0-9a-f-]{36}$/.test(repository_id)) throw new Error('Invalid local repository identity');
    if (!existsSync(identityPath)) atomicWrite(identityPath, repository_id + '\n');
    const value: Config = { schema_version: 1, repository_id, publication: publication as Config['publication'], mode: 'warn', summarization: false };
    atomicWrite(path, json(value));
    return value;
  });
}

export function environment() {
  return {
    platform: platform(), architecture: process.arch,
    wsl: /microsoft/i.test(release()) || Boolean(process.env.WSL_DISTRO_NAME),
    ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
    container: existsSync('/.dockerenv') || existsSync('/run/.containerenv') || Boolean(process.env.REMOTE_CONTAINERS),
    vscode: Boolean(process.env.VSCODE_IPC_HOOK_CLI || process.env.TERM_PROGRAM === 'vscode'),
    environment_id: hash(JSON.stringify([hostname(), platform(), process.arch])),
  };
}

export function identity(repo: Repo) {
  return { repository_id: config(repo).repository_id, worktree_id: hash(repo.gitDir), environment_id: environment().environment_id };
}
