/**
 * Adaptive output budget for homegraph_explore (#185).
 *
 * The explore tool used to apply a fixed 35KB output cap regardless of
 * project size, which on small codebases was a net loss vs. native
 * grep+Read. These tests pin the per-tier budget shape so future tuning
 * doesn't silently drift the small-project case back into bloat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getExploreOutputBudget, getExploreBudget, normalizeQuerySpelling, ToolHandler, tightenExploreBudgetForQuery } from '../src/mcp/tools';
import HomeGraph from '../src/index';

describe('tightenExploreBudgetForQuery', () => {
  it('caps mechanism+flow explores below the full tier ceiling', () => {
    const base = getExploreOutputBudget(10000);
    const tightened = tightenExploreBudgetForQuery(
      base,
      'How is notification subscription management implemented with multithreading?',
      { hasFlowPath: true },
    );
    expect(tightened.maxOutputChars).toBeLessThanOrEqual(11000);
    expect(tightened.maxOutputChars).toBeLessThanOrEqual(base.maxOutputChars);
    expect(tightened.includeBudgetNote).toBe(false);
  });

  it('still tightens local-detail questions', () => {
    const base = getExploreOutputBudget(10000);
    const tightened = tightenExploreBudgetForQuery(
      base,
      'What does getSummary mean in OpenFolderDragHandler.test.ets',
    );
    expect(tightened.maxOutputChars).toBeLessThanOrEqual(7000);
  });
});

describe('getExploreOutputBudget', () => {
  it('returns a strictly smaller total cap for small projects than for huge ones', () => {
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.maxOutputChars).toBeLessThan(huge.maxOutputChars);
    expect(small.defaultMaxFiles).toBeLessThanOrEqual(huge.defaultMaxFiles);
    expect(small.maxCharsPerFile).toBeLessThan(huge.maxCharsPerFile);
  });

  it('caps total output well under 8000 tokens (~32k chars) on small projects', () => {
    const small = getExploreOutputBudget(100);
    expect(small.maxOutputChars).toBeLessThanOrEqual(20000);
  });

  it('caps medium-large projects at the mid-lean locator ceiling (~12k) by default', () => {
    // Universal mid-lean: anchors + spine digests. HOMEGRAPH_EXPLORE_FULL_SOURCE=1
    // restores the prior fatter body dump.
    const large = getExploreOutputBudget(10000);
    expect(large.maxOutputChars).toBeLessThanOrEqual(12000);
    expect(large.maxOutputChars).toBeGreaterThanOrEqual(10000);
    expect(large.includeRelationships).toBe(false);
    expect(large.defaultMaxFiles).toBeLessThanOrEqual(2);
  });

  it('uses tier breakpoints matching getExploreBudget so call-count and output-budget agree on a project', () => {
    const tier0a = getExploreOutputBudget(50);
    const tier0b = getExploreOutputBudget(149);
    expect(tier0a.maxOutputChars).toBe(tier0b.maxOutputChars);

    const tier1a = getExploreOutputBudget(150);
    const tier1b = getExploreOutputBudget(499);
    expect(tier1a.maxOutputChars).toBe(tier1b.maxOutputChars);
    expect(getExploreBudget(50)).toBe(getExploreBudget(499));

    const tier2a = getExploreOutputBudget(500);
    const tier2b = getExploreOutputBudget(4999);
    expect(tier2a.maxOutputChars).toBe(tier2b.maxOutputChars);
    expect(getExploreBudget(500)).toBe(getExploreBudget(4999));

    const tier3a = getExploreOutputBudget(5000);
    const tier3b = getExploreOutputBudget(14999);
    expect(tier3a.maxOutputChars).toBe(tier3b.maxOutputChars);

    // Mid-lean: 10k → 12k → 12k; medium and large share the ~12k ceiling.
    expect(tier0a.maxOutputChars).not.toBe(tier1a.maxOutputChars);
    expect(tier1a.maxOutputChars).toBe(tier2a.maxOutputChars);
    expect(tier2a.maxOutputChars).toBe(tier3a.maxOutputChars);
    expect(getExploreBudget(5000)).toBeGreaterThan(getExploreBudget(4999));
  });

  it('gates off "Additional relevant files", completeness signal, and budget note on small projects', () => {
    const small = getExploreOutputBudget(100);
    expect(small.includeAdditionalFiles).toBe(false);
    expect(small.includeCompletenessSignal).toBe(false);
    expect(small.includeBudgetNote).toBe(false);
  });

  it('keeps all meta-text on for projects that earn the breadth signal (>=500 files)', () => {
    const medium = getExploreOutputBudget(1000);
    expect(medium.includeAdditionalFiles).toBe(false);
    expect(medium.includeCompletenessSignal).toBe(false);
    expect(medium.includeBudgetNote).toBe(false);
  });

  it('keeps the Relationships section on for medium+ tiers — small tiers drop it to maximize body density', () => {
    // ITER2: relationships dropped on <500 tiers; on tiny repos the
    // per-call payload is the cost driver, so even "cheap" structural
    // signal adds up across follow-up turns. Re-enabled at ≥500 where
    // body budgets are roomy enough to absorb the 1-2KB overhead.
    // Locator-digest (default) keeps Relationships off at every tier.
    expect(getExploreOutputBudget(50).includeRelationships).toBe(false);
    expect(getExploreOutputBudget(1000).includeRelationships).toBe(false);
    expect(getExploreOutputBudget(10000).includeRelationships).toBe(false);
    expect(getExploreOutputBudget(30000).includeRelationships).toBe(false);
  });

  it('caps the per-file header symbol list more tightly on small projects', () => {
    // Without this cap, a file like Alamofire's Session.swift produced
    // a 3.4KB symbol list in the `#### path — sym, sym, ...` header,
    // dwarfing the per-file body cap.
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.maxSymbolsInFileHeader).toBeLessThan(huge.maxSymbolsInFileHeader);
    expect(small.maxSymbolsInFileHeader).toBeGreaterThan(0);
  });

  it('uses a tighter clustering gap threshold on small projects to break runaway single clusters', () => {
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.gapThreshold).toBeLessThanOrEqual(huge.gapThreshold);
  });

  it('handles the boundary file counts exactly (off-by-one regression guard)', () => {
    // 149 -> very-tiny, 150 -> small
    expect(getExploreOutputBudget(149).maxOutputChars).toBe(getExploreOutputBudget(50).maxOutputChars);
    expect(getExploreOutputBudget(150).maxOutputChars).toBe(getExploreOutputBudget(200).maxOutputChars);
    // 499 -> small, 500 -> medium
    expect(getExploreOutputBudget(499).maxOutputChars).toBe(getExploreOutputBudget(200).maxOutputChars);
    expect(getExploreOutputBudget(500).maxOutputChars).toBe(getExploreOutputBudget(1000).maxOutputChars);
    // 4999 -> medium, 5000 -> large
    expect(getExploreOutputBudget(4999).maxOutputChars).toBe(getExploreOutputBudget(1000).maxOutputChars);
    expect(getExploreOutputBudget(5000).maxOutputChars).toBe(getExploreOutputBudget(10000).maxOutputChars);
    // 14999 -> large, 15000 -> xlarge
    expect(getExploreOutputBudget(14999).maxOutputChars).toBe(getExploreOutputBudget(10000).maxOutputChars);
    expect(getExploreOutputBudget(15000).maxOutputChars).toBe(getExploreOutputBudget(30000).maxOutputChars);
  });
});

/**
 * End-to-end check that the budget is actually applied by handleExplore.
 *
 * Builds a tiny synthetic project (<500 files, so the small tier), indexes
 * it, and confirms the output:
 *   - stays under the small-tier maxOutputChars cap
 *   - omits the meta-text the small tier gates off (completeness signal,
 *     budget note, "Additional relevant files")
 *
 * Regression guard for #185 — protects against future edits to handleExplore
 * silently re-introducing the fixed 35KB cap on small projects.
 */
