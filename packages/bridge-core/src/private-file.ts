import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// Best-effort chmod: POSIX honors the mode bits, Windows ACLs are synthetic.
function safeChmodSync(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Permission enforcement is best-effort; a failed chmod must not break pairing.
  }
}

/** Create `dirPath` (and parents) with user-private permissions and tighten any pre-existing looser mode. */
export function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  safeChmodSync(dirPath, PRIVATE_DIR_MODE);
}

/** Tighten the permissions of an existing private file and its parent directory. */
export function hardenPrivateFile(filePath: string): void {
  safeChmodSync(dirname(filePath), PRIVATE_DIR_MODE);
  safeChmodSync(filePath, PRIVATE_FILE_MODE);
}

/**
 * Atomically publish `content` to `filePath` with user-private permissions.
 * The payload lands in a same-directory temporary file that is renamed over the
 * target, so a crash mid-write can never leave a torn credential file behind.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  ensurePrivateDir(dirname(filePath));
  const temporary = `${filePath}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    safeChmodSync(temporary, PRIVATE_FILE_MODE);
    renameSync(temporary, filePath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may already be gone; the original error wins.
    }
    throw error;
  }
}
