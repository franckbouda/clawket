import { dirname, join } from 'node:path';
import { realpath, readdir, stat } from 'node:fs/promises';
import { hermesProfileAgentId, hermesProfileSessionKey,
  parseHermesProfileSessionKey, type HermesProfileDescriptor } from '@clawket/agent-protocol';
import { HermesLocalBridge } from './index.js';
import { isRecord } from './internal.js';

const PROFILE_METHODS = /^(?:sessions\.(?:list|create|patch|reset|delete|usage)|chat\.(?:history|send|abort|steer)|agents\.files\.(?:list|get|set)|agent\.identity\.get|skills\.(?:status|get|install|update|delete|content\.update)|models\.list|model\.(?:get|current|set|health)|usage\.cost|hermes\.(?:reasoning|fast)\.(?:get|set)|hermes\.cron\.(?:jobs\.(?:list|get|create|update|pause|resume|run|remove)|outputs\.(?:list|get))|exec\.approval\.(?:list|resolve)|clawket\.(?:artifacts\.(?:open|read)|files\.(?:list|read)))$/;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Optional capability: old/native single-profile installs keep their complete legacy path. */
export async function supportsHermesProfiles(run: <T>(script: string) => Promise<T>): Promise<boolean> {
  try {
    return await run<unknown>([
      'import json', 'from gateway.platforms.api_server import APIServerAdapter',
      'from gateway.config import load_gateway_config',
      'print(json.dumps(hasattr(APIServerAdapter, "_resolve_request_profile") and bool(getattr(load_gateway_config(), "multiplex_profiles", False))))',
    ].join('\n')) === true;
  } catch { return false; }
}
function approvalId(profile: string, id: string): string { return `hermes-profile.${profile}:${id}`; }
function projectProfileEvent(profile: string, event: string, payload: unknown): unknown {
  const projected = projectProfilePayload(profile, payload);
  return (event === 'exec.approval.requested' || event === 'exec.approval.resolved') && isRecord(projected) && typeof projected.id === 'string'
    ? { ...projected, id: approvalId(profile, projected.id) } : projected;
}
// Only routing fields are rewritten; never traverse message bodies, tool output or native IDs.
export function projectProfilePayload(profile: string, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result = { ...value };
  for (const key of ['key', 'sessionKey', 'parentSessionKey', 'spawnedBy']) {
    if (typeof result[key] === 'string' && result[key]) result[key] = hermesProfileSessionKey(profile, result[key] as string);
  }
  if (Array.isArray(result.sessions)) result.sessions = result.sessions.map(row => projectProfilePayload(profile, row));
  if (isRecord(result.session)) result.session = projectProfilePayload(profile, result.session);
  if (isRecord(result.request)) result.request = projectProfilePayload(profile, result.request);
  if (isRecord(result.approval) && result.approval.kind === 'exec' && typeof result.approval.id === 'string') result.approval = { ...result.approval, id: approvalId(profile, result.approval.id) };
  if (Array.isArray(result.approvals)) result.approvals = result.approvals.map(row => projectProfilePayload(profile, row));
  return result;
}

export class HermesProfiles {
  private readonly contexts = new Map<string, Promise<HermesLocalBridge>>();
  private generation = 0;
  private stopped = false;
  resume(): void { this.stopped = false; }
  private readonly live = new Set<HermesLocalBridge>();
  private readonly missingApiKeys = new WeakSet<HermesLocalBridge>();
  constructor(private readonly owner: HermesLocalBridge) {}

