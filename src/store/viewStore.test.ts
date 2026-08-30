import { describe, expect, it } from 'vitest';
import { shouldRenderWelcomeModal } from './viewStore';

describe('shouldRenderWelcomeModal', () => {
  it('does not render the legacy welcome overlay over the simple workspace', () => {
    expect(shouldRenderWelcomeModal('simple', true)).toBe(false);
  });

  it('keeps the legacy welcome overlay available in the advanced workspace', () => {
    expect(shouldRenderWelcomeModal('advanced', true)).toBe(true);
  });

  it('does not render when the welcome state is closed', () => {
    expect(shouldRenderWelcomeModal('advanced', false)).toBe(false);
  });
});
