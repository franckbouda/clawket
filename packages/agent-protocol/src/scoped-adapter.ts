import type { AgentAdapter } from './adapter';
const views = new WeakMap<AgentAdapter, Map<string, AgentAdapter>>();
/** A stable presentation view. Lifecycle and transport methods always keep their original receiver. */
export function scopeAgentAdapter(adapter: AgentAdapter | null, agentId: string | undefined): AgentAdapter | null {
  if (!adapter?.managementForAgent || !agentId) return adapter;
  let cache = views.get(adapter);
  if (!cache) { cache = new Map(); views.set(adapter, cache); }
  const existing = cache.get(agentId);
  if (existing) return existing;
  const methods = new Map<PropertyKey, unknown>();
  const view = new Proxy(adapter, { get(target, key) {
    if (key === 'management') return target.managementForAgent!(agentId);
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (!methods.has(key)) methods.set(key, value.bind(target));
    return methods.get(key);
  } });
  cache.set(agentId, view);
  return view;
}
