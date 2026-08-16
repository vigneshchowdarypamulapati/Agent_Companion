import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  formatPairingCodeForDisplay,
  generatePairingCode,
  MAX_PAIRING_CODE_ATTEMPTS,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  randomAlphabetIndex,
} from './store.js';

describe('PAIRING_CODE_ALPHABET', () => {
  it('is 32 symbols with no ambiguous or profanity-prone characters', () => {
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(32); // no duplicates
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(PAIRING_CODE_ALPHABET).not.toContain(excluded);
    }
  });

  it('at 8 characters, provides at least 40 bits of entropy', () => {
    // 32 symbols = 5 bits/char exactly (2^5 = 32).
    const bitsPerChar = Math.log2(PAIRING_CODE_ALPHABET.length);
    expect(bitsPerChar).toBe(5);
    expect(bitsPerChar * PAIRING_CODE_LENGTH).toBeGreaterThanOrEqual(40);
  });
});

describe('generatePairingCode', () => {
  it('generates an 8-character code drawn entirely from the pairing-code alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      for (const char of code) {
        expect(PAIRING_CODE_ALPHABET).toContain(char);
      }
    }
  });

  it('does not repeat across a reasonably large sample (sanity check on the RNG, not a proof)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5000; i++) codes.add(generatePairingCode());
    expect(codes.size).toBe(5000);
  });
});

describe('normalizePairingCode', () => {
  it('uppercases the input', () => {
    expect(normalizePairingCode('abcd1234')).toBe('ABCD1234');
  });

  it('strips hyphens', () => {
    expect(normalizePairingCode('ABCD-1234')).toBe('ABCD1234');
  });

  it('strips whitespace, including leading/trailing and internal', () => {
    expect(normalizePairingCode(' ABCD 1234 ')).toBe('ABCD1234');
  });

  it('normalizes every typed variant of the same code to the same canonical value', () => {
    const variants = ['ABCD1234', 'abcd1234', 'ABCD-1234', 'abcd-1234', ' ABCD-1234 ', 'ABCD 1234'];
    const normalized = new Set(variants.map(normalizePairingCode));
    expect(normalized).toEqual(new Set(['ABCD1234']));
  });
});

describe('formatPairingCodeForDisplay', () => {
  it('groups an 8-character code as XXXX-XXXX', () => {
    expect(formatPairingCodeForDisplay('ABCD1234')).toBe('ABCD-1234');
  });

  it('round-trips through normalizePairingCode', () => {
    const code = generatePairingCode();
    expect(normalizePairingCode(formatPairingCodeForDisplay(code))).toBe(code);
  });
});

describe('randomAlphabetIndex — proof the rejection sampling is unbiased', () => {
  /**
   * Pearson's chi-squared goodness-of-fit statistic against a uniform
   * distribution over `bucketCount` buckets. Comparing against the
   * chi-squared critical value at 0.001 significance keeps this from
   * flaking under ordinary sampling noise, while still failing hard for a
   * biased generator (see the modulo-bias case below, which fails this
   * check reliably).
   */
  function chiSquared(counts: number[], expectedPerBucket: number): number {
    return counts.reduce((sum, observed) => sum + (observed - expectedPerBucket) ** 2 / expectedPerBucket, 0);
  }

  // Chi-squared critical values at p=0.001, indexed by degrees of freedom
  // (bucketCount - 1). Source: standard chi-squared distribution tables.
  const CRITICAL_VALUE_P001: Record<number, number> = {
    5: 20.515, // 6 buckets
    9: 27.877, // 10 buckets
    31: 61.098, // 32 buckets (PAIRING_CODE_ALPHABET's own size)
  };

  it('is uniform over the actual 32-symbol pairing-code alphabet size (256 divides evenly — the easy case)', () => {
    const bucketCount = 32;
    const samples = 320_000;
    const counts = new Array(bucketCount).fill(0);
    for (let i = 0; i < samples; i++) counts[randomAlphabetIndex(bucketCount)]++;

    expect(chiSquared(counts, samples / bucketCount)).toBeLessThan(CRITICAL_VALUE_P001[bucketCount - 1]);
  });

  it('is uniform over an alphabet size that does NOT divide 256 evenly — the case that actually exercises rejection', () => {
    // 256 / 6 = 42.67: a naive `byte % 6` would over-represent indices 0-3
    // (which get an extra hit in every 256-byte cycle) relative to 4-5.
    // Rejection sampling must still come out uniform here.
    const bucketCount = 6;
    const samples = 120_000;
    const counts = new Array(bucketCount).fill(0);
    for (let i = 0; i < samples; i++) counts[randomAlphabetIndex(bucketCount)]++;

    expect(chiSquared(counts, samples / bucketCount)).toBeLessThan(CRITICAL_VALUE_P001[bucketCount - 1]);
  });

  it('is uniform over a second non-dividing alphabet size (10)', () => {
    const bucketCount = 10;
    const samples = 200_000;
    const counts = new Array(bucketCount).fill(0);
    for (let i = 0; i < samples; i++) counts[randomAlphabetIndex(bucketCount)]++;

    expect(chiSquared(counts, samples / bucketCount)).toBeLessThan(CRITICAL_VALUE_P001[bucketCount - 1]);
  });

  it('demonstrates naive `byte % alphabetSize` IS measurably biased for a non-dividing size — the failure mode rejection sampling avoids', () => {
    // Not testing our own code here — a local reference implementation of
    // the naive approach the brief calls out, kept only to show the chi-
    // squared check above would actually catch this class of bug.
    function naiveModulo(alphabetSize: number): number {
      return randomBytes(1)[0] % alphabetSize;
    }

    const bucketCount = 6;
    const samples = 120_000;
    const counts = new Array(bucketCount).fill(0);
    for (let i = 0; i < samples; i++) counts[naiveModulo(bucketCount)]++;

    expect(chiSquared(counts, samples / bucketCount)).toBeGreaterThan(CRITICAL_VALUE_P001[bucketCount - 1]);
  });

  it('never returns an out-of-range index', () => {
    for (let i = 0; i < 10_000; i++) {
      const index = randomAlphabetIndex(6);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(6);
    }
  });

  it('rejects alphabet sizes outside [1, 256]', () => {
    expect(() => randomAlphabetIndex(0)).toThrow(RangeError);
    expect(() => randomAlphabetIndex(257)).toThrow(RangeError);
    expect(() => randomAlphabetIndex(1.5)).toThrow(RangeError);
  });
});

describe('MAX_PAIRING_CODE_ATTEMPTS', () => {
  it('is 5, per the pairing-code lockout requirement', () => {
    expect(MAX_PAIRING_CODE_ATTEMPTS).toBe(5);
  });
});
