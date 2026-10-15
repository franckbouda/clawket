import { describe, expect, it } from 'vitest';
import { hermesProfileAgentId, hermesAgentProfile, hermesProfileSessionKey, parseHermesProfileSessionKey } from './hermes-profiles';
describe('Hermes profile identities', () => {
  it('roundtrips opaque native keys including colons and Unicode', () => {
    for (const key of ['main', 'native:1:2', 'session été']) {
      expect(parseHermesProfileSessionKey(hermesProfileSessionKey('coder', key))).toEqual({ profile: 'coder', key });
      expect(hermesAgentProfile(hermesProfileAgentId('coder'))).toBe('coder');
    }
  });
  it('keeps legacy and OpenClaw keys outside profile routing', () => {
    for (const key of ['main', 'hermes', 'agent:main:main', 'agent:coder:main']) expect(parseHermesProfileSessionKey(key)).toBeNull();
    expect(hermesAgentProfile('hermes')).toBeNull();
  });
  it('validates the empty and oversized key boundaries while accepting the largest valid key', () => {
    expect(() => hermesProfileSessionKey('coder', '')).toThrow();
    expect(() => hermesProfileSessionKey('coder', 'x'.repeat(2049))).toThrow();
    const key = 'x'.repeat(2048);
    expect(parseHermesProfileSessionKey(hermesProfileSessionKey('coder', key))).toEqual({ profile: 'coder', key });
  });
  it.each(['../coder', 'default', '', 'Coder', 'a'.repeat(65), 'coder:main'])('rejects profile %j', profile => expect(() => hermesProfileAgentId(profile)).toThrow());
  it.each(['agent:hermes-profile.coder:', 'agent:hermes-profile.../work:main', 'agent:hermes-profile.default:main', 'agent:hermes-profile.coder', `agent:hermes-profile.coder:${'x'.repeat(2201)}`])('rejects malformed reserved key %j', key => expect(() => parseHermesProfileSessionKey(key)).toThrow());
});
