import { describe, it, expect } from 'vitest';
import { pointsAtSameDatabase } from './test-db-guard.js';

describe('pointsAtSameDatabase', () => {
  it('is true for byte-identical strings', () => {
    const url = 'postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/companion?sslmode=require';
    expect(pointsAtSameDatabase(url, url)).toBe(true);
  });

  it('is false for two entirely unrelated connection strings', () => {
    expect(
      pointsAtSameDatabase(
        'postgresql://user:pass@ep-aaa.us-east-2.aws.neon.tech/companion',
        'postgresql://user:pass@ep-bbb.us-east-2.aws.neon.tech/companion_test'
      )
    ).toBe(false);
  });

  // I4: the case that motivated this fix — Neon's pooled and direct hostnames for the same
  // database differ only by a "-pooler" suffix on the first label, so DATABASE_URL on one and
  // COMPANION_TEST_DATABASE_URL on the other must still be recognized as the same database.
  it('is true for a pooled vs. direct Neon hostname pointing at the same database', () => {
    expect(
      pointsAtSameDatabase(
        'postgresql://user:pass@ep-round-hill-12345-pooler.us-east-2.aws.neon.tech/companion?sslmode=require',
        'postgresql://user:pass@ep-round-hill-12345.us-east-2.aws.neon.tech/companion?sslmode=require'
      )
    ).toBe(true);
  });

  it('is false for a pooled vs. direct hostname pointing at DIFFERENT databases', () => {
    expect(
      pointsAtSameDatabase(
        'postgresql://user:pass@ep-round-hill-12345-pooler.us-east-2.aws.neon.tech/companion',
        'postgresql://user:pass@ep-round-hill-12345.us-east-2.aws.neon.tech/companion_test'
      )
    ).toBe(false);
  });

  // I4: differing query parameters for the same host/database must not read as "different".
  it('is true when only query parameters differ', () => {
    expect(
      pointsAtSameDatabase(
        'postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/companion?sslmode=require',
        'postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/companion?sslmode=require&channel_binding=require'
      )
    ).toBe(true);
  });

  it('is true when only credentials (user/password) differ', () => {
    expect(
      pointsAtSameDatabase(
        'postgresql://alice:secret1@ep-xxx.us-east-2.aws.neon.tech/companion',
        'postgresql://bob:secret2@ep-xxx.us-east-2.aws.neon.tech/companion'
      )
    ).toBe(true);
  });

  it('is true when only a trailing slash differs', () => {
    expect(
      pointsAtSameDatabase(
        'postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/companion',
        'postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/companion/'
      )
    ).toBe(true);
  });

  it('is case-insensitive on the hostname', () => {
    expect(
      pointsAtSameDatabase(
        'postgresql://user:pass@EP-XXX.US-EAST-2.AWS.NEON.TECH/companion',
        'postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/companion'
      )
    ).toBe(true);
  });

  it('is false when the host matches but the database name differs', () => {
    expect(
      pointsAtSameDatabase(
        'postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/companion',
        'postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/companion_test'
      )
    ).toBe(false);
  });

  it('is false when the database matches but the host differs', () => {
    expect(
      pointsAtSameDatabase(
        'postgresql://user:pass@ep-aaa.us-east-2.aws.neon.tech/companion',
        'postgresql://user:pass@ep-bbb.us-east-2.aws.neon.tech/companion'
      )
    ).toBe(false);
  });

  it('does not strip a "-pooler"-like substring that is not the pooler suffix itself', () => {
    // "-poolerish" is not "-pooler" (extra trailing characters) — must not be treated as the
    // pooled-endpoint marker.
    expect(
      pointsAtSameDatabase(
        'postgresql://user:pass@ep-xxx-poolerish.us-east-2.aws.neon.tech/companion',
        'postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/companion'
      )
    ).toBe(false);
  });

  it('falls back to false for an unparsable, non-identical connection string', () => {
    expect(pointsAtSameDatabase('not a url at all', 'postgresql://user:pass@host/db')).toBe(false);
  });

  it('falls back to byte equality for an unparsable but identical connection string', () => {
    expect(pointsAtSameDatabase('not a url at all', 'not a url at all')).toBe(true);
  });
});
