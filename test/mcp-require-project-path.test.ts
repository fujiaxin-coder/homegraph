/**
 * No-default-project → projectPath is `required` in the tool schema (issue #993).
 *
 * When the MCP server has no default project to fall back to — a gateway server
 * started outside any repo, or a monorepo root whose `.homegraph/` indexes live
 * only in sub-projects — every tool call MUST carry an explicit `projectPath`.
 * `ToolHandler.getTools()` reflects that by marking `projectPath` required in the
 * exposed schemas, a high-salience nudge that gets the agent to pass it on the
 * first call instead of omitting it (the reported behavior). When a default
 * project IS open, projectPath stays optional: a bare call falls back to it.
 *
 * The property description must match: required surface says Required (no
 * "Omit…"); optional surface keeps Omit. Runtime is unchanged — missing
 * projectPath with no default still returns SUCCESS-shaped guidance (never
 * `isError`), and a missing projectPath WITH a default still falls back to it.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler, tools } from '../src/mcp/tools';
import { HomeGraph } from '../src';

const ENV = 'HOMEGRAPH_MCP_TOOLS';

type ToolDef = {
  name: string;
  inputSchema: {
    required?: string[];
    properties: { projectPath?: { description: string } };
  };
};

const exploreOf = (defs: ToolDef[]) => defs.find((t) => t.name === 'homegraph_explore')!;

const projectPathDesc = (tool: ToolDef) => tool.inputSchema.properties.projectPath!.description;

describe('No-default-project requires projectPath in the schema (#993)', () => {
  const originalAllowlist = process.env[ENV];
  afterEach(() => {
    if (originalAllowlist === undefined) delete process.env[ENV];
    else process.env[ENV] = originalAllowlist;
  });

  it('marks projectPath required on homegraph_explore when no default project is loaded', () => {
    const explore = exploreOf(new ToolHandler(null).getTools());
    expect(explore.inputSchema.required).toContain('projectPath');
    // The tool's own required arg is preserved, not replaced.
    expect(explore.inputSchema.required).toContain('query');
  });

  it('required projectPath description does not say Omit (schema/prose agree)', () => {
    const explore = exploreOf(new ToolHandler(null).getTools());
    const desc = projectPathDesc(explore);
    expect(desc).toMatch(/^Required\./);
    expect(desc).toMatch(/no default project/i);
    expect(desc).not.toMatch(/\bOmit\b/);
  });

  it('requires projectPath on EVERY exposed tool, incl. ones with no prior required list', () => {
    // status has no `required` array of its own → it should gain ['projectPath'].
    process.env[ENV] = 'explore,node,status';
    const got = new ToolHandler(null).getTools();
    expect(got.map((t) => t.name).sort()).toEqual([
      'homegraph_explore',
      'homegraph_node',
      'homegraph_status',
    ]);
    for (const t of got) {
      expect(t.inputSchema.required ?? []).toContain('projectPath');
      expect(projectPathDesc(t)).toMatch(/^Required\./);
      expect(projectPathDesc(t)).not.toMatch(/\bOmit\b/);
    }
  });

  it('does NOT mutate the shared module-level tools array (purity)', () => {
    // Marking required must clone — otherwise a no-default session would corrupt
    // the schema every later default-project session reuses.
    new ToolHandler(null).getTools();
    expect(exploreOf(tools).inputSchema.required).toEqual(['query']);
    expect(projectPathDesc(exploreOf(tools))).toMatch(/\bOmit\b/);
    expect(projectPathDesc(exploreOf(tools))).not.toMatch(/^Required\./);
  });

  it('a missing projectPath with no default is still SUCCESS-shaped guidance, not isError', async () => {
    // Schema-only change: the runtime backstop is unchanged. A client that
    // ignores `required` still gets the nudge, never a session-souring isError.
    const res = await new ToolHandler(null).execute('homegraph_explore', { query: 'anything' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/No HomeGraph project is loaded/);
    expect(res.content[0]!.text).toMatch(/projectPath/);
  });
});

describe('A default project keeps projectPath OPTIONAL (#993)', () => {
  let tempDir: string;
  let cg: HomeGraph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-reqpath-'));
    fs.writeFileSync(
      path.join(tempDir, 'pay.ts'),
      'export function processPayment(amount: number): boolean { return amount > 0; }\n'
    );
    cg = await HomeGraph.init(tempDir, { index: true });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('leaves projectPath optional when a default project is loaded', () => {
    const explore = exploreOf(new ToolHandler(cg).getTools());
    expect(explore.inputSchema.required).toEqual(['query']);
    expect(explore.inputSchema.required).not.toContain('projectPath');
  });

  it('optional projectPath description keeps Omit wording', () => {
    const explore = exploreOf(new ToolHandler(cg).getTools());
    const desc = projectPathDesc(explore);
    expect(desc).toMatch(/\bOmit\b/);
    expect(desc).not.toMatch(/^Required\./);
  });

  it('a bare call (no projectPath) still falls back to the default project', async () => {
    const res = await new ToolHandler(cg).execute('homegraph_explore', { query: 'processPayment' });
    expect(res.isError).toBeUndefined();
    // Resolved against the default project — not the no-default guidance.
    expect(res.content[0]!.text).not.toMatch(/No HomeGraph project is loaded/);
    expect(res.content[0]!.text).toMatch(/processPayment/);
  });
});
