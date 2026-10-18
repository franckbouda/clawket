import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyOwnerRecord, parseOwnerLockRecord, readProcessStartedAt } from './process-identity.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('readProcessStartedAt', () => {
  it('returns null for invalid pids without invoking ps', () => {
    expect(readProcessStartedAt(0)).toBeNull();
    expect(readProcessStartedAt(-5)).toBeNull();
    expect(readProcessStartedAt(Number.NaN)).toBeNull();
  });
});

describe('parseOwnerLockRecord', () => {
  it('parses legacy bare-PID files', () => {
    expect(parseOwnerLockRecord('12345')).toEqual({ pid: 12345 });
  });
  it('parses current JSON records with and without a start time', () => {
    expect(parseOwnerLockRecord(JSON.stringify({ v: 1, pid: 7 }))).toEqual({ pid: 7 });
    expect(parseOwnerLockRecord(JSON.stringify({ v: 1, pid: 7, startedAt: 'Fri Oct 03 12:00:00 2024' })))
      .toEqual({ pid: 7, startedAt: 'Fri Oct 03 12:00:00 2024' });
  });
  it.each(['', 'invalid', '0', '-1', '9'.repeat(33), JSON.stringify({ v: 2, pid: 7 }), JSON.stringify({ v: 1, pid: 0 }),
    JSON.stringify({ v: 1, pid: -1 }), JSON.stringify({ v: 1, pid: Number.MAX_SAFE_INTEGER + 1 }),
    JSON.stringify({ v: 1, startedAt: 'x' }), JSON.stringify({ v: 1, pid: 7, startedAt: 42 })])('rejects %j', text => {
    expect(parseOwnerLockRecord(text)).toBeNull();
  });
});

describe('classifyOwnerRecord', () => {
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])('rejects pid %j as unknown', pid => {
    expect(classifyOwnerRecord({ pid })).toBe('unknown');
  });
  it('classifies a confirmed dead process as stale', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    expect(classifyOwnerRecord({ pid: 12345 })).toBe('stale');
    expect(classifyOwnerRecord({ pid: 12345, startedAt: 'Fri Oct 03 12:00:00 2024' })).toBe('stale');
  });
  it('keeps a legacy live record without a start time as live', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(classifyOwnerRecord({ pid: process.pid })).toBe('live');
  });
  it('rethrows unexpected kill errors instead of guessing', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(() => classifyOwnerRecord({ pid: process.pid })).toThrow('denied');
  });
  it('verifies the OS start time of a live PID (POSIX)', () => {
    if (process.platform === 'win32') return; // Start-time identity is unavailable on Windows.
    const startedAt = readProcessStartedAt(process.pid);
    expect(startedAt).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
    expect(classifyOwnerRecord({ pid: process.pid, startedAt })).toBe('live');
    expect(classifyOwnerRecord({ pid: process.pid, startedAt: 'Fri Oct 03 12:00:00 2024' })).toBe('stale');
  });
});
