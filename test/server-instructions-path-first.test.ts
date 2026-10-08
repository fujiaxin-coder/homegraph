import { describe, it, expect } from 'vitest';
import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_NO_ROOT_INDEX } from '../src/mcp/server-instructions.js';

describe('SERVER_INSTRUCTIONS aligned with DevEco graph-first', () => {
  it('does not push bash-first / optional', () => {
    for (const text of [SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_NO_ROOT_INDEX]) {
      expect(text).toMatch(/graph-first for existing code/i);
      expect(text).toMatch(/open with `homegraph_explore` alone/i);
      expect(text).not.toMatch(/bash-first/i);
      expect(text).not.toContain('HomeGraph is optional');
      expect(text).not.toContain('ordinary bash/search/read tools first');
      expect(text).toContain('ceilings, never a required sequence');
    }
  });
});
