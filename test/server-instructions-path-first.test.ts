import { describe, it, expect } from 'vitest';
import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_NO_ROOT_INDEX } from '../src/mcp/server-instructions.js';

describe('SERVER_INSTRUCTIONS path-first', () => {
  it('tells agents to skip HomeGraph on single-file path-pinned edits', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/path-first/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/Do not call `homegraph_\*`|Skip HomeGraph/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/do not Grep\/Glob\/Read first/i);
  });

  it('keeps the no-root variant aligned', () => {
    expect(SERVER_INSTRUCTIONS_NO_ROOT_INDEX).toMatch(/Skip HomeGraph/i);
  });
});
