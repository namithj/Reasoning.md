import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, json } from './schema.ts';

export type Repo = { root: string; gitDir: string; commonDir: string; stateDir: string; commonState: string };
export type Config = { schema_version: 1; repository_id: string; publication: 'private' | 'public'; mode: 'warn' | 'strict'; summarization: false };

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
  const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  const gitDir = realpathSync(git(cwd, ['rev-parse', '--absolute-git-dir']).trim());
  const commonDir = realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  // Keep the original storage directory so the Reasoning.md rename preserves existing journals and hooks.
  const stateDir = join(gitDir, 'reasoning-recorder');
  // Unusual --separate-git-dir layouts must not put the journal in trackable files.
  const rel = relative(root, gitDir);
  if (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) && rel !== '.git' && !rel.startsWith(`.git${sep}`)) {
    throw new Error('Git metadata is inside the trackable worktree; move the Git directory outside it');
  }
  return { root, gitDir, commonDir, stateDir, commonState: join(commonDir, 'reasoning-recorder') };
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
