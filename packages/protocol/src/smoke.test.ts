import { describe, it, expect } from 'vitest';
import { PROTOCOL_PLACEHOLDER } from './index.js';

describe('protocol package scaffold', () => {
  it('loads', () => {
    expect(PROTOCOL_PLACEHOLDER).toBe(true);
  });
});
