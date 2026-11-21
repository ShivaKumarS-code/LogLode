import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { normalizeRepoPath, resolveRepoContext } from './repo.js';
import { initTempGitRepo, withTempDir } from './testing/tmp.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function sha8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

async function withTempGitRepo<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await initTempGitRepo();
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}

describe('normalizeRepoPath', () => {
  it('converts backslashes and trims trailing slashes', () => {
    assert.equal(normalizeRepoPath('src\\adapters\\types.ts'), 'src/adapters/types.ts');
    assert.equal(normalizeRepoPath('src\\store\\'), 'src/store');
    assert.equal(normalizeRepoPath('src/store/'), 'src/store');
    assert.equal(normalizeRepoPath('src/store///'), 'src/store');
    assert.equal(normalizeRepoPath('C:\\Work\\Repo\\'), 'C:/Work/Repo');
    assert.equal(normalizeRepoPath(''), '');
    assert.equal(normalizeRepoPath('/'), '/');
    assert.equal(normalizeRepoPath('src\\nested/file.ts'), 'src/nested/file.ts');
  });
});

describe('resolveRepoContext', () => {
  it('returns the normalized root and a stable 8-hex hash inside a git repo', async () => {
    await withTempGitRepo(async (dir) => {
      const context = await resolveRepoContext(dir);

      assert.equal(context.repoRoot, normalizeRepoPath(dir));
      assert.match(context.repoHash, /^[0-9a-f]{8}$/);

      const again = await resolveRepoContext(dir);
      assert.deepStrictEqual(again, context);
    });
  });

  it('falls back to hashing the normalized root when there is no remote', async () => {
    await withTempGitRepo(async (dir) => {
      const context = await resolveRepoContext(dir);
      assert.equal(context.repoHash, sha8(normalizeRepoPath(context.repoRoot)));

      await git(dir, ['remote', 'add', 'origin', 'https://GitHub.com/Owner/Repo.git']);
      const withRemote = await resolveRepoContext(dir);
      assert.notEqual(withRemote.repoHash, context.repoHash);
    });
  });

  it('hashes the remote identity identically for HTTPS and scp-style URLs', async () => {
    await withTempGitRepo(async (dir) => {
      await git(dir, ['remote', 'add', 'origin', 'https://GitHub.com/Owner/Repo.git']);
      const https = await resolveRepoContext(dir);

      assert.equal(https.repoHash, sha8('github.com/Owner/Repo'));

      await git(dir, ['remote', 'set-url', 'origin', 'git@github.com:Owner/Repo.git']);
      const scp = await resolveRepoContext(dir);
      assert.equal(scp.repoHash, https.repoHash);

      await git(dir, ['remote', 'set-url', 'origin', 'ssh://git@github.com/Owner/Repo.git']);
      const ssh = await resolveRepoContext(dir);
      assert.equal(ssh.repoHash, https.repoHash);
    });
  });

  it('rejects a directory outside any git repository', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(resolveRepoContext(dir), /Not inside a git repository/);
    });
  });
});
