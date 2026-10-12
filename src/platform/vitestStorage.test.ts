import { expect, it } from 'vitest';

it('uses the jsdom Storage instance for the worker-global localStorage', () => {
  expect(globalThis.localStorage).toBe(window.localStorage);
  expect(window.localStorage).toBeInstanceOf(window.Storage);
});
