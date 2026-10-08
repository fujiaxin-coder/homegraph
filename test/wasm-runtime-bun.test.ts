import { describe, it, expect } from 'vitest';
import { isBunRuntime } from '../src/extraction/wasm-runtime-flags';

describe('isBunRuntime (WASM relaunch gate)', () => {
  it('is false when Bun is absent', () => {
    expect(isBunRuntime({})).toBe(false);
  });

  it('is true when Bun is present', () => {
    expect(isBunRuntime({ Bun: {} })).toBe(true);
  });
});
