import { execFileSync } from 'node:child_process';

const PS_STARTED_AT = /^\s*([A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/;

/**
 * OS start time of a live process, normalized to single-space fields.
 * Returns null when it cannot be inspected (win32, missing ps, timeout, parse failure).
 */
export function readProcessStartedAt(pid: number): string | null {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stdout = execFileSync('ps', ['-ww', '-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      timeout: 3_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = stdout.split('\n').find(candidate => candidate.trim()) ?? '';
    const match = PS_STARTED_AT.exec(line);
    return match ? match[1].replace(/\s+/g, ' ') : null;
  } catch {
    return null;
  }
}

export type OwnerLiveness = 'live' | 'stale' | 'unknown';

/** A parsed owner lock: legacy bare-PID files or the current JSON record. */
export type OwnerLockRecord = { pid: number; startedAt?: string };

/** Parse a legacy bare-PID lock or the current `{ v: 1, pid, startedAt? }` JSON record; null when malformed. */
export function parseOwnerLockRecord(text: string): OwnerLockRecord | null {
  if (/^[1-9]\d{0,9}$/.test(text)) return { pid: Number(text) };
  try {
    const value = JSON.parse(text) as Partial<OwnerLockRecord> & { v?: unknown };
    const pid = value?.pid;
    if (value?.v !== 1 || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
    if (value.startedAt !== undefined && typeof value.startedAt !== 'string') return null;
    return { pid, ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}) };
  } catch { return null; }
}

/**
 * Classify a recorded owner lock.
 * - 'stale': the process is gone, or its OS start time no longer matches (PID reuse).
 * - 'live': the same process still runs.
 * - 'unknown': staleness cannot be proven (invalid pid, non-ESRCH kill error, ps failure);
 *   callers must fail closed and never remove the lock.
 * Non-ESRCH kill errors are rethrown so unexpected errno states stay visible.
 */
export function classifyOwnerRecord(record: { pid: number; startedAt?: string | null }): OwnerLiveness {
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return 'unknown';
  let alive = true;
  try { process.kill(record.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
  if (!alive) return 'stale';
  const startedAt = record.startedAt ?? null;
  if (!startedAt) return 'live'; // Legacy record without a start time: keep the previous fail-closed behavior.
  const current = readProcessStartedAt(record.pid);
  if (current === null) return 'unknown';
  return current === startedAt ? 'live' : 'stale';
}
