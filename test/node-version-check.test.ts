/**
 * Pin the Node floor banner content. The recipe and override env var below are
 * load-bearing — if any of them get edited away, this test catches it.
 */

import { describe, it, expect } from 'vitest';
import { buildNodeTooOldBanner, MIN_NODE_MAJOR } from '../src/bin/node-version-check';

describe('buildNodeTooOldBanner', () => {
  it('embeds the reported Node version in the header', () => {
    expect(buildNodeTooOldBanner('20.19.0')).toContain(
      'Unsupported Node.js version: 20.19.0'
    );
  });

  it('states the supported floor matching MIN_NODE_MAJOR', () => {
    expect(MIN_NODE_MAJOR).toBe(22);
    expect(buildNodeTooOldBanner('20.0.0')).toContain(
      `requires Node.js ${MIN_NODE_MAJOR} or newer`
    );
  });

  it('points users to Node 22 LTS via nvm and Homebrew', () => {
    const banner = buildNodeTooOldBanner('20.0.0');
    expect(banner).toContain('Node.js 22 LTS');
    expect(banner).toContain('nvm install 22');
    expect(banner).toContain('brew install node@22');
  });

  it('documents the HOMEGRAPH_ALLOW_UNSAFE_NODE override for below-floor majors', () => {
    expect(buildNodeTooOldBanner('21.0.0')).toContain('HOMEGRAPH_ALLOW_UNSAFE_NODE=1');
    expect(buildNodeTooOldBanner('21.0.0')).toContain('for majors below the floor only');
  });
});
