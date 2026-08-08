import { describe, it, expect, beforeEach } from 'vitest';
import { getStoredCredentials, storeCredentials, clearStoredCredentials } from './storage';

describe('storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns undefined when nothing is stored', () => {
    expect(getStoredCredentials()).toBeUndefined();
  });

  it('round-trips stored credentials', () => {
    storeCredentials({ token: 'tok-1', deviceId: 'dev-1' });
    expect(getStoredCredentials()).toEqual({ token: 'tok-1', deviceId: 'dev-1' });
  });

  it('clears stored credentials', () => {
    storeCredentials({ token: 'tok-1', deviceId: 'dev-1' });
    clearStoredCredentials();
    expect(getStoredCredentials()).toBeUndefined();
  });

  it('returns undefined for malformed stored JSON instead of throwing', () => {
    localStorage.setItem('companion.device', '{not json');
    expect(getStoredCredentials()).toBeUndefined();
  });

  it('returns undefined when the stored object is missing a field', () => {
    localStorage.setItem('companion.device', JSON.stringify({ token: 'tok-1' }));
    expect(getStoredCredentials()).toBeUndefined();
  });
});