  async list(): Promise<HermesProfileDescriptor[]> {
    const root = join(this.owner.hermesHomePath, 'profiles');
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Hermes profile discovery failed.'); }
    if (entries.length > 128) throw new Error('Too many Hermes profiles (maximum 128).');
    const result: HermesProfileDescriptor[] = [];
    const canonicalRoot = await realpath(root);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !NAME.test(entry.name) || entry.name === 'default') continue;
      const home = await realpath(join(root, entry.name));
      if (dirname(home) !== canonicalRoot) throw new Error('Invalid Hermes profile directory.');
      try { if (!(await stat(join(home, 'config.yaml'))).isFile()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Error('Hermes profile discovery failed.'); }
      result.push({ name: entry.name, agentId: hermesProfileAgentId(entry.name), mainSessionKey: hermesProfileSessionKey(entry.name, 'main') });
    }
    const present = new Set(result.map(profile => profile.name));
    for (const [name, pending] of this.contexts) {
      if (present.has(name)) continue;
      this.contexts.delete(name);
      void pending.then(async context => { this.live.delete(context); await context.stop(); }).catch(() => undefined);
    }
    return result;
  }

  async request(profile: string, method: string, params: unknown): Promise<unknown> {
    const generation = this.generation;
    if (this.stopped) throw new Error('Hermes operation cancelled.');
    if (!NAME.test(profile) || !PROFILE_METHODS.test(method) || !(await this.list()).some(row => row.name === profile)) throw new Error('Unknown Hermes profile or unsupported operation.');
    const route = this.route(method, params);
    if (route && route.profile !== profile) throw new Error('Conflicting Hermes profiles.');
    if (generation !== this.generation || this.stopped) throw new Error('Hermes operation cancelled.');
    const pending = this.context(profile);
    const context = await pending;
    if (this.contexts.get(profile) !== pending) throw new Error('Hermes profile changed. Retry.');
    if (generation !== this.generation || this.stopped) throw new Error('Hermes operation cancelled.');
    if (this.missingApiKeys.has(context) && /^(chat\.(send|steer)|exec\.approval\.resolve)$/.test(method)) throw new Error('Configure API_SERVER_KEY in this Hermes profile before chatting.');
    let payload = route?.params ?? params;
    if (method === 'exec.approval.resolve' && isRecord(payload) && typeof payload.id === 'string' && payload.id.startsWith('hermes-profile.')) {
      const prefix = `hermes-profile.${profile}:`;
      if (!payload.id.startsWith(prefix) || payload.id.length === prefix.length) throw new Error('Conflicting Hermes approval profile.');
      payload = { ...payload, id: payload.id.slice(prefix.length) };
    }
    const result = await context.dispatchRequest(method, payload);
    if (Array.isArray(result) && method === 'exec.approval.list') return result.map(row => projectProfilePayload(profile, row));
    return projectProfilePayload(profile, result);
  }

  route(method: string, params: unknown): { profile: string; params: Record<string, unknown> } | null {
    if (!isRecord(params)) return null;
    let selected: string | undefined;
    const payload = { ...params };
    for (const field of ['sessionKey', 'key']) {
      if (typeof payload[field] !== 'string') continue;
      const route = parseHermesProfileSessionKey(payload[field] as string);
      if (!route) continue;
      if (selected && selected !== route.profile) throw new Error('Conflicting Hermes profiles.');
      selected = route.profile; payload[field] = route.key;
    }
    return selected ? { profile: selected, params: payload } : null;
  }

  private context(profile: string): Promise<HermesLocalBridge> {
    const cached = this.contexts.get(profile);
    if (cached) return cached;
    const generation = this.generation;
    const pending = this.createContext(profile, generation).catch(error => { if (this.contexts.get(profile) === pending) this.contexts.delete(profile); throw error; });
    this.contexts.set(profile, pending);
    return pending;
  }

  private async createContext(profile: string, generation: number): Promise<HermesLocalBridge> {
    const home = join(this.owner.hermesHomePath, 'profiles', profile);
    // Read the profile's literal dotenv key; never inherit the owner's secret or expose it in metadata.
    const key = await this.owner.runHermesPython<string>([
      'import json, sys', 'from pathlib import Path', 'from dotenv import dotenv_values',
      'home = Path(json.loads(sys.stdin.read())["home"])',
      'value = dotenv_values(home / ".env", interpolate=False).get("API_SERVER_KEY") or ""',
      'print(json.dumps(value))',
    ].join('\n'), { home });
    if (generation !== this.generation) throw new Error('Hermes operation cancelled.');
    const state = join(dirname(this.owner.options.sessionStorePath ?? join(this.owner.hermesHomePath, '..', '.clawket', 'sessions.json')), 'hermes-profiles', profile);
    const context = new HermesLocalBridge({ ...this.owner.options, profileChild: true,
      apiBaseUrl: `${this.owner.apiBaseUrl}/p/${encodeURIComponent(profile)}`, apiKey: key || 'unconfigured-profile-key',
      hermesHomePath: home, hermesStateDbPath: join(home, 'state.db'),
      sessionStorePath: join(state, 'sessions.json'), usageLedgerPath: join(state, 'usage.json'),
      startHermesIfNeeded: false, remoteUpdate: undefined, onLog: undefined, onStatus: undefined,
      onProfileEvent: (event, payload) => { if (!this.stopped && generation === this.generation) this.owner.broadcastProfileEvent(event, projectProfileEvent(profile, event, payload)); },
    });
    // No child listener, native gateway, timers or independent transport owner is started.
    context.hermesRunCapabilities = this.owner.hermesRunCapabilities;
    context.snapshot.hermesApiReachable = this.owner.snapshot.hermesApiReachable;
    if (typeof key !== 'string' || key.length < 16) this.missingApiKeys.add(context);
    this.live.add(context);
    return context;
  }

  busy(): boolean { return [...this.live].some(context => context.hasActiveWork()); }
  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    const pending = [...this.contexts.values()]; this.contexts.clear(); this.live.clear();
    await Promise.allSettled(pending.map(async context => (await context).stop()));
  }
}

