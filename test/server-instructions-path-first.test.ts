import { describe, it, expect } from 'vitest';
import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_NO_ROOT_INDEX } from '../src/mcp/server-instructions.js';

describe('SERVER_INSTRUCTIONS path-first', () => {
  it('tells agents to skip HomeGraph on single-file path-pinned edits', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/path-first/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/Do not call `homegraph_\*`|Skip HomeGraph/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/do not Grep\/Glob\/Read first/i);
  });

  it('keeps indexed and no-root guidance bash-first without a compulsory graph turn', () => {
    for (const text of [SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_NO_ROOT_INDEX]) {
      expect(text).toMatch(/Skip HomeGraph/);
      expect(text).toMatch(/bash-first/);
      expect(text).toContain('concrete unresolved relationship');
      expect(text).toContain('difficult implementation tasks');
      expect(text).toContain('ceilings, never a required sequence');
      expect(text).not.toMatch(/CALL FIRST|GENERAL PRIMARY|exactly ONE first tool|call `homegraph_explore` \*\*once\*\*/i);
    }
  });
});
