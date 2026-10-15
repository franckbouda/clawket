/** Additive Hermes profile routing. Legacy keys and the default Agent stay unchanged. */
export const HERMES_PROFILES_CAPABILITY = 'hermes.profiles.v1';
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function hermesProfileAgentId(profile: string): string {
  if (!PROFILE_NAME.test(profile) || profile === 'default') throw new Error('Invalid Hermes profile.');
  return `hermes-profile.${profile}`;
}
export function hermesAgentProfile(agentId: string): string | null {
  const name = agentId.slice('hermes-profile.'.length);
  return agentId.startsWith('hermes-profile.') && PROFILE_NAME.test(name) && name !== 'default' ? name : null;
}
export function hermesProfileSessionKey(profile: string, key: string): string {
  if (!key || key.length > 2048) throw new Error('Invalid Hermes session key.');
  return `agent:${hermesProfileAgentId(profile)}:${key}`;
}
export function parseHermesProfileSessionKey(key: string): { profile: string; key: string } | null {
  if (!key.startsWith('agent:hermes-profile.')) return null;
  const end = key.indexOf(':', 6);
  const profile = end >= 0 ? hermesAgentProfile(key.slice(6, end)) : null;
  if (!profile || end === key.length - 1 || key.length > 2200) throw new Error('Invalid Hermes profile session.');
  return { profile, key: key.slice(end + 1) };
}
export type HermesProfileDescriptor = { name: string; agentId: string; mainSessionKey: string };
