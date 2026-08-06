/**
 * Explore routing regression suite.
 *
 * Pins exclusive routes for every shape in `corpus.ts`. If you change a
 * classifier to fix one shape, this suite fails on any collateral damage.
 */
import { describe, it, expect } from 'vitest';
import * as q from '../../src/search/query-utils';
import { ROUTING_CORPUS, resolveExploreRoute } from './corpus';

describe('explore-routing corpus (exclusive routes)', () => {
  for (const c of ROUTING_CORPUS) {
    it(`${c.id} → ${c.expect} (${c.shape})`, () => {
      const route = resolveExploreRoute(c.query, q);
      expect(route, `query: ${c.query}`).toBe(c.expect);

      if (c.pins?.literalHunt !== undefined) {
        expect(q.queryLooksLikeLiteralOrCopyHunt(c.query)).toBe(c.pins.literalHunt);
      }
      if (c.pins?.preferExplore !== undefined) {
        expect(q.queryShouldPreferExploreOverSearch(c.query)).toBe(c.pins.preferExplore);
      }
      if (c.pins?.kitInstall !== undefined) {
        expect(q.queryAsksKitInstallDeps(c.query)).toBe(c.pins.kitInstall);
      }
      if (c.pins?.dataSource !== undefined) {
        expect(q.queryAsDataSourceSurvey(c.query)).toBe(c.pins.dataSource);
      }
      if (c.pins?.lifecycle !== undefined) {
        expect(q.queryAsTypeLifecycleSurvey(c.query)).toBe(c.pins.lifecycle);
      }
      if (c.pins?.memberFocus !== undefined) {
        expect(q.queryHasNamedMemberFocus(c.query)).toBe(c.pins.memberFocus);
      }

      // Mutual exclusion: at most one of light / inventory / defer.
      const flags = [
        !!q.queryShouldDeferToBuiltinTools(c.query),
        q.shouldTryLightMechanismExplore(c.query),
        q.shouldTryFastInventoryExplore(c.query),
      ];
      expect(flags.filter(Boolean).length).toBeLessThanOrEqual(1);
    });
  }
});

describe('explore-routing anti-regression guards', () => {
  it('member usage inventory does not steal Type×method interaction', () => {
    const interact =
      'LayoutDraftExt 类里的draft.CanPlace(element) 和 draft.Place(element)是怎么和BinaryGrid 交互来检测重叠和更新网格的？';
    expect(q.shouldPreferMemberUsageInventory(interact)).toBe(false);
    expect(q.shouldTryFastInventoryExplore(interact)).toBe(false);
    expect(q.shouldTryLightMechanismExplore(interact)).toBe(false);
    expect(q.queryAsLocalSymbolDetail(interact)).toBe(true);
  });

  it('member usage inventory still owns .drawModifier listings', () => {
    const listing = '哪些组件使用了 .drawModifier 或 DrawContext 进行自定义绘制？';
    expect(q.shouldPreferMemberUsageInventory(listing)).toBe(true);
    expect(q.shouldTryFastInventoryExplore(listing)).toBe(true);
  });

  it('状态来源 is data-source inventory, not lifecycle compact', () => {
    const qy = 'AccountManager 内部对于账户状态变化的“状态来源”是如何统一或区分的？';
    expect(q.queryAsDataSourceSurvey(qy)).toBe(true);
    expect(q.queryAsTypeLifecycleSurvey(qy)).toBe(false);
    expect(q.shouldTryFastInventoryExplore(qy)).toBe(true);
    expect(q.queryAsLocalSymbolDetail(qy)).toBe(false);
  });

  it('Release↔destructor is lifecycle/local, not member inventory', () => {
    const qy =
      'OnSurfaceDestroyedCB 里调了 PluginManager::GetRender()->Release()。这个 Release 函数做了哪些事情？跟 PluginRender 的析构函数里做的事有没有重复？';
    expect(q.queryAsTypeLifecycleSurvey(qy)).toBe(true);
    expect(q.shouldPreferMemberUsageInventory(qy)).toBe(false);
    expect(q.shouldTryFastInventoryExplore(qy)).toBe(false);
    expect(q.queryAsLocalSymbolDetail(qy)).toBe(true);
  });

  it('literal text hunts never light or inventory', () => {
    const qy = '全仓中有哪些从图形包中导入的 text 对象，导入它编辑文字有什么优势';
    expect(q.queryLooksLikeLiteralOrCopyHunt(qy)).toBe(true);
    expect(q.shouldTryLightMechanismExplore(qy)).toBe(false);
    expect(q.shouldTryFastInventoryExplore(qy)).toBe(false);
    expect(q.queryShouldDeferToBuiltinTools(qy)).toBeTruthy();
  });

  it('kit extra-deps never loses to light-mechanism', () => {
    for (const qy of [
      '调用ServiceCollaborationKit需要引入其他参数和依赖么？',
      '调用 ServiceCollaborationKit 需要额外安装哪些依赖？',
    ]) {
      expect(q.shouldTryLightMechanismExplore(qy)).toBe(false);
      expect(q.shouldBuildKitModuleUsageSurvey(qy)).toBe(true);
      expect(q.shouldTryFastInventoryExplore(qy)).toBe(true);
    }
  });

  it('caller+visibility never light', () => {
    const qy =
      '项目中哪里调用了SortWidgets，其中哪些调用是用来确保IntGrid 的定义可见的？';
    expect(q.queryNeedsCoNamedUseBridge(qy)).toBe(true);
    expect(q.shouldTryLightMechanismExplore(qy)).toBe(false);
    expect(q.shouldTryFastInventoryExplore(qy)).toBe(false);
  });

  it('listed-method callers stay inventory (not Type×method interaction)', () => {
    const qy = '哪些文件调用了BinaryGrid 模板类的 Set、Test 或 Fill 方法？';
    expect(q.queryAsCallerOrMethodSurvey(qy)).toBe(true);
    expect(q.queryHasNamedMemberFocus(qy)).toBe(false);
    expect(q.shouldTryFastInventoryExplore(qy)).toBe(true);
    expect(q.shouldTryLightMechanismExplore(qy)).toBe(false);
  });

  it('xml howto seeds convertxml (not bare xml-only)', () => {
    const qy = '项目中是如何实现xml解析功能的';
    expect(q.shouldTryLightMechanismExplore(qy)).toBe(true);
    const seeds = q.extractMechanismEntrySeeds(qy);
    expect(seeds.map((s) => s.toLowerCase())).toEqual(
      expect.arrayContaining(['convertxml', 'xmlparseutil']),
    );
  });
});
