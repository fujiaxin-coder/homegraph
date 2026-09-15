/**
 * homegraph_explore description at fileCount === 0 (Spec 0027).
 *
 * Hosts request tools/list once at connect (#964). An auto-init that is
 * still building reports fileCount=0 at that instant, and the old budget
 * suffix — "make at most 1 calls for this project (0 files indexed)" — was
 * frozen into the agent's context for the whole session. Field evidence
 * (DevEco Code bench, 3 sessions, zero homegraph calls): agents read
 * "(0 files indexed)" as terminal and permanently fell back to Read/Grep
 * even though the index completed seconds later.
 *
 * These tests pin that the 0-file description now mirrors
 * maybeDeepToolPhaseGate's success-shaped guidance (still building → say so
 * and point at homegraph_project; failed build → relay to the user;
 * genuinely empty → honest empty note), never carries the misleading budget
 * note, and that the fileCount > 0 budget path is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler } from '../src/mcp/tools';
import { HomeGraph } from '../src';

function exploreOf(cg: HomeGraph) {
  const explore = new ToolHandler(cg).getTools().find((t) => t.name === 'homegraph_explore');
  expect(explore, 'homegraph_explore must stay exposed at 0 files (#964)').toBeDefined();
  return explore!;
}

describe('homegraph_explore description at fileCount === 0 (Spec 0027)', () => {
  let tempDir: string;
  let cg: HomeGraph | null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-zero-files-'));
    cg = null;
  });

  afterEach(() => {
    cg?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('still-building index never says "(0 files indexed)" or a call budget', async () => {
    // Empty db (fast map not yet populated) + auto-init mid-flight phase.
    cg = await HomeGraph.init(tempDir, { index: false });
    cg.setBuildPhase('indexing');
    const d = exploreOf(cg).description;
    expect(d).toContain('status=fast');
    expect(d).toContain('homegraph_project');
    expect(d).not.toContain('files indexed');
    expect(d).not.toMatch(/Budget: make at most/);
  });

  it('failed full build says so and relays to the user, even though build_phase rolled back', async () => {
    cg = await HomeGraph.init(tempDir, { index: false });
    // startBackgroundFullBuild's catch rolls build_phase back to 'fast' on
    // failure — the failed note must win over the building note here.
    cg.setBuildPhase('fast');
    cg.getQueryBuilder().setMetadata('index_state', 'failed');
    const d = exploreOf(cg).description;
    expect(d).toMatch(/index build .* failed|failed/i);
    expect(d).toContain('homegraph index');
    expect(d).not.toMatch(/still building/i);
    expect(d).not.toContain('files indexed');
  });

  it('completed-but-empty project (phase=full) gets the honest empty note', async () => {
    cg = await HomeGraph.init(tempDir, { index: false });
    cg.setBuildPhase('full');
    const d = exploreOf(cg).description;
    expect(d).toMatch(/No files are indexed/i);
    expect(d).not.toMatch(/still building/i);
    expect(d).not.toMatch(/Budget: make at most/);
    expect(d).not.toContain('(0 files indexed)');
  });

  it('phase=none (no build pipeline yet) reads as empty status (Spec 0032)', async () => {
    cg = await HomeGraph.init(tempDir, { index: false });
    // getBuildPhase falls back to 'none' on an empty db.
    expect(cg.getBuildPhase()).toBe('none');
    const d = exploreOf(cg).description;
    expect(d).toContain('status=empty');
    expect(d).not.toContain('files indexed');
  });

  it('fileCount > 0 keeps the budget note byte-for-byte (0021 budget contract)', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'pay.ts'),
      'export function processPayment(amount: number): boolean { return amount > 0; }\n'
    );
    cg = await HomeGraph.init(tempDir, { index: true });
    const d = exploreOf(cg).description;
    expect(d.endsWith('Budget: make at most 1 calls for this project (1 files indexed).')).toBe(true);
  });

  it('read-only annotations survive the 0-file description rewrite (#1018)', async () => {
    cg = await HomeGraph.init(tempDir, { index: false });
    cg.setBuildPhase('indexing');
    const explore = exploreOf(cg);
    expect(explore.annotations?.readOnlyHint).toBe(true);
    expect(explore.annotations?.destructiveHint).toBe(false);
  });
});
