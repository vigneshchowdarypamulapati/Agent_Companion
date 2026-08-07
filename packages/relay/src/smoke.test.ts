import { describe, it, expect } from 'vitest';
import { RELAY_PLACEHOLDER } from './index.js';

describe('relay package scaffold', () => {
  it('loads', () => {
    expect(RELAY_PLACEHOLDER).toBe(true);
  });
});
