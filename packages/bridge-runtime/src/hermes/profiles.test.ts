import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesLocalBridge } from './index.js';
import { projectProfilePayload } from './profiles.js';
import { hermesProfileSessionKey } from '@clawket/agent-protocol';
const roots: string[] = []; const bridges: HermesLocalBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop())); vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hermes-profiles-')); roots.push(root);
  for (const name of ['coder', 'work']) {
    const home = join(root, 'home', 'profiles', name); await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.yaml'), 'model: fixture\n');
    const state = join(root, 'clawket', 'hermes-profiles', name); await mkdir(state, { recursive: true });
    await writeFile(join(state, 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ key: 'same', sessionId: `clawket-hermes:${name}`, title: name, updatedAt: 1 }] }));
  }
  const owner = new HermesLocalBridge({ hermesHomePath: join(root, 'home'), hermesSourcePath: join(root, 'source'),
    sessionStorePath: join(root, 'clawket', 'sessions.json'), usageLedgerPath: join(root, 'clawket', 'usage.json'), startHermesIfNeeded: false });
  bridges.push(owner); vi.spyOn(owner, 'runHermesPython').mockResolvedValue('profile-api-key-12345'); return { root, owner };
}
describe('Hermes profile routing', () => {
  it.each([[true, 200, true], [false, 200, false], [true, 404, false]] as const)('negotiates profile support only with native implementation=%s and routed API=%s', async (native, status, expected) => {
    const { owner } = await fixture(); vi.mocked(owner.runHermesPython).mockResolvedValue(native);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({ features: {} }), { status: url.includes('/p/default/') ? status : 200 })));
    await owner.refreshHermesHealth();
    expect(owner.getBridgeCapabilities().includes('hermes.profiles.v1')).toBe(expected);
    expect(owner.snapshot.hermesApiReachable).toBe(true);
  });
  it('discovers profiles without changing legacy agents or legacy main', async () => {
    const { owner } = await fixture();
    expect(await owner.dispatchRequest('hermes.profiles.list', {})).toEqual({ profiles: ['coder', 'work'].map(name => ({ name,
      agentId: `hermes-profile.${name}`, mainSessionKey: `agent:hermes-profile.${name}:main` })) });
    expect(await owner.dispatchRequest('agents.list', {})).toMatchObject({ defaultId: 'main', agents: [{ id: 'main' }] });
    const created = await owner.dispatchRequest('sessions.create', { title: 'Legacy' }) as { session: { key: string; title: string } };
    expect(created.session.title).toBe('Legacy'); expect(created.session.key).not.toContain('hermes-profile.');
  });
  it('isolates equal session keys, mutations and stores between profiles and legacy owner', async () => {
    const { owner, root } = await fixture();
    const request = (profile: string, method: string, params: unknown) => owner.dispatchRequest('hermes.profile.request', { profile, method, params });
    expect(await request('coder', 'sessions.patch', { key: 'agent:hermes-profile.coder:same', title: 'Changed' })).toMatchObject({ key: 'agent:hermes-profile.coder:same' });
    expect(owner.sessionStore.owns('same')).toBe(false);
    await expect(request('coder', 'sessions.patch', { key: 'agent:hermes-profile.work:same', title: 'Wrong' })).rejects.toThrow('Conflicting');
    await owner.stop();
    const state = async (profile: string) => JSON.parse(await readFile(join(root, 'clawket', 'hermes-profiles', profile, 'sessions.json'), 'utf8'));
    expect((await state('coder')).sessions.find((row: { key: string }) => row.key === 'same').title).toBe('Changed');
    expect((await state('work')).sessions.find((row: { key: string }) => row.key === 'same').title).toBe('work');
  });
  it('routes chat, stop and management through independent contexts without starting listeners or native owners', async () => {
    const { owner, root } = await fixture();
    const calls: Array<{ home: string; api: string; key: string | null; method: string; listener: unknown; child: unknown }> = [];
    const realDispatch = HermesLocalBridge.prototype.dispatchRequest;
    vi.spyOn(HermesLocalBridge.prototype, 'dispatchRequest').mockImplementation(async function(this: HermesLocalBridge, method, params) {
      if (!this.options.profileChild) return realDispatch.call(this, method, params);
      calls.push({ home: this.hermesHomePath, api: this.apiBaseUrl, key: this.apiKey, method, listener: this.httpServer, child: this.hermesChild });
      if (method === 'chat.send') this.broadcastEvent('chat', { sessionKey: 'main', state: 'delta', message: { content: 'untouched' } });
      return { sessionKey: 'main' };
    });
    const events: unknown[] = [];
    vi.spyOn(owner, 'broadcastProfileEvent').mockImplementation((event, payload) => events.push({ event, payload }));
    for (const profile of ['coder', 'work']) for (const method of ['chat.send', 'chat.abort', 'model.set', 'skills.status', 'hermes.cron.jobs.create', 'clawket.artifacts.open'])
      expect(await owner.dispatchRequest(method, { sessionKey: hermesProfileSessionKey(profile, 'main') })).toEqual({ sessionKey: hermesProfileSessionKey(profile, 'main') });
    expect(calls).toHaveLength(12);
    expect(calls[0]).toEqual({ home: join(root, 'home/profiles/coder'), api: 'http://127.0.0.1:8642/p/coder', key: 'profile-api-key-12345', method: 'chat.send', listener: null, child: null });
    expect(calls[6].home).toBe(join(root, 'home/profiles/work'));
    expect(events).toEqual(['coder', 'work'].map(profile => ({ event: 'chat', payload: { sessionKey: hermesProfileSessionKey(profile, 'main'), state: 'delta', message: { content: 'untouched' } } })));
  });
  it.each(['../work', 'default', 'missing', 'WORK', 'work/other'])('rejects invalid or undiscovered profile %s', async profile => {
    const { owner } = await fixture();
    await expect(owner.dispatchRequest('hermes.profile.request', { profile, method: 'model.set', params: {} })).rejects.toThrow();
    expect(owner.runHermesPython).not.toHaveBeenCalled();
  });
  it('rejects nested dispatch, lifecycle control and conflicting routing fields', async () => {
    const { owner } = await fixture();
    for (const method of ['hermes.profile.request', 'bridge.stop', 'bridge.update.start'])
      await expect(owner.dispatchRequest('hermes.profile.request', { profile: 'coder', method, params: {} })).rejects.toThrow();
    await expect(owner.dispatchRequest('chat.send', { key: 'agent:hermes-profile.coder:main', sessionKey: 'agent:hermes-profile.work:main' })).rejects.toThrow('Conflicting');
  });
  it('cancels pending profile creation on stop and refuses later work', async () => {
    const { owner } = await fixture(); let release!: (key: string) => void;
    vi.mocked(owner.runHermesPython).mockImplementation(() => new Promise(resolve => { release = resolve; }) as never);
    const pending = owner.dispatchRequest('chat.send', { sessionKey: 'agent:hermes-profile.coder:main' });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const stopped = owner.stop(); release('key'); await stopped; await rejected;
    await expect(owner.dispatchRequest('chat.send', { sessionKey: 'agent:hermes-profile.work:main' })).rejects.toThrow('cancelled');
  });
  it('namespaces equal approval IDs and resolves only the selected profile without changing native run IDs', async () => {
    const { owner } = await fixture(); const events: unknown[] = []; const resolutions: unknown[] = [];
    vi.spyOn(owner, 'broadcastProfileEvent').mockImplementation((event, payload) => events.push({ event, payload }));
    const dispatch = HermesLocalBridge.prototype.dispatchRequest;
    vi.spyOn(HermesLocalBridge.prototype, 'dispatchRequest').mockImplementation(async function(this: HermesLocalBridge, method, params) {
      if (!this.options.profileChild) return dispatch.call(this, method, params);
      if (method === 'exec.approval.list') {
        this.broadcastEvent('exec.approval.requested', { id: 'run:request', runId: 'run', request: { sessionKey: 'main' } });
        return [{ sessionKey: 'main', approval: { kind: 'exec', id: 'run:request' } }];
      }
      resolutions.push({ home: this.hermesHomePath, params }); return { ok: true };
    });
    for (const profile of ['coder', 'work']) {
      expect(await owner.dispatchRequest('exec.approval.list', { sessionKey: hermesProfileSessionKey(profile, 'main') })).toEqual([
        { sessionKey: hermesProfileSessionKey(profile, 'main'), approval: { kind: 'exec', id: `hermes-profile.${profile}:run:request` } },
      ]);
    }
    expect(events).toEqual(['coder', 'work'].map(profile => ({ event: 'exec.approval.requested', payload: {
      id: `hermes-profile.${profile}:run:request`, runId: 'run', request: { sessionKey: hermesProfileSessionKey(profile, 'main') },
    } })));
    await expect(owner.dispatchRequest('hermes.profile.request', { profile: 'coder', method: 'exec.approval.resolve', params: { id: 'hermes-profile.work:run:request' } })).rejects.toThrow('Conflicting');
    await owner.dispatchRequest('hermes.profile.request', { profile: 'coder', method: 'exec.approval.resolve', params: { id: 'hermes-profile.coder:run:request', decision: 'deny' } });
    expect(resolutions).toEqual([{ home: expect.stringContaining('coder'), params: { id: 'run:request', decision: 'deny' } }]);
  });
  it('keeps named-profile events away from legacy clients and subscribes only after successful discovery', async () => {
    const { owner } = await fixture();
    const socket = () => ({ readyState: 1, send: vi.fn(), close: vi.fn() });
    const legacy = { socket: socket(), isAlive: true }; const modern = { socket: socket(), isAlive: true };
    owner.clients.add(legacy as never); owner.clients.add(modern as never);
    await owner.handleWsMessage(modern as never, Buffer.from(JSON.stringify({ type: 'req', id: 'profiles', method: 'hermes.profiles.list' })));
    modern.socket.send.mockClear();
    owner.broadcastProfileEvent('chat', { sessionKey: 'agent:hermes-profile.coder:main', state: 'delta' });
    expect(legacy.socket.send).not.toHaveBeenCalled(); expect(modern.socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(modern.socket.send.mock.calls[0][0])).toMatchObject({ event: 'chat', payload: { sessionKey: 'agent:hermes-profile.coder:main' } });
  });
  it('keeps metadata visible but never sends a prompt with a missing profile key', async () => {
    const { owner } = await fixture(); vi.mocked(owner.runHermesPython).mockResolvedValue('');
    const send = vi.spyOn(HermesLocalBridge.prototype, 'handleChatSend');
    await expect(owner.dispatchRequest('chat.send', { sessionKey: 'agent:hermes-profile.coder:main', message: 'hello' })).rejects.toThrow('API_SERVER_KEY');
    expect(send).not.toHaveBeenCalled();
    expect(await owner.dispatchRequest('hermes.profiles.list', {})).toMatchObject({ profiles: expect.any(Array) });
  });
  it('rewrites only routing metadata, never native IDs, messages or artifact content', () => {
    const message = { key: 'main', text: 'main', sessionKey: 'main' };
    expect(projectProfilePayload('coder', { key: 'main', sessionId: 'native', message, session: { key: 'other' }, request: { sessionKey: 'main' } }))
      .toEqual({ key: 'agent:hermes-profile.coder:main', sessionId: 'native', message, session: { key: 'agent:hermes-profile.coder:other' }, request: { sessionKey: 'agent:hermes-profile.coder:main' } });
  });
});
