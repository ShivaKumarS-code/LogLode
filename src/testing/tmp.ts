/**
 * Test helpers shared by later LogLode pieces.
 *
 * Tests must never touch the real `~/.loglode` directory or require network
 * access, so all scratch state lives under `os.tmpdir()` and temp git repos are
 * fully self-contained (local user identity, no hooks/signing, no remote).
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Create a temp directory and return its canonical path.
 *
 * On Windows `os.tmpdir()` can be an 8.3 short path (e.g. `C:\Users\SHIVAK~1\...`)
 * while `git` and other tools report the long form. Canonicalizing with
 * `fs.realpath` keeps test paths comparable to tool output and keeps repo hashes
 * stable across short/long spellings of the same directory.
 */
async function createTempDir(prefix: string): Promise<string> {
  const created = await fs.mkdtemp(join(tmpdir(), prefix));
  try {
    return await fs.realpath(created);
  } catch {
    return created;
  }
}

/**
 * Create a temp directory, run `fn` with it, and always remove it afterwards.
 * Cleanup is best-effort because Windows can briefly hold handles on removed
 * git/SQLite files; a stubborn directory must not fail an otherwise green test.
 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await createTempDir('loglode-test-');
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  // Never let a caller's repository environment leak into the fixture repo.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;

  const { stdout } = await execFileAsync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  return String(stdout);
}

/**
 * Initialize a disposable git repository containing one empty commit and return
 * its path. The caller owns cleanup. Local identity is configured explicitly so
 * the fixture works on machines with no global git user config; hooks and commit
 * signing are disabled per invocation so only local repo state matters.
 */
export async function initTempGitRepo(): Promise<string> {
  const dir = await createTempDir('loglode-git-');
  try {
    const configOverrides = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath='];
    await runGit(dir, ['init', '-b', 'main']);
    await runGit(dir, ['config', 'user.email', 'loglode-test@example.invalid']);
    await runGit(dir, ['config', 'user.name', 'LogLode Test']);
    await runGit(dir, [...configOverrides, 'commit', '--allow-empty', '-m', 'init']);
    return dir;
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    throw error;
  }
}
