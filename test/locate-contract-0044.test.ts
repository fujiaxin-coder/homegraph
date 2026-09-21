/**
 * Spec 0044 — explore locate contract helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyLocateOutcome,
  formatFilenameDeclarationMismatch,
  formatLocatedBanner,
  formatMissBanner,
  formatPartialBanner,
  isLogOrToastSpineName,
  locatedNamesFromEmission,
  queryNamesLogOrToast,
  shouldDemoteLogToastSpine,
  shouldExemptDepthFuseForLocatedSymbol,
  shouldSuppressSynonymExpansion,
  symbolMatchesLocatedNames,
  FILENAME_DECL_MISMATCH_MARKER,
  LOCATED_MARKER,
  MISS_MARKER,
} from '../src/mcp/locate-contract';
import { ExploreSessionState } from '../src/mcp/explore-session-state';
import { decideDepthToolFuse } from '../src/mcp/explore-repeat-guard';

describe('locate-contract (spec 0044)', () => {
  it('demotes Logger/hilog/Toast unless the query names them', () => {
    expect(isLogOrToastSpineName('Logger')).toBe(true);
    expect(isLogOrToastSpineName('logInfo')).toBe(true);
    expect(shouldDemoteLogToastSpine('Logger', '预估重量 物品信息')).toBe(true);
    expect(shouldDemoteLogToastSpine('Logger', 'how does Logger.info work')).toBe(false);
    expect(queryNamesLogOrToast('show Toast on error')).toBe(true);
  });

  it('classifies Located / Partial / Miss', () => {
    expect(classifyLocateOutcome({
      hasExactAnchorHit: true,
      hasLiteralWitness: false,
      hasFullDeclarations: true,
      missingStaticRelation: false,
      budgetPartial: false,
    })).toBe('located');
    expect(classifyLocateOutcome({
      hasExactAnchorHit: true,
      hasLiteralWitness: false,
      hasFullDeclarations: true,
      missingStaticRelation: true,
      budgetPartial: false,
    })).toBe('partial');
    expect(classifyLocateOutcome({
      hasExactAnchorHit: false,
      hasLiteralWitness: false,
      hasFullDeclarations: false,
      missingStaticRelation: false,
      budgetPartial: false,
    })).toBe('miss');
    expect(classifyLocateOutcome({
      hasExactAnchorHit: false,
      hasLiteralWitness: true,
      hasFullDeclarations: true,
      missingStaticRelation: false,
      budgetPartial: false,
    })).toBe('located');
  });

  it('formats Located / Partial / Miss banners', () => {
    expect(formatLocatedBanner()).toContain(LOCATED_MARKER);
    expect(formatLocatedBanner()).toMatch(/do \*\*not\*\* Grep the same symbol/i);
    expect(formatPartialBanner()).toMatch(/homegraph_node/);
    expect(formatPartialBanner()).toMatch(/homegraph_usages/);
    expect(formatPartialBanner()).toMatch(/homegraph_search/);
    const miss = formatMissBanner(['pages/A.ets', 'pages/B.ets']);
    expect(miss).toContain(MISS_MARKER);
    expect(miss).toContain('`pages/A.ets`');
    expect(miss).not.toMatch(/```/);
    expect(miss).toMatch(/homegraph_search/);
  });

  it('warns when filename stem ≠ primary declaration', () => {
    const note = formatFilenameDeclarationMismatch(
      'pages/PracticeDetailView.ets',
      'SampleDetailView',
    );
    expect(note).toContain(FILENAME_DECL_MISMATCH_MARKER);
    expect(note).toContain('PracticeDetailView');
    expect(note).toContain('SampleDetailView');
    expect(formatFilenameDeclarationMismatch('pages/Foo.ets', 'Foo')).toBeNull();
    expect(formatFilenameDeclarationMismatch('pages/foo-bar.ets', 'FooBar')).toBeNull();
  });

  it('suppresses synonym expansion only without exact/literal anchors', () => {
    expect(shouldSuppressSynonymExpansion({
      hasExactAnchorHit: false,
      hasLiteralWitness: false,
    })).toBe(true);
    expect(shouldSuppressSynonymExpansion({
      hasExactAnchorHit: true,
      hasLiteralWitness: false,
    })).toBe(false);
  });

  it('matches located symbol names including qualified forms', () => {
    expect(symbolMatchesLocatedNames('SampleDetailView', ['SampleDetailView'])).toBe(true);
    expect(symbolMatchesLocatedNames('Page.SampleDetailView', ['SampleDetailView'])).toBe(true);
    expect(symbolMatchesLocatedNames('Other', ['SampleDetailView'])).toBe(false);
    expect(locatedNamesFromEmission({
      projectRoot: '/r',
      query: 'q',
      files: [],
      sourceBytes: 10,
      responseBytes: 100,
      locatedNodes: [
        { id: '1', name: 'Foo', qualifiedName: 'mod.Foo', filePath: 'a.ets', startLine: 1 },
      ],
    })).toEqual(expect.arrayContaining(['Foo', 'mod.Foo']));
  });

  it('exempts depth fuse for symbols already on the locate list (10.2)', () => {
    const s = new ExploreSessionState();
    s.record({
      projectRoot: '/repo',
      query: 'PracticeDetailView',
      files: [{ path: 'a.ets', ranges: [{ start: 1, end: 20 }], bytes: 400 }],
      sourceBytes: 400,
      responseBytes: 5000,
      partial: true,
      evidenceStatus: 'partial',
      locatedNodes: [
        { id: '1', name: 'SampleDetailView', filePath: 'a.ets', startLine: 1 },
      ],
    });
    expect(s.recordDepthTool('/repo')).toBe(1);
    const prior = s.forProject('/repo');
    expect(decideDepthToolFuse(prior, 1, 'homegraph_node').refuse).toBe(true);
    expect(shouldExemptDepthFuseForLocatedSymbol(prior, 'SampleDetailView')).toBe(true);
    expect(shouldExemptDepthFuseForLocatedSymbol(prior, 'Unrelated')).toBe(false);
  });
});
