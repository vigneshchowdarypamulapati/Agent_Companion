import { describe, it, expect } from 'vitest';
import { FakeIdentityVerifier } from './identity-verifier.js';

describe('FakeIdentityVerifier', () => {
  it('returns the identity for a known token', async () => {
    const verifier = new FakeIdentityVerifier(
      new Map([['tok-1', { clerkUserId: 'clerk-user-1', email: 'a@example.com' }]])
    );
    expect(await verifier.verifyToken('tok-1')).toEqual({ clerkUserId: 'clerk-user-1', email: 'a@example.com' });
  });

  it('returns undefined for an unknown token', async () => {
    const verifier = new FakeIdentityVerifier(new Map());
    expect(await verifier.verifyToken('nope')).toBeUndefined();
  });
});
