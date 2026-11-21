/**
 * Repository identity helpers.
 *
 * `repo_hash` is the cross-session key used by the trajectory store, so it must be
 * stable for the same repository even when it lives at a different absolute path
 * (fresh clones, CI checkouts) and stable across Windows/POSIX path spellings.
 * We therefore prefer hashing the normalized `origin` remote and fall back to the
 * normalized absolute root for repositories without a remote.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { RepoContext } from './adapters/types.js';

const execFileAsync = promisify(execFile);

interface GitOutput {
  stdout: string;
  stderr: string;
}

async function runGit(cwd: string, args: string[]): Promise<GitOutput> {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { stdout: String(stdout), stderr: String(stderr) };
}

/** Convert a path to repo-relative / POSIX style and drop trailing slashes. */
export function normalizeRepoPath(p: string): string {
  const replaced = p.replace(/\\/g, '/');
  if (replaced === '') {
    return '';
  }
  let normalized = replaced;
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function stripUserInfo(authority: string): string {
  const at = authority.lastIndexOf('@');
  return at === -1 ? authority : authority.slice(at + 1);
}

/**
 * Reduce a git remote URL to a host/path identity such as
 * `github.com/owner/repo`:
 * - `https://github.com/owner/repo.git` -> `github.com/owner/repo`
 * - `git@github.com:owner/repo.git`      -> `github.com/owner/repo`
 * - `ssh://git@github.com/owner/repo`    -> `github.com/owner/repo`
 *
 * The host is lowercased; the path keeps its case. Local filesystem remotes keep
 * only their normalized path.
 */
function normalizeRemoteUrl(remote: string): string {
  let value = remote.trim().replace(/\\/g, '/');
  if (value === '') {
    return '';
  }

  let host: string | null = null;
  let path: string;

  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (scheme !== null) {
    value = value.slice(scheme[0].length);
    const slash = value.indexOf('/');
    if (slash === -1) {
      host = value;
      path = '';
    } else {
      host = value.slice(0, slash);
      path = value.slice(slash + 1);
    }
  } else if (/^[A-Za-z]:\//.test(value)) {
    path = value;
  } else {
    // scp-like syntax: [user@]host:path
    const colon = value.indexOf(':');
    if (colon > 0 && !value.slice(0, colon).includes('/')) {
      host = value.slice(0, colon);
      path = value.slice(colon + 1);
    } else {
      path = value;
    }
  }

  path = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');

  if (host !== null) {
    const normalizedHost = stripUserInfo(host).toLowerCase();
    if (normalizedHost !== '') {
      return path === '' ? normalizedHost : `${normalizedHost}/${path}`;
    }
  }
  return path;
}

function hashIdentity(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 8);
}

async function readOriginRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ['config', '--get', 'remote.origin.url']);
    const remote = stdout.trim();
    return remote === '' ? null : remote;
  } catch {
    return null;
  }
}

/**
 * Resolve the repository root and stable 8-hex `repoHash` for `cwd`.
 * Rejects when `cwd` is not inside a git working tree.
 */
export async function resolveRepoContext(cwd: string): Promise<RepoContext> {
  let topLevel: string;
  try {
    const { stdout } = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    topLevel = stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error);
    throw new Error(`Not inside a git repository: could not resolve the repository root from '${cwd}' (${detail}).`);
  }

  if (topLevel === '') {
    throw new Error(`Not inside a git repository: git returned an empty root for '${cwd}'.`);
  }

  const repoRoot = normalizeRepoPath(topLevel);
  const remote = await readOriginRemote(cwd);
  const remoteIdentity = remote === null ? '' : normalizeRemoteUrl(remote);
  const identity = remoteIdentity === '' ? repoRoot : remoteIdentity;

  return { repoRoot, repoHash: hashIdentity(identity) };
}
