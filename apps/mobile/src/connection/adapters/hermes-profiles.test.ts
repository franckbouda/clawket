import { HERMES_PROFILES_CAPABILITY, scopeAgentAdapter, type ConnectionRecord } from '@clawket/agent-protocol';
import { GatewayClient } from '../protocol';
import { HermesAdapter, mapHermesSession } from './hermes';
import fixture from '../../../../../tests/fixtures/hermes/m3-multi-session-v2.json';

class FakeGateway {
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  state = 'idle';
  configure() {}
  on(name: string, listener: (payload: unknown) => void) {
    const set = this.listeners.get(name) ?? new Set(); set.add(listener); this.listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name: string, payload: unknown) { for (const callback of this.listeners.get(name) ?? []) callback(payload); }
  connect() {}
  disconnect() {}
  request = jest.fn(async (method: string, params: Record<string, unknown>): Promise<any> => {
    if (method === 'hermes.profiles.list') return { profiles: ['coder', 'work'].map(name => ({ name, agentId: `hermes-profile.${name}`, mainSessionKey: `agent:hermes-profile.${name}:main` })) };
    const profile = method === 'hermes.profile.request' ? params.profile : null;
    const inner = profile ? params.method : method;
    if (inner === 'sessions.list') return { sessions: [{ key: profile ? `agent:hermes-profile.${profile}:main` : 'main', title: 'Main', source: 'bridge', updatedAt: 1 }] };
    if (inner === 'sessions.create') return { session: { key: profile ? `agent:hermes-profile.${profile}:new` : 'new', title: 'New' } };
    if (inner === 'models.list') return { models: [] };
    if (inner === 'skills.status') return { skills: [] };
    if (inner === 'hermes.cron.jobs.list') return { jobs: [] };
    return { ok: true };
  });
  listModels = GatewayClient.prototype.listModels;
  getModelSelectionState = GatewayClient.prototype.getModelSelectionState;
  setModelSelection = GatewayClient.prototype.setModelSelection;
  getSkillsStatus = GatewayClient.prototype.getSkillsStatus;
  listAgentFiles = GatewayClient.prototype.listAgentFiles;
  listHermesCronJobs = GatewayClient.prototype.listHermesCronJobs;
  fetchUsage = GatewayClient.prototype.fetchUsage;
}
const record: ConnectionRecord = { id: 'profiles', backendKind: 'hermes', transportKind: 'local', label: 'My Mac', createdAt: 1, url: 'ws://localhost:4319/v1/hermes/ws' };
function setup(profiles = true) {
  const gateway = new FakeGateway();
  const adapter = new HermesAdapter(record, { gateway: gateway as unknown as GatewayClient, historyCache: null });
  gateway.emit('health', { ...fixture.firstFrame.payload, capabilities: [...fixture.firstFrame.payload.capabilities, ...(profiles ? [HERMES_PROFILES_CAPABILITY] : [])] });
  return { gateway, adapter };
}
afterEach(() => jest.clearAllMocks());
it('exposes each profile as an Agent, with isolated main keys and recorded legacy fallback', async () => {
  const { adapter } = setup();
  try {
    expect((await adapter.listAgents()).map(agent => [agent.agentId, agent.name, agent.mainSessionKey])).toEqual([
      ['hermes', 'My Mac', 'main'], ['hermes-profile.coder', 'coder', 'agent:hermes-profile.coder:main'], ['hermes-profile.work', 'work', 'agent:hermes-profile.work:main'],
    ]);
    expect((await adapter.listSessions()).map(session => [session.agentId, session.kind])).toEqual([['hermes', 'main'], ['hermes-profile.coder', 'main'], ['hermes-profile.work', 'main']]);
    expect((await adapter.listSessions('hermes-profile.work')).map(session => session.agentId)).toEqual(['hermes', 'hermes-profile.coder', 'hermes-profile.work']);
  } finally { adapter.dispose(); }
});
it('binds model, skills, files, cron and usage operations to the page Agent without global selection', async () => {
  const { adapter, gateway } = setup();
  try {
    const coder = scopeAgentAdapter(adapter, 'hermes-profile.coder')!;
    const work = scopeAgentAdapter(adapter, 'hermes-profile.work')!;
    await coder.management?.models?.list?.(); await work.management?.models?.setSelection?.({ model: 'fixture', scope: 'global' });
    await coder.management?.skills?.status?.(); await work.management?.agents?.files?.list?.();
    await coder.management?.cron?.list?.(); await work.management?.usage?.sessions?.({ startDate: '2026-10-01', endDate: '2026-10-15' });
    expect(gateway.request.mock.calls.map(([method, params]) => [method, params.profile, params.method])).toEqual([
      ['hermes.profile.request', 'coder', 'models.list'], ['hermes.profile.request', 'work', 'model.set'],
      ['hermes.profile.request', 'coder', 'skills.status'], ['hermes.profile.request', 'work', 'agents.files.list'],
      ['hermes.profile.request', 'coder', 'hermes.cron.jobs.list'], ['hermes.profile.request', 'work', 'sessions.usage'],
    ]);
  } finally { adapter.dispose(); }
});
it('creates sessions on the requested profile and preserves their Agent identity', async () => {
  const { adapter } = setup();
  try { expect(await adapter.createSession('hermes-profile.coder', { title: 'New' })).toMatchObject({ agentId: 'hermes-profile.coder', key: 'agent:hermes-profile.coder:new' }); }
  finally { adapter.dispose(); }
});
it('retains scoped page objects offline but refuses writes after negotiation is lost', async () => {
  const { adapter, gateway } = setup();
  try {
    const view = scopeAgentAdapter(adapter, 'hermes-profile.coder')!;
    const operations = view.management;
    gateway.emit('connection', { state: 'reconnecting' });
    expect(view.management).toBe(operations);
    await expect(operations?.models?.setSelection?.({ model: 'fixture' })).rejects.toThrow('Update');
    expect(scopeAgentAdapter(adapter, 'unknown')?.management).toEqual({});
    expect(gateway.request).not.toHaveBeenCalled();
  } finally { adapter.dispose(); }
});
it('keeps older Bridges on the single-Agent contract and rejects unnegotiated profile writes', async () => {
  const { adapter, gateway } = setup(false);
  try {
    expect(await adapter.listAgents()).toHaveLength(1); await adapter.listSessions();
    expect(gateway.request.mock.calls.map(([method]) => method)).toEqual(['sessions.list']);
    await expect(adapter.createSession('hermes-profile.coder')).rejects.toThrow('Update');
  } finally { adapter.dispose(); }
});
it('rejects corrupt or duplicate profile descriptors rather than showing a partial roster', async () => {
  const { adapter, gateway } = setup();
  gateway.request.mockResolvedValueOnce({ profiles: [{ name: '../work', agentId: 'x', mainSessionKey: 'main' }] });
  try { await expect(adapter.listAgents()).rejects.toThrow(); } finally { adapter.dispose(); }
});
it('keeps the native ID and read-only imported history contract when namespacing profiles', () => {
  expect(mapHermesSession('profiles', { key: 'agent:hermes-profile.coder:native:1', source: 'native', sessionId: 'native:1' })).toMatchObject({
    agentId: 'hermes-profile.coder', sessionId: 'native:1', allowedActions: { rename: false, reset: false, delete: false, pin: true },
  });
});
