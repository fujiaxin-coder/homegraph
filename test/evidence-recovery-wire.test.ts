import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type HomeGraph from '../src/index';
import { ToolHandler, type ToolResult } from '../src/mcp/tools';
import { EXPLORE_EMISSION_KEY, ExploreSessionState, type ExploreEmission } from '../src/mcp/explore-session-state';
import { fileFingerprint } from '../src/mcp/explore-dedup';
import { decideExploreRepeat, type ExploreRepeatDecision } from '../src/mcp/explore-repeat-guard';

interface ReceiptBoundary {
  takeExploreEmission(result: ToolResult, session: ExploreSessionState): ToolResult;
  noteDepthToolUse(args: Record<string, unknown>, session: ExploreSessionState): void;
  tryDepthToolFuse(tool: string, args: Record<string, unknown>, session: ExploreSessionState): ToolResult | null;
  textResult(text: string): ToolResult;
  getHomeGraph(): HomeGraph;
  shouldRefuseRepeatedEvidence(decision: ExploreRepeatDecision, projectRoot: string): boolean;
}

function receipt(extra: Partial<ExploreEmission> = {}): ToolResult {
  return {
    content: [{ type: 'text', text: 'The requested evidence has not been located.' }],
    [EXPLORE_EMISSION_KEY]: { projectRoot: '/repo', query: 'feedback menu', files: [], sourceBytes: 0,
      responseBytes: 43, evidenceStatus: 'empty', partial: true, ...extra },
  };
}

describe('evidence recovery at the MCP receipt boundary', () => {
  const temporaryDirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('publishes the same normalized evidence status that session protection uses', () => {
    const handler = new ToolHandler(null) as unknown as ReceiptBoundary;
    const session = new ExploreSessionState();
    const out = handler.takeExploreEmission(receipt({ evidenceStatus: 'complete', partial: false,
      uncoveredObligations: ['navigation handler'] }), session);
    expect(out[EXPLORE_EMISSION_KEY]).toBeUndefined();
    expect((out._meta?.homegraphEvidence as { status: string }).status).toBe('partial');
    expect(session.forProject('/repo')?.calls[0]?.evidenceStatus).toBe('partial');
  });

  it('counts the one depth recovery after an empty response shorter than 400 chars', () => {
    const handler = new ToolHandler(null) as unknown as ReceiptBoundary;
    vi.spyOn(handler, 'getHomeGraph').mockReturnValue({ getProjectRoot: () => '/repo' } as HomeGraph);
    const session = new ExploreSessionState();
    handler.takeExploreEmission(receipt(), session);
    expect(handler.tryDepthToolFuse('homegraph_callers', { symbol: 'MenuPage' }, session)).toBeNull();
    handler.noteDepthToolUse({}, session);
    expect(session.depthToolCount('/repo')).toBe(1);
    const refused = handler.tryDepthToolFuse('homegraph_node', { symbol: 'MenuPage' }, session);
    expect(refused?.content[0]?.text).toMatch(/evidence may still be incomplete/);
  });

  it('reports the exhausted retrieval budget after two short incomplete responses', () => {
    const handler = new ToolHandler(null) as unknown as ReceiptBoundary;
    const session = new ExploreSessionState();
    handler.takeExploreEmission(receipt(), session);
    const out = handler.takeExploreEmission(receipt({ query: 'feedback navigation resources' }), session);
    expect(out.content[0]?.text).toMatch(/Second Partial/);
    expect(out.content[0]?.text).toMatch(/Evidence remains incomplete/);
    expect(out.content[0]?.text).toMatch(/continue the requested edits and validation/);
    expect(session.callCount('/repo')).toBe(2);
  });

  it('does not alter source strings while normalizing completion guidance', () => {
    const handler = new ToolHandler(null) as unknown as ReceiptBoundary;
    const source = '17\tconst caption = "ANSWER NOW";';
    const out = handler.textResult([
      '> **Partial locator** — the registration has not been found.',
      '```ts', source, '```',
      '> **ANSWER NOW** from the returned inventory.',
    ].join('\n'));
    expect(out.content[0]?.text).toContain(source);
    expect(out.content[0]?.text).not.toContain('> **ANSWER NOW**');
  });

  function fingerprintFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-repeat-freshness-'));
    temporaryDirs.push(root);
    const file = path.join(root, 'Player.ts');
    const source = 'export function play() { return "before"; }\n';
    fs.writeFileSync(file, source);
    const session = new ExploreSessionState();
    session.record({ projectRoot: root, query: 'Player play', evidenceStatus: 'complete', partial: false,
      sourceBytes: source.length, responseBytes: 800, files: [{ path: 'Player.ts',
        ranges: [{ start: 1, end: 1 }], bytes: source.length, fingerprint: fileFingerprint(source) }] });
    return { root, file, source, session, decision: decideExploreRepeat(session.forProject(root), 'Player play'),
      handler: new ToolHandler(null) as unknown as ReceiptBoundary };
  }

  it('deduplicates unchanged evidence but permits a same-query refresh after an edit', () => {
    const { root, file, source, decision, handler } = fingerprintFixture();
    expect(decision.reason).toBe('overlap');
    expect(handler.shouldRefuseRepeatedEvidence(decision, root)).toBe(true);
    // Equal-length edits must invalidate the content receipt too.
    fs.writeFileSync(file, source.replace('before', 'after!'));
    expect(handler.shouldRefuseRepeatedEvidence(decision, root)).toBe(false);
    expect(handler.shouldRefuseRepeatedEvidence({ ...decision, reason: 'hard-cap' }, root)).toBe(true);
  });

  it('does not claim unchanged evidence for deleted, oversized or escaped files', () => {
    const { root, file, decision, handler } = fingerprintFixture();
    fs.rmSync(file);
    expect(handler.shouldRefuseRepeatedEvidence(decision, root)).toBe(false);
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
    expect(handler.shouldRefuseRepeatedEvidence(decision, root)).toBe(false);
    fs.rmSync(file);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-repeat-outside-'));
    temporaryDirs.push(outside);
    const target = path.join(outside, 'outside.ts');
    fs.writeFileSync(target, 'export function play() { return "before"; }\n');
    fs.symlinkSync(target, file);
    expect(handler.shouldRefuseRepeatedEvidence(decision, root)).toBe(false);
  });
});
