import { describe, expect, it } from 'vitest';
import type { CapabilityLevel } from './capability';

describe('capability contract owner', () => {
  it('preserves the ordered execution levels', () => {
    const levels: CapabilityLevel[] = ['compute', 'io', 'sandbox_write', 'coordinator', 'system'];
    expect(levels).toHaveLength(5);
    expect(levels[0]).toBe('compute');
    expect(levels.at(-1)).toBe('system');
  });
});
