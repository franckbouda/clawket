import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { classifyOwnerRecord, parseOwnerLockRecord, readProcessStartedAt } from '@clawket/bridge-core';

const MAX_OWNER_LOCK_BYTES = 256;

/** Serialize recovery of a dead writer and verify the owner's process identity (PID + OS start time). */
export function acquireCodexOwnerLock(path: string): () => void {
  const startedAt = readProcessStartedAt(process.pid);
  const owner = JSON.stringify({ v: 1, pid: process.pid, ...(startedAt ? { startedAt } : {}) });
  const create = () => writeFileSync(path, owner, { flag: 'wx', mode: 0o600 });
  try { create(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const recoveryPath = path + '.recovery', recovery = randomUUID();
    try { writeFileSync(recoveryPath, recovery, { flag: 'wx', mode: 0o600 }); }
    catch { throw new Error('Codex owner recovery is already in progress'); }
    try {
      const prior = lstatSync(path);
      if (!prior.isFile() || prior.nlink !== 1 || prior.size > MAX_OWNER_LOCK_BYTES) throw new Error('Invalid Codex owner lock');
      const text = readFileSync(path, 'utf8');
      const record = parseOwnerLockRecord(text);
      if (!record) throw new Error('Invalid Codex owner lock');
      const liveness = classifyOwnerRecord(record);
      if (liveness === 'live') throw new Error('This Codex project is already managed by another Bridge');
      if (liveness === 'unknown') throw new Error('The Codex owner process could not be verified; inspect local Bridge state.');
      const current = lstatSync(path);
      if (current.ino !== prior.ino || current.dev !== prior.dev || readFileSync(path, 'utf8') !== text) {
        throw new Error('Codex owner changed during recovery');
      }
      unlinkSync(path); create();
    } finally {
      try { if (readFileSync(recoveryPath, 'utf8') === recovery) unlinkSync(recoveryPath); } catch { /* Fail closed. */ }
    }
  }
  const acquired = lstatSync(path);
  return () => {
    try {
      const current = lstatSync(path);
      if (current.ino === acquired.ino && current.dev === acquired.dev && readFileSync(path, 'utf8') === owner) unlinkSync(path);
    } catch { /* Never remove a replacement owner's lock. */ }
  };
}