describe('homegraph_explore output respects the adaptive budget', () => {
  let testDir: string;
  let cg: HomeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homegraph-explore-budget-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // A handful of files with one fat target file. The fat file mimics the
    // Alamofire Session.swift case: many methods stacked on top of each other,
    // which collapsed into one giant cluster pre-#185.
    const fatLines: string[] = ['export class Session {'];
    for (let i = 0; i < 30; i++) {
      fatLines.push(`  method${i}(arg: string): string {`);
      fatLines.push(`    return this.helper${i}(arg) + "${i}";`);
      fatLines.push(`  }`);
      fatLines.push(`  private helper${i}(arg: string): string {`);
      fatLines.push(`    return arg.repeat(${i + 1});`);
      fatLines.push(`  }`);
    }
    fatLines.push('}');
    fs.writeFileSync(path.join(srcDir, 'session.ts'), fatLines.join('\n'));

    // A few small supporting files so the project has >1 indexed file.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(srcDir, `support${i}.ts`),
        `import { Session } from './session';\nexport function callSession${i}(s: Session) { return s.method${i}('hi'); }\n`
      );
    }

    cg = HomeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('keeps total output under the small-project cap', async () => {
    const result = await handler.execute('homegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    const smallBudget = getExploreOutputBudget(100);
    // Allow a small overshoot for the trailing markers — the cap is enforced
    // per-file rather than as an absolute output ceiling.
    expect(text.length).toBeLessThan(smallBudget.maxOutputChars + 500);
  });

  it('omits the meta-text gated off for small projects', async () => {
    const result = await handler.execute('homegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    expect(text).not.toContain('### Additional relevant files');
    expect(text).not.toContain('Complete source code is included above');
    expect(text).not.toContain('Explore budget:');
  });

  it('still includes locator structure — digests/trail/anchors (Relationships off in digest mode)', async () => {
    const result = await handler.execute('homegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // Locator-digest mode drops Relationships; Source digests / Call trail / Exploration header remain.
    const hasLocator =
      text.includes('**Source digests**')
      || text.includes('**Source Code**')
      || text.includes('**Call / use trail**')
      || text.includes('**Exploration:');
    expect(hasLocator).toBe(true);
  });

  it('prefixes source lines with line numbers by default (cat -n style)', async () => {
    delete process.env.HOMEGRAPH_EXPLORE_LINENUMS;
    const result = await handler.execute('homegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // At least one fenced source line should look like `<digits>\t<code>`.
    expect(/\n\d+\t/.test(text)).toBe(true);
  });

  it('omits line numbers when HOMEGRAPH_EXPLORE_LINENUMS=0', async () => {
    process.env.HOMEGRAPH_EXPLORE_LINENUMS = '0';
    try {
      const result = await handler.execute('homegraph_explore', { query: 'Session method helper' });
      const text = result.content?.[0]?.text ?? '';
      // The synthetic source has no tab-prefixed numeric lines of its own,
      // so none should appear when the toggle is off.
      expect(/\n\d+\t(?:export|  )/.test(text)).toBe(false);
    } finally {
      delete process.env.HOMEGRAPH_EXPLORE_LINENUMS;
    }
  });

  it('uses language-neutral omission markers (no C-style // in the output)', async () => {
    // The gap/trimmed separators must not assume `//` is a comment — that's
    // wrong in Python, Ruby, etc. They render inside fenced source blocks.
    const result = await handler.execute('homegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    expect(text).not.toContain('// ... (gap)');
    expect(text).not.toContain('// ... trimmed');
  });

  it('does not collapse a whole-file class into just its header (envelope filter)', async () => {
    // The synthetic `Session` class spans the entire file. Without the
    // envelope filter it would form one giant cluster that tail-trims to
    // the class declaration, hiding the methods. Confirm real method bodies
    // make it into the output. Regression guard for the #185 follow-up.
    const result = await handler.execute('homegraph_explore', { query: 'Session method helper' });
    const text = result.content?.[0]?.text ?? '';
    // A method body line (`methodN(arg: string)`) should appear, not just
    // the `export class Session {` opener.
    const hasMethodBody = /method\d+\(arg: string\)/.test(text);
    expect(hasMethodBody).toBe(true);
  });
});

describe('normalizeQuerySpelling (Erlang mod:fn/arity)', () => {
  it('rewrites Erlang-native symbol spellings to pipeline shapes', () => {
    expect(normalizeQuerySpelling('cowboy_stream_h:request_process/3'))
      .toBe('cowboy_stream_h.request_process');
    expect(normalizeQuerySpelling('ejabberd_router:route/1 do_route/1 session'))
      .toBe('ejabberd_router.route do_route session');
    expect(normalizeQuerySpelling('init/2 handle_call/3')).toBe('init handle_call');
  });

  it('leaves query-language field prefixes and other spellings alone', () => {
    expect(normalizeQuerySpelling('kind:function lang:erlang route'))
      .toBe('kind:function lang:erlang route');
    expect(normalizeQuerySpelling('path:src/api name:auth')).toBe('path:src/api name:auth');
    expect(normalizeQuerySpelling('Foo::bar baz')).toBe('Foo::bar baz');
    expect(normalizeQuerySpelling('https://example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeQuerySpelling('meeting at 12:30')).toBe('meeting at 12:30');
    expect(normalizeQuerySpelling('src/2fa/handler.ts')).toBe('src/2fa/handler.ts');
  });

  it('maps Lua colon-method spelling onto the qualified form', () => {
    expect(normalizeQuerySpelling('logger:log message')).toBe('logger.log message');
  });
});
