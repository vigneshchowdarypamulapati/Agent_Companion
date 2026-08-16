import { describe, it, expect } from 'vitest';
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
   * Deterministic, not statistical: every test below feeds a fixed,
   * hand-picked byte sequence and asserts the exact index and byte-count
   * consumed, rather than sampling the real RNG and checking a
   * distribution. A statistical (e.g. chi-squared) test over real random
   * output is inherently probabilistic — it has a nonzero false-failure
   * rate by construction, no matter how small — and one such test did
   * fail in a real CI run despite the implementation being correct.
   * `randomAlphabetIndex`'s optional `randomByte` parameter exists
   * specifically so these tests can supply an exact queue of bytes instead.
   */
  function queueOf(bytes: number[]): () => number {
    let i = 0;
    return () => {
      if (i >= bytes.length) {
        throw new Error(`byte queue exhausted after ${i} draws — randomAlphabetIndex drew more than expected`);
      }
      return bytes[i++];
    };
  }

  it('maps every acceptable byte to byte % alphabetSize, for a size that divides 256 evenly (32 — the real alphabet)', () => {
    // maxAcceptable = floor(256/32)*32 = 256, so every byte 0-255 is
    // acceptable and this exhaustively covers every input the function can
    // ever see for the real pairing-code alphabet: none of the 256
    // possible bytes is ever rejected, and each is consumed in exactly one
    // draw.
    const hitsPerIndex = new Array(32).fill(0);
    for (let byte = 0; byte < 256; byte++) {
      const index = randomAlphabetIndex(32, queueOf([byte]));
      expect(index).toBe(byte % 32);
      hitsPerIndex[index]++;
    }
    // 256/32 = 8 exactly: exhaustive enumeration proves each of the 32
    // indices is reachable by exactly 8 of the 256 possible bytes — a
    // combinatorial proof of uniformity, not a sampled approximation of one.
    expect(hitsPerIndex).toEqual(new Array(32).fill(8));
  });

  it('maps every acceptable byte to byte % alphabetSize, for a size that does NOT divide 256 evenly (6)', () => {
    // maxAcceptable = floor(256/6)*6 = 252, so bytes 0-251 are acceptable
    // and 252-255 must be rejected (covered by the next two tests). This
    // exhaustively covers the acceptable range.
    const hitsPerIndex = new Array(6).fill(0);
    for (let byte = 0; byte < 252; byte++) {
      const index = randomAlphabetIndex(6, queueOf([byte]));
      expect(index).toBe(byte % 6);
      hitsPerIndex[index]++;
    }
    // 252/6 = 42 exactly: every index gets exactly 42 of the 252 acceptable
    // bytes — proof the rejection boundary (252) was placed correctly, not
    // just that individual mappings are right.
    expect(hitsPerIndex).toEqual(new Array(6).fill(42));
  });

  it('rejects and resamples every byte at/above maxAcceptable, for a non-dividing size (6, boundary 252)', () => {
    for (const rejectedByte of [252, 253, 254, 255]) {
      // The rejected byte is drawn first and must be discarded (not
      // silently accepted and reduced mod 6, which would bias indices
      // 0-3); the queue then yields 17, an acceptable byte, on the retry.
      const index = randomAlphabetIndex(6, queueOf([rejectedByte, 17]));
      expect(index).toBe(17 % 6);
    }
  });

  it('handles multiple consecutive rejections before an accept, and terminates', () => {
    // Four rejected bytes in a row, then one acceptable one — proves the
    // `while (true)` loop doesn't mishandle repeated rejection and does
    // eventually terminate rather than looping past the first accept.
    const index = randomAlphabetIndex(6, queueOf([252, 253, 254, 255, 9]));
    expect(index).toBe(9 % 6);
  });

  it('demonstrates naive `byte % alphabetSize` IS biased for a non-dividing size — deterministically, by exhaustive enumeration', () => {
    // Not testing our own code — a reference count of what plain modulo
    // over every possible byte value would produce, kept only to make the
    // magnitude of the bug this avoids concrete. No randomness involved.
    const alphabetSize = 6;
    const counts = new Array(alphabetSize).fill(0);
    for (let byte = 0; byte < 256; byte++) counts[byte % alphabetSize]++;

    // 256 = 42*6 + 4: naive modulo gives indices 0-3 one extra hit each
    // relative to 4-5 — a real, deterministic, ~2.4% bias that rejection
    // sampling (proven uniform above) avoids entirely.
    expect(counts).toEqual([43, 43, 43, 43, 42, 42]);
    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  it('rejects alphabet sizes outside [1, 256]', () => {
    expect(() => randomAlphabetIndex(0)).toThrow(RangeError);
    expect(() => randomAlphabetIndex(257)).toThrow(RangeError);
    expect(() => randomAlphabetIndex(1.5)).toThrow(RangeError);
  });

  it('with the default real byte source, never returns an out-of-range index (hard invariant, not a distribution check)', () => {
    for (let i = 0; i < 10_000; i++) {
      const index = randomAlphabetIndex(6);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(6);
    }
  });
});

describe('MAX_PAIRING_CODE_ATTEMPTS', () => {
  it('is 5, per the pairing-code lockout requirement', () => {
    expect(MAX_PAIRING_CODE_ATTEMPTS).toBe(5);
  });
});
