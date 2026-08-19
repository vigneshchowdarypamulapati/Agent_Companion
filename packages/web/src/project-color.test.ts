import { describe, it, expect } from 'vitest';
import { colorForProject, PROJECT_COLOR_PALETTE } from './project-color';

describe('colorForProject', () => {
  it('returns the same color for the same path every time', () => {
    expect(colorForProject('/tmp/my-project')).toBe(colorForProject('/tmp/my-project'));
  });

  it('returns a value from the fixed palette', () => {
    expect(PROJECT_COLOR_PALETTE).toContain(colorForProject('/tmp/my-project'));
  });

  it('spreads across the palette rather than collapsing every path to one color', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `/tmp/project-${i}`);
    const colorsUsed = new Set(paths.map(colorForProject));
    expect(colorsUsed.size).toBeGreaterThan(1);
  });
});
