/**
 * Throwaway pre-flight check for the hack.near direct-write payload at
 * /tmp/hack-join.json. Runs the real frontend validators and agentEntries
 * against the payload to confirm wire correctness before we sign the
 * mainnet transaction. Delete after the write lands.
 */

import { existsSync, readFileSync } from 'node:fs';
import { agentEntries, extractCapabilityPairs } from '@/lib/fastdata-utils';
import {
  validateCapabilities,
  validateDescription,
  validateName,
  validateTags,
} from '@/lib/validate';
import type { Agent } from '@/types';

interface Payload {
  profile: Agent;
  [key: string]: unknown;
}

const FIXTURE = '/tmp/hack-join.json';
const present = existsSync(FIXTURE);
const maybeDescribe = present ? describe : describe.skip;

const payload: Payload = present
  ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Payload)
  : ({ profile: {} as Agent } as Payload);

maybeDescribe('hack.near direct-write payload', () => {
  const profile = payload.profile;

  it('name passes validateName', () => {
    expect(validateName(profile.name!)).toBeNull();
  });

  it('description passes validateDescription', () => {
    expect(validateDescription(profile.description)).toBeNull();
  });

  it('tags pass validateTags with no normalization drift', () => {
    const { validated, error } = validateTags(profile.tags);
    expect(error).toBeNull();
    expect(validated).toEqual(profile.tags);
  });

  it('capabilities pass validateCapabilities', () => {
    expect(validateCapabilities(profile.capabilities)).toBeNull();
  });

  it('extractCapabilityPairs produces exactly the cap/ keys in the payload', () => {
    const pairs = extractCapabilityPairs(profile.capabilities);
    const derivedCapKeys = pairs.map(([ns, val]) => `cap/${ns}/${val}`).sort();
    const payloadCapKeys = Object.keys(payload)
      .filter((k) => k.startsWith('cap/'))
      .sort();
    expect(derivedCapKeys).toEqual(payloadCapKeys);
  });

  it('agentEntries produces a superset that matches the payload keys', () => {
    const expected = agentEntries(profile);
    const expectedKeys = Object.keys(expected).sort();
    const payloadKeys = Object.keys(payload).sort();
    expect(payloadKeys).toEqual(expectedKeys);
  });

  it('stored profile blob strips derived fields', () => {
    const expected = agentEntries(profile);
    const storedProfile = expected.profile as Record<string, unknown>;
    expect(storedProfile.follower_count).toBeUndefined();
    expect(storedProfile.following_count).toBeUndefined();
    expect(storedProfile.endorsements).toBeUndefined();
    expect(storedProfile.endorsement_count).toBeUndefined();
  });

  it('payload.profile has no derived fields in the first place', () => {
    const p = profile as unknown as Record<string, unknown>;
    expect(p.follower_count).toBeUndefined();
    expect(p.following_count).toBeUndefined();
    expect(p.endorsements).toBeUndefined();
    expect(p.endorsement_count).toBeUndefined();
  });

  it('tag/ keys match profile.tags exactly', () => {
    const tagKeys = Object.keys(payload)
      .filter((k) => k.startsWith('tag/'))
      .map((k) => k.slice(4))
      .sort();
    expect(tagKeys).toEqual([...profile.tags].sort());
  });
});
