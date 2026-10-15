import { expect, it, vi } from 'vitest';
import type { AgentAdapter } from './adapter';
import { scopeAgentAdapter } from './scoped-adapter';
it('keeps private lifecycle receivers and stable Agent operations without mutating the owner', () => {
  const coder = { models: { list: vi.fn(async () => []) } };
  class Owner {
    #state = 'ready';
    management = {};
    managementForAgent = vi.fn((id: string) => id === 'coder' ? coder : {});
    get state() { return this.#state; }
    disconnect() { this.#state = 'offline'; }
  }
  const owner = new Owner(); const adapter = owner as unknown as AgentAdapter;
  const view = scopeAgentAdapter(adapter, 'coder')!;
  expect(scopeAgentAdapter(adapter, 'coder')).toBe(view);
  expect(view.management).toBe(coder); expect(owner.management).not.toBe(coder);
  expect(view.state).toBe('ready'); expect(view.disconnect).toBe(view.disconnect);
  view.disconnect(); expect(view.state).toBe('offline'); expect(owner.state).toBe('offline');
  expect(scopeAgentAdapter(adapter, 'work')!.management).not.toBe(coder);
});
it('keeps adapters without scoped management, null and an absent Agent unchanged', () => {
  const plain = { management: {} } as AgentAdapter;
  expect(scopeAgentAdapter(plain, 'main')).toBe(plain);
  expect(scopeAgentAdapter(null, 'main')).toBeNull();
  expect(scopeAgentAdapter(plain, undefined)).toBe(plain);
});
