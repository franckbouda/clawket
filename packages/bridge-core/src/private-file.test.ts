import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hardenPrivateFile, writeFileAtomic } from './private-file.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('private file helpers', () => {
  it('writes content with user-private file and directory permissions', () => {
    const dir = makeTempDir('clawket-private-file-write-');
    const target = join(dir, 'nested', 'secret.json');

    writeFileAtomic(target, '{"a":1}\n');

    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n');
  });

  it('replaces an existing file atomically without leaving temporary files', () => {
    const dir = makeTempDir('clawket-private-file-replace-');
    const target = join(dir, 'secret.json');

    writeFileAtomic(target, 'first\n');
    writeFileAtomic(target, 'second\n');

    expect(readFileSync(target, 'utf8')).toBe('second\n');
    expect(readdirSync(dir)).toEqual(['secret.json']);
  });

  it('removes the temporary file when the rename cannot publish', () => {
    const dir = makeTempDir('clawket-private-file-fail-');
    const target = join(dir, 'blocked');
    mkdirSync(target); // A directory at the target path makes the rename fail.

    expect(() => writeFileAtomic(target, 'nope\n')).toThrow();
    expect(readdirSync(dir)).toEqual(['blocked']);
  });

  it('tightens an existing loose file into user-private permissions', () => {
    if (process.platform === 'win32') return; // Windows exposes synthetic POSIX mode bits.
    const dir = makeTempDir('clawket-private-file-harden-');
    const target = join(dir, 'loose.json');
    writeFileSync(target, 'x\n', { mode: 0o644 });
    chmodSync(dir, 0o755);

    hardenPrivateFile(target);

    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
