import { describe, it, expect } from 'vitest';
import {
  extractFileBasenamesFromQuery,
  extractKitModuleNamesFromQuery,
  extractKitSubmoduleNamesFromQuery,
  extractMemberAccessFromQuery,
  extractImportSearchTerms,
  extractDependencySymbolsFromQuery,
  extractPathSegmentsFromQuery,
  queryNamesConfigFile,
  queryMentionsCodeContext,
  hasConcreteExploreAnchors,
  shouldCompactImportListing,
  shouldOmitSourceBodies,
  queryNamesMultipleExploreAnchors,
  queryAsKitModuleCapabilitySurvey,
  queryAsOutOfRepoSdkCatalog,
  queryShouldDeferToBuiltinTools,
  homegraphDeferGuidance,
  queryShouldPreferExploreOverSearch,
  queryHasNamedMemberFocus,
  queryAsNamedComponentAction,
  queryAsLocalSymbolDetail,
  shouldTryFastInventoryExplore,
  shouldBuildKitModuleUsageSurvey,
  isMemberLikeIdentifier,
  shouldBuildCallerInventory,
  queryAsCallerOrMethodSurvey,
  shouldBuildInheritanceSurvey,
  queryAsInheritanceSurvey,
  shouldLimitToQueryNamedFile,
  shouldBuildMemberSurvey,
  shouldBuildConfigSection,
  fileMatchesQueryBasename,
  extractDomainSearchTerms,
  queryAsDomainFileSurvey,
  queryAsMechanismSurvey,
  shouldBuildDomainFileSurvey,
  isImplementationEntrySymbol,
  queryAsApiUsageSurvey,
  shouldBuildApiUsageSurvey,
  extractApiUsageTokens,
  shouldFocusOnNamedTypeFile,
  extractCallerSurveySymbols,
  queryAsCrossModuleFlowSurvey,
  queryAsDataSourceSurvey,
  queryAsInterpretationSurvey,
  queryAsTestOnlyInterpretation,
  extractMechanismEntrySeeds,
  shouldTryLightMechanismExplore,
  shouldUseCompactExploreBudget,
  shouldFocusOnQueryNamedDefs,
  queryNeedsCoNamedUseBridge,
  queryHasFocusedNamedAnchors,
  queryAsDomainMechanismBag,
  extractLocalDetailAnchors,
  shouldBuildHoverHandlerSurvey,
  queryAsComponentSurfaceSurvey,
  queryAsFocusedUiCluster,
  queryLooksLikeUiComponentType,
  queryAsDeclarationSiteSurvey,
  queryAsConstantUsageSurvey,
  queryAsFieldUsageSurvey,
  queryAsModuleExportSurvey,
  queryAsModuleDependencySurvey,
  queryAsTypeLifecycleSurvey,
  extractFieldLikeSymbolsFromQuery,
  queryAsInRepoSystemCapabilityHowto,
  queryAsReturnValueConsumerSurvey,
  extractListedTypeMethodsFromQuery,
  queryAsNativeRenderThreadSurvey,
  queryAsDtsWrapSurvey,
  queryAsAssignedFlagImpactSurvey,
  queryAsNamedControlStateSyncSurvey,
} from '../src/search/query-utils';

describe('extractFileBasenamesFromQuery', () => {
  it('extracts standalone file basenames', () => {
    expect(extractFileBasenamesFromQuery('LocationController.ets中 locationManager.on')).toEqual([
      'LocationController',
    ]);
  });

  it('extracts CMakeLists and .d.ts basenames', () => {
    expect(extractFileBasenamesFromQuery('CMakeLists.txt target_link_libraries')).toEqual(['CMakeLists']);
    expect(extractFileBasenamesFromQuery('harmonyShare.d.ts wraps systemShare')).toEqual(['harmonyShare']);
  });

  it('extracts basenames from path-style references (backslash or slash)', () => {
    expect(extractFileBasenamesFromQuery('项目common\\constants.ets中使用到了哪些错误码')).toEqual([
      'constants',
    ]);
    expect(extractFileBasenamesFromQuery('see product/foo/oh-package.json5 deps')).toEqual([
      'oh-package',
    ]);
  });
});

describe('extractPathSegmentsFromQuery', () => {
  it('extracts slash-separated path prefixes', () => {
    expect(extractPathSegmentsFromQuery('feature/foldeffect NAPI surface')).toEqual(['feature/foldeffect']);
    expect(extractPathSegmentsFromQuery('staticcommon/launchercommon deps')).toEqual(['staticcommon/launchercommon']);
  });
});

describe('queryMentionsCodeContext', () => {
  it('detects code context from extensions, api, and kits', () => {
    expect(queryMentionsCodeContext('where is statfs API used')).toBe(true);
    expect(queryMentionsCodeContext('how to get system language')).toBe(false);
    expect(queryMentionsCodeContext('@kit.ArkTS util features')).toBe(true);
  });
});

describe('hasConcreteExploreAnchors', () => {
  it('is true when query names structural code tokens', () => {
    expect(hasConcreteExploreAnchors('CMakeLists.txt libraries')).toBe(true);
    expect(hasConcreteExploreAnchors('.drawModifier custom draw')).toBe(true);
    expect(hasConcreteExploreAnchors('how is the weather')).toBe(false);
  });
});

describe('extractKitModuleNamesFromQuery', () => {
  it('extracts @kit literal and PascalCase *Kit tokens', () => {
    expect(extractKitModuleNamesFromQuery("import from @kit.ArkTS and ServiceCollaborationKit")).toEqual(
      expect.arrayContaining(['ArkTS', 'ServiceCollaborationKit']),
    );
  });
});

describe('extractMemberAccessFromQuery', () => {
  it('extracts receiver.method and leading-dot members', () => {
    const accesses = extractMemberAccessFromQuery(
      'pointer.setPointerStyle 和 .drawModifier 以及 locationManager.on()',
    );
    const dotted = accesses.map((a) => a.dotted);
    expect(dotted).toContain('pointer.setPointerStyle');
    expect(dotted).toContain('.drawModifier');
    expect(dotted).toContain('locationManager.on');
  });

  it('does not treat shared-lib extensions as members', () => {
    const accesses = extractMemberAccessFromQuery(
      'libeffectrender.so 链接了 GLESv3 和 EGL，OpenGL上下文在哪个线程创建',
    );
    expect(accesses.map((a) => a.dotted)).not.toContain('libeffectrender.so');
    expect(accesses.map((a) => a.member)).not.toContain('so');
  });
});

describe('Type-listed method callers / native GL thread', () => {
  it('keeps BinaryGrid Set/Test/Fill in caller symbols', () => {
    const q = '哪些文件调用了BinaryGrid 模板类的 Set、Test 或 Fill 方法？';
    expect(extractListedTypeMethodsFromQuery(q)).toEqual(
      expect.arrayContaining(['Set', 'Test', 'Fill']),
    );
    expect(extractCallerSurveySymbols(q)).toEqual(
      expect.arrayContaining(['BinaryGrid', 'Set', 'Test', 'Fill']),
    );
    expect(shouldBuildCallerInventory(q)).toBe(true);
  });

  it('routes lib*.so + GLES thread to light mechanism', () => {
    const q = 'libeffectrender.so 链接了 GLESv3 和 EGL，OpenGL上下文在哪个线程创建？与XComponent的UI线程是否相同？';
    expect(queryAsNativeRenderThreadSurvey(q)).toBe(true);
    expect(shouldTryLightMechanismExplore(q)).toBe(true);
    expect(queryAsLocalSymbolDetail(q)).toBe(false);
    expect(shouldBuildMemberSurvey(q)).toBe(false);
    expect(extractMechanismEntrySeeds(q)).toEqual(
      expect.arrayContaining(['EGLCore', 'PluginRender']),
    );
  });
});

describe('extractImportSearchTerms', () => {
  it('includes both bare kit name and @kit path', () => {
    expect(extractImportSearchTerms('ServiceCollaborationKit dependency')).toEqual(
      expect.arrayContaining(['ServiceCollaborationKit', '@kit.ServiceCollaborationKit']),
    );
  });
});

describe('extractDependencySymbolsFromQuery', () => {
  it('extracts camelCase API symbols but not kit module names', () => {
    expect(extractDependencySymbolsFromQuery('files importing taskpool from @kit.ArkTS')).toContain(
      'taskpool',
    );
    expect(extractDependencySymbolsFromQuery('files importing taskpool from @kit.ArkTS')).not.toContain(
      'ArkTS',
    );
  });

  it('extracts lowercase API names when query mentions API context', () => {
    expect(extractDependencySymbolsFromQuery('where is statfs API endpoint used')).toContain('statfs');
    const casual = extractDependencySymbolsFromQuery('how to get system language');
    expect(casual).not.toContain('statfs');
  });
});

describe('queryNamesConfigFile', () => {
  it('detects config files by extension in query text', () => {
    expect(queryNamesConfigFile('show build-profile.json5 strictMode value')).toBe(true);
    expect(queryNamesConfigFile('what calls BadgeManager')).toBe(false);
  });
});

describe('shouldCompactImportListing', () => {
  it('compacts when symbol filter matches at least one site', () => {
    expect(shouldCompactImportListing(5, true)).toBe(true);
    expect(shouldCompactImportListing(1, true)).toBe(true);
    expect(shouldCompactImportListing(5, false)).toBe(false);
  });
});

describe('shouldOmitSourceBodies', () => {
  it('omits source for import inventory when graph has no flow path', () => {
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 4,
        hasFilteredImports: true,
        callerBulletCount: 0,
        memberFileCount: 0,
        apiUsageFileCount: 0,
        configRendered: false,
        kitModuleSurveyRendered: false,
        inheritanceListed: false,
        domainFileCount: 0,
        dataSourceEdgeCount: 0,
      }, false, false),
    ).toBe(true);
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 1,
        hasFilteredImports: true,
        callerBulletCount: 0,
        memberFileCount: 0,
        apiUsageFileCount: 0,
        configRendered: false,
        kitModuleSurveyRendered: false,
        inheritanceListed: false,
        domainFileCount: 0,
        dataSourceEdgeCount: 0,
      }, false, false),
    ).toBe(true);
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 4,
        hasFilteredImports: true,
        callerBulletCount: 0,
        memberFileCount: 0,
        apiUsageFileCount: 0,
        configRendered: false,
        kitModuleSurveyRendered: false,
        inheritanceListed: false,
        domainFileCount: 0,
      }, true, false),
    ).toBe(false);
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 4,
        hasFilteredImports: true,
        callerBulletCount: 5,
        memberFileCount: 0,
        apiUsageFileCount: 0,
        configRendered: false,
        kitModuleSurveyRendered: false,
        inheritanceListed: false,
        domainFileCount: 0,
      }, false, true),
    ).toBe(false);
  });

  it('omits source for caller inventory without flow', () => {
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 0,
        hasFilteredImports: false,
        callerBulletCount: 3,
        memberFileCount: 0,
        apiUsageFileCount: 0,
        configRendered: false,
        kitModuleSurveyRendered: false,
        inheritanceListed: false,
        domainFileCount: 0,
        dataSourceEdgeCount: 0,
      }, false, false),
    ).toBe(true);
  });

  it('omits source for kit module usage survey', () => {
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 0,
        hasFilteredImports: false,
        callerBulletCount: 0,
        memberFileCount: 0,
        apiUsageFileCount: 0,
        configRendered: false,
        kitModuleSurveyRendered: true,
        inheritanceListed: false,
        domainFileCount: 0,
        dataSourceEdgeCount: 0,
      }, false, false),
    ).toBe(true);
  });

  it('omits source for member survey inventory without flow', () => {
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 0,
        hasFilteredImports: false,
        callerBulletCount: 0,
        memberFileCount: 3,
        configRendered: false,
        kitModuleSurveyRendered: false,
        inheritanceListed: false,
        domainFileCount: 0,
        apiUsageFileCount: 0,
      }, false, false),
    ).toBe(true);
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 0,
        hasFilteredImports: false,
        callerBulletCount: 0,
        memberFileCount: 3,
        configRendered: false,
        kitModuleSurveyRendered: false,
        inheritanceListed: false,
        domainFileCount: 0,
        apiUsageFileCount: 0,
      }, false, true),
    ).toBe(false);
  });
});

describe('queryShouldDeferToBuiltinTools', () => {
  it('defers shape-only: SDK catalogs, topic file-lists, concept compares', () => {
    expect(queryShouldDeferToBuiltinTools('@kit.SomeKit的foo模块有哪些功能')).toBe('sdk-catalog');
    expect(queryShouldDeferToBuiltinTools('与缓存策略相关的文件有哪些')).toBe('file-listing');
    expect(
      queryShouldDeferToBuiltinTools('项目中有使用共享缓存吗？它与普通缓存有什么不同？'),
    ).toBe('concept-or-existence');
    expect(
      queryShouldDeferToBuiltinTools("检索所有 .width('100%') 和 .height('100%') 同时出现的组件"),
    ).toBeNull();
  });

  it('does not defer structural / in-repo usage questions', () => {
    expect(queryShouldDeferToBuiltinTools('项目中是如何实现xml解析功能的')).toBeNull();
    expect(queryShouldDeferToBuiltinTools('哪些代码依赖@kit.ArkTS的taskpool')).toBeNull();
    expect(
      queryShouldDeferToBuiltinTools(
        'OpenFolderDragHandler.test.ets里getSummary() 返回 Summary，这个对象起什么作用？',
      ),
    ).toBeNull();
    expect(queryShouldDeferToBuiltinTools('DrawerUninstallButton onClick')).toBeNull();
    expect(
      queryShouldDeferToBuiltinTools(
        'WallpaperApplyPage WallpaperApplyDialog preview image load',
      ),
    ).toBeNull();
  });

  it('defers pure outcome questions without hover/Type anchors', () => {
    expect(queryShouldDeferToBuiltinTools('用户拖拽时会发生什么')).toBe('concept-or-existence');
  });

  it('inventories hover handlers instead of soft-skipping', () => {
    expect(queryShouldDeferToBuiltinTools('鼠标悬停在应用图标背景上会有什么反应')).toBeNull();
    expect(shouldBuildHoverHandlerSurvey('鼠标悬停在应用图标背景上会有什么反应')).toBe(true);
    expect(
      shouldBuildHoverHandlerSurvey('鼠标悬停应用图标背景 hover application icon background'),
    ).toBe(true);
    expect(shouldTryFastInventoryExplore('鼠标悬停在应用图标背景上会有什么反应')).toBe(true);
  });

  it('routes named UI hover/click to compact, not light-mechanism or defer', () => {
    expect(queryShouldDeferToBuiltinTools('AppIconCommonView hover background')).toBeNull();
    expect(queryAsNamedComponentAction('AppIconCommonView hover background')).toBe(true);
    expect(shouldTryLightMechanismExplore('AppIconCommonView hover background')).toBe(false);
    expect(queryAsLocalSymbolDetail('AppIconCommonView hover background')).toBe(true);
    expect(shouldTryLightMechanismExplore('点击DrawerUninstallButton按钮后会发生什么事情')).toBe(
      false,
    );
    expect(queryAsLocalSymbolDetail('点击DrawerUninstallButton按钮后会发生什么事情')).toBe(true);
  });

  it('routes cross-cutting usage / declaration / constant / field / module shapes to inventory', () => {
    expect(
      shouldBuildApiUsageSurvey('哪些组件使用了 .drawModifier 或 DrawContext 进行自定义绘制？'),
    ).toBe(true);
    expect(
      shouldTryFastInventoryExplore('哪些组件使用了 .drawModifier 或 DrawContext 进行自定义绘制？'),
    ).toBe(true);
    expect(
      queryAsDeclarationSiteSurvey(
        'XComponent 在哪些文件中被声明，id 分别是什么，各自绑定到哪个 C++ 渲染器？',
      ),
    ).toBe(true);
    expect(
      shouldTryFastInventoryExplore(
        'XComponent 在哪些文件中被声明，id 分别是什么，各自绑定到哪个 C++ 渲染器？',
      ),
    ).toBe(true);
    expect(
      queryAsConstantUsageSurvey(
        'FORM_MANAGER_PANEL_SCALE_90 = 0.90 和 FORM_MANAGER_PANEL_SCALE_95 = 0.95 这两个缩放常量分别用于什么场景？',
      ),
    ).toBe(true);
    expect(
      shouldTryFastInventoryExplore(
        'FORM_MANAGER_PANEL_SCALE_90 = 0.90 和 FORM_MANAGER_PANEL_SCALE_95 = 0.95 这两个缩放常量分别用于什么场景？',
      ),
    ).toBe(true);
    expect(
      queryAsFieldUsageSurvey(
        'drawOnSubThread 里用了 m_eglMutex，还有哪些函数也会用到这个锁？',
      ),
    ).toBe(true);
    expect(extractFieldLikeSymbolsFromQuery('… m_eglMutex …')).toContain('m_eglMutex');
    expect(
      queryAsFieldUsageSurvey(
        'PluginRender 里的 m_eglCore 指针，在哪些地方被 new 出来？又在哪些地方被 delete 掉？',
      ),
    ).toBe(true);
    expect(
      shouldTryFastInventoryExplore(
        'PluginRender 里的 m_eglCore 指针，在哪些地方被 new 出来？又在哪些地方被 delete 掉？',
      ),
    ).toBe(true);
    expect(
      extractLocalDetailAnchors(
        'PluginRender 里的 m_eglCore 指针，在哪些地方被 new 出来？又在哪些地方被 delete 掉？',
      ),
    ).not.toContain('new');
    expect(
      queryAsDtsWrapSurvey(
        'harmonyShare.d.ts 这个文件看起来对 systemShare 做了封装。在项目中什么功能、在什么地方调用了它？',
      ),
    ).toBe(true);
    expect(
      shouldTryFastInventoryExplore(
        'harmonyShare.d.ts 这个文件看起来对 systemShare 做了封装。在项目中什么功能、在什么地方调用了它？',
      ),
    ).toBe(true);
    expect(
      queryAsAssignedFlagImpactSurvey(
        'OnSurfaceChangedCB sets isChangeSurface = true. How does this flag affect later render timing?',
      ),
    ).toBe(true);
    expect(
      queryAsLocalSymbolDetail(
        'OnSurfaceChangedCB sets isChangeSurface = true. How does this flag affect later render timing?',
      ),
    ).toBe(true);
    expect(
      queryAsNamedControlStateSyncSurvey(
        'HotspotToggle state is consistent across control center, settings, and status bar — which module guarantees it?',
      ),
    ).toBe(true);
    expect(
      queryAsModuleExportSurvey('feature/foldeffect module NAPI expose which APIs'),
    ).toBe(true);
    expect(
      shouldBuildDomainFileSurvey('feature/foldeffect module NAPI expose which APIs'),
    ).toBe(false);
    expect(
      queryAsModuleDependencySurvey(
        'staticcommon/launchercommon、screenlockcommon、systemuicommon、controlcentercommon 这四个模块之间是否存在相互依赖？',
      ),
    ).toBe(true);
    expect(
      shouldTryFastInventoryExplore(
        'staticcommon/launchercommon、screenlockcommon、systemuicommon、controlcentercommon 这四个模块之间是否存在相互依赖？',
      ),
    ).toBe(true);
  });

  it('keeps Type lifecycle / Release-destructor compares on compact bodies', () => {
    expect(
      queryAsTypeLifecycleSurvey(
        'SceneSession 的状态机有哪些状态，foreground、background 转换时会调哪些回调？',
      ),
    ).toBe(true);
    expect(
      queryAsLocalSymbolDetail(
        'SceneSession 的状态机有哪些状态，foreground、background 转换时会调哪些回调？',
      ),
    ).toBe(true);
    expect(
      shouldTryFastInventoryExplore(
        'SceneSession 的状态机有哪些状态，foreground、background 转换时会调哪些回调？',
      ),
    ).toBe(false);
    expect(
      queryAsLocalSymbolDetail(
        'OnSurfaceDestroyedCB 里调了 PluginManager::GetRender()->Release()。这个 Release 函数做了哪些事情？跟 PluginRender 的析构函数里做的事有没有重复？',
      ),
    ).toBe(true);
  });

  it('defers literal copy hunts without code anchors', () => {
    expect(
      queryShouldDeferToBuiltinTools('全搜一下哪些布局里绑了中文 text 常量，点击会打开编辑页是什么逻辑'),
    ).toBe('concept-or-existence');
  });

  it('routes step/download-parse flows to mechanism, not domain file inventory', () => {
    const q = '用户下载一个完整主题包后，解析和安装的步骤中会走到哪些代码？';
    expect(queryAsMechanismSurvey(q)).toBe(true);
    expect(shouldTryLightMechanismExplore(q)).toBe(true);
    expect(shouldTryFastInventoryExplore(q)).toBe(false);
    expect(queryAsDomainFileSurvey(q)).toBe(false);
  });

  it('treats Page/Component overview as local surface (not inheritance inventory)', () => {
    expect(queryAsComponentSurfaceSurvey('ThemeHome使用了哪些UI组件，可以跳转到哪些页面')).toBe(true);
    expect(queryAsComponentSurfaceSurvey('ThemeHome')).toBe(true);
    expect(queryAsLocalSymbolDetail('ThemeHome')).toBe(true);
    expect(shouldTryFastInventoryExplore('ThemeHome')).toBe(false);
    expect(shouldBuildInheritanceSurvey('ThemeHome')).toBe(false);
    expect(shouldBuildInheritanceSurvey('Rectangle')).toBe(true);
  });

  it('routes 2–3 UI Type clusters to compact (drops @CustomDialog noise)', () => {
    const nl =
      'WallpaperApplyPage 内嵌了 @CustomDialog 的 WallpaperApplyDialog，dialog 内的壁纸预览图片加载使用的是 $r 系统资源还是网络下载？';
    const bag = 'WallpaperApplyPage WallpaperApplyDialog @CustomDialog wallpaper preview image';
    for (const q of [nl, bag]) {
      expect(queryAsFocusedUiCluster(q)).toBe(true);
      expect(queryAsComponentSurfaceSurvey(q)).toBe(true);
      expect(queryAsLocalSymbolDetail(q)).toBe(true);
      expect(shouldUseCompactExploreBudget(q)).toBe(true);
      expect(shouldTryFastInventoryExplore(q)).toBe(false);
      expect(shouldTryLightMechanismExplore(q)).toBe(false);
      const anchors = extractLocalDetailAnchors(q);
      expect(anchors).toContain('WallpaperApplyPage');
      expect(anchors).toContain('WallpaperApplyDialog');
      expect(anchors).not.toContain('CustomDialog');
      expect(anchors).not.toContain('dialog');
    }
    expect(queryLooksLikeUiComponentType('CustomDialog')).toBe(false);
    expect(queryLooksLikeUiComponentType('WallpaperApplyDialog')).toBe(true);
    // Cross-module flow bags stay out of the cluster compact path.
    expect(
      queryAsFocusedUiCluster(
        '壁纸设置从 WallpaperApplyPage 到 ScreenLockWallpaperManager 落盘再到引擎渲染经过哪些调用',
      ),
    ).toBe(false);
  });

  it('keeps multi-Type Page/Dialog questions focused (drops generic dialog noun)', () => {
    const q =
      'WallpaperApplyPage 内嵌了 @CustomDialog 的 WallpaperApplyDialog，dialog 内的壁纸预览图片加载使用的是 $r 系统资源还是网络下载？';
    expect(extractLocalDetailAnchors(q)).not.toContain('dialog');
    expect(queryHasFocusedNamedAnchors(q)).toBe(true);
    expect(queryShouldDeferToBuiltinTools(q)).toBeNull();
  });

  it('emits skip guidance that tells the agent not to retry', () => {
    const text = homegraphDeferGuidance('file-listing', '与缓存策略相关的文件有哪些');
    expect(text).toMatch(/Skip HomeGraph/);
    expect(text).toMatch(/do \*\*not\*\* retry/);
    expect(text).toMatch(/Grep/);
  });
});

describe('mechanism domain anchors', () => {
  it('keeps ascii tokens like xml for how-implemented questions', () => {
    const terms = extractDomainSearchTerms('项目中是如何实现xml解析功能的');
    expect(terms.map((t) => t.toLowerCase())).toContain('xml');
    expect(shouldTryLightMechanismExplore('项目中是如何实现xml解析功能的')).toBe(true);
  });

  it('treats rewritten domain+verb bags as light-mechanism, not compact verb-seeds', () => {
    expect(queryAsDomainMechanismBag('xml parse 解析 xml文件解析')).toBe(true);
    expect(shouldTryLightMechanismExplore('xml parse 解析 xml文件解析')).toBe(true);
    expect(extractLocalDetailAnchors('xml parse 解析')).not.toContain('parse');
    // Distinctive token `xml` may remain as an anchor; compact still yields to light-mechanism.
    expect(shouldTryLightMechanismExplore('xml parse 解析')).toBe(true);
    expect(extractDependencySymbolsFromQuery('xml parse 解析 XML parsing')).toContain('xml');
    expect(extractDependencySymbolsFromQuery('xml parse 解析 XML parsing')).not.toContain('parse');
    expect(extractDependencySymbolsFromQuery('xml parse 解析 XML parsing')).not.toContain('parsing');
    // Named Type takes compact / inventory — not the domain bag.
    expect(queryAsDomainMechanismBag('ThemeHome UI components')).toBe(false);
  });
});

describe('kit module capability survey', () => {
  it('detects @kit module feature questions', () => {
    expect(queryAsKitModuleCapabilitySurvey('@kit.ArkTS的util模块有哪些功能')).toBe(true);
    expect(queryAsOutOfRepoSdkCatalog('@kit.ArkTS的util模块有哪些功能')).toBe(true);
    // Capability catalogs must NOT build an in-repo usage survey.
    expect(shouldBuildKitModuleUsageSurvey('@kit.ArkTS的util模块有哪些功能')).toBe(false);
    expect(shouldBuildKitModuleUsageSurvey('@kit.ArkTS util module features')).toBe(false);
  });

  it('builds usage survey for in-repo dependency questions', () => {
    expect(shouldBuildKitModuleUsageSurvey('哪些代码依赖@kit.ArkTS的taskpool')).toBe(true);
    expect(queryAsOutOfRepoSdkCatalog('哪些代码依赖@kit.ArkTS的taskpool')).toBe(false);
    // `@kit.X` must not look like Type.member and block inventory.
    expect(queryHasNamedMemberFocus('哪些代码依赖@kit.ArkTS的taskpool')).toBe(false);
    expect(shouldTryFastInventoryExplore('哪些代码依赖@kit.ArkTS的taskpool')).toBe(true);
    expect(
      extractMemberAccessFromQuery('哪些代码依赖@kit.ArkTS的taskpool').map((m) => m.dotted),
    ).not.toContain('kit.ArkTS');
  });

  it('extracts named export focus from @kit.X的foo', () => {
    expect(extractKitSubmoduleNamesFromQuery('哪些代码依赖@kit.ArkTS的taskpool这个api端点')).toContain(
      'taskpool',
    );
    expect(extractKitSubmoduleNamesFromQuery('@kit.ArkTS的util模块有哪些功能')).toEqual(
      expect.arrayContaining(['util']),
    );
  });

  it('extracts kit submodules', () => {
    expect(extractKitSubmoduleNamesFromQuery('@kit.ArkTS的util模块有哪些功能')).toEqual(
      expect.arrayContaining(['util']),
    );
  });
});

describe('named member / component focus (not import inventory)', () => {
  it('detects Type.member and Type + isFoo co-naming', () => {
    expect(queryHasNamedMemberFocus('LauncherCardInfo.isExpired UI mark')).toBe(true);
    expect(queryHasNamedMemberFocus('LauncherCardInfo isExpired expired UI mark')).toBe(true);
    expect(isMemberLikeIdentifier('isExpired')).toBe(true);
    expect(isMemberLikeIdentifier('onClick')).toBe(true);
    expect(queryAsLocalSymbolDetail('LauncherCardInfo isExpired expired UI mark')).toBe(true);
    // Must NOT take the import-inventory fast path
    expect(shouldTryFastInventoryExplore('LauncherCardInfo isExpired expired UI mark')).toBe(false);
  });

  it('detects named UI control + event (click flow)', () => {
    expect(queryAsNamedComponentAction('DrawerUninstallButton onClick uninstall button')).toBe(true);
    expect(queryAsLocalSymbolDetail('DrawerUninstallButton onClick uninstall button')).toBe(true);
    expect(shouldTryFastInventoryExplore('DrawerUninstallButton onClick uninstall button')).toBe(false);
  });

  it('prefers explore over search when names are already present', () => {
    expect(queryShouldPreferExploreOverSearch('ThemeHome使用了哪些UI组件')).toBe(true);
    expect(queryShouldPreferExploreOverSearch('BadgeManager')).toBe(true);
    expect(queryShouldPreferExploreOverSearch('what is a mutex')).toBe(false);
  });
});

describe('shouldBuildCallerInventory', () => {
  it('builds when caller/method survey intent and a type name', () => {
    expect(shouldBuildCallerInventory('external callers of BadgeManager')).toBe(true);
    expect(shouldBuildCallerInventory('项目中哪里调用了SortWidgets')).toBe(true);
    expect(shouldBuildCallerInventory('Configuration class methods callers')).toBe(true);
    // Bare type without caller intent must NOT force empty inventory (blocks compact).
    expect(shouldBuildCallerInventory('Configuration')).toBe(false);
    expect(shouldBuildCallerInventory('ThemeHome使用了哪些UI组件')).toBe(false);
  });
});

describe('shouldBuildInheritanceSurvey', () => {
  it('builds for subclass questions', () => {
    expect(shouldBuildInheritanceSurvey('项目中有哪些类是Rectangle的子类')).toBe(true);
    // `subclasses?` would fail these — must be subclass(?:es)?
    expect(shouldBuildInheritanceSurvey('class extends Rectangle subclass')).toBe(true);
    expect(shouldBuildInheritanceSurvey('Rectangle subclass')).toBe(true);
    expect(shouldBuildInheritanceSurvey('which classes extend Rectangle')).toBe(true);
    // Bare type — agents search("Rectangle") for hierarchy; inventory must win.
    expect(shouldBuildInheritanceSurvey('Rectangle')).toBe(true);
    expect(shouldBuildInheritanceSurvey('IntGrid')).toBe(true);
    expect(shouldBuildInheritanceSurvey('how does Rectangle render')).toBe(false);
    // Explicit subclass wording (empty-graph ANSWER NOW only for these).
    expect(queryAsInheritanceSurvey('IntGrid')).toBe(false);
    expect(queryAsInheritanceSurvey('Rectangle subclasses extends inheritance')).toBe(true);
  });
});

describe('shouldLimitToQueryNamedFile', () => {
  it('limits when one file anchor and no flow', () => {
    expect(shouldLimitToQueryNamedFile('ThemeHome.ets components', false, false)).toBe(true);
    expect(shouldLimitToQueryNamedFile('A to B flow Foo Bar', true, false)).toBe(false);
  });
});

describe('shouldBuildMemberSurvey', () => {
  it('builds only when member-access syntax is present', () => {
    expect(shouldBuildMemberSurvey('files using .drawModifier')).toBe(true);
    expect(shouldBuildMemberSurvey('list all UI components')).toBe(false);
  });
});

describe('shouldBuildConfigSection', () => {
  it('builds when query names a config file by extension', () => {
    expect(shouldBuildConfigSection('read app.json5 dependencies')).toBe(true);
    expect(shouldBuildConfigSection('how routing works')    ).toBe(false);
  });
});

describe('domain file survey', () => {
  it('detects broad file/usage/comparison questions', () => {
    expect(queryAsDomainFileSurvey('与用户首选项相关的文件有哪些')).toBe(true);
    expect(queryAsDomainFileSurvey('项目中有使用共享用户首选项吗')).toBe(true);
    expect(queryAsDomainFileSurvey('共享用户首选项与用户首选项有什么不同')).toBe(true);
    expect(queryAsDomainFileSurvey('项目中是如何实现备份与恢复的')).toBe(false);
    expect(queryAsDomainFileSurvey('哪些代码依赖@kit.ArkTS的taskpool')).toBe(false);
  });

  it('extracts domain search terms from Chinese queries', () => {
    const terms = extractDomainSearchTerms('与用户首选项相关的文件有哪些');
    expect(terms).toContain('用户首选项');
  });

  it('should build when domain terms exist', () => {
    expect(shouldBuildDomainFileSurvey('与用户首选项相关的文件有哪些')).toBe(true);
    expect(shouldBuildDomainFileSurvey('how is the weather')).toBe(false);
  });

  it('omits source for domain file inventory', () => {
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 0,
        hasFilteredImports: false,
        callerBulletCount: 0,
        memberFileCount: 0,
        apiUsageFileCount: 0,
        configRendered: false,
        kitModuleSurveyRendered: false,
        inheritanceListed: false,
        domainFileCount: 5,
        dataSourceEdgeCount: 0,
      }, false, false),
    ).toBe(true);
  });

  it('keeps Chinese domain terms without hardcoded English synonyms', () => {
    const terms = extractDomainSearchTerms('与用户首选项相关的文件有哪些');
    expect(terms).toContain('用户首选项');
    expect(terms).not.toContain('preference');
  });
});

describe('API usage survey', () => {
  it('detects where-is-API-used questions', () => {
    expect(queryAsApiUsageSurvey('哪里使用了statfs这个API端点')).toBe(true);
    expect(queryAsApiUsageSurvey('与用户首选项相关的文件有哪些')).toBe(false);
  });

  it('builds when API symbol is named', () => {
    expect(shouldBuildApiUsageSurvey('哪里使用了statfs这个API端点')).toBe(true);
  });

  it('excludes API usage from domain file survey', () => {
    expect(queryAsDomainFileSurvey('哪里使用了statfs这个API端点')).toBe(false);
  });

  it('omits source for API usage inventory', () => {
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 0,
        hasFilteredImports: false,
        callerBulletCount: 0,
        memberFileCount: 0,
        apiUsageFileCount: 3,
        configRendered: false,
        kitModuleSurveyRendered: false,
        inheritanceListed: false,
        domainFileCount: 0,
        dataSourceEdgeCount: 0,
      }, false, false),
    ).toBe(true);
  });
});

describe('named type focus', () => {
  it('focuses on single Handler type with callback intent', () => {
    expect(
      shouldFocusOnNamedTypeFile('CallStateChangeHandler中callStateChange回调做了什么', false, false),
    ).toBe(true);
    expect(shouldFocusOnNamedTypeFile('如何获取系统语言', false, false)).toBe(false);
  });
});

describe('mechanism survey', () => {
  it('detects implementation/how questions', () => {
    expect(queryAsMechanismSurvey('项目中是如何实现备份与恢复的')).toBe(true);
    expect(queryAsMechanismSurvey('如何获取系统语言')).toBe(true);
    expect(queryAsMechanismSurvey('与用户首选项相关的文件有哪些')).toBe(false);
  });

  it('matches implementation entry symbol names', () => {
    expect(isImplementationEntrySymbol('BackupManager', ['备份'])).toBe(true);
    expect(isImplementationEntrySymbol('ThemeHome', ['备份'])).toBe(false);
  });
});

describe('P0 explore shapes', () => {
  it('extracts test file basenames', () => {
    expect(extractFileBasenamesFromQuery('OpenFolderDragHandler.test.ets里getSummary')).toEqual([
      'OpenFolderDragHandler',
    ]);
  });

  it('detects interpretation and cross-module flow queries', () => {
    expect(queryAsInterpretationSurvey('OpenFolderDragHandler.test.ets里getSummary起什么作用')).toBe(true);
    expect(
      queryAsCrossModuleFlowSurvey('壁纸设置从 WallpaperApplyPage 到 ScreenLockWallpaperManager 落盘再到引擎渲染经过哪些调用'),
    ).toBe(true);
  });

  it('detects data-source and caller surveys', () => {
    expect(queryAsDataSourceSurvey('BadgeManager角标数据来源于哪个系统服务')).toBe(true);
    expect(extractCallerSurveySymbols('项目中哪里调用了SortWidgets')).toContain('SortWidgets');
    expect(shouldBuildCallerInventory('项目中哪里调用了SortWidgets')).toBe(true);
  });

  it('fast inventory for surveys not cross-module flows', () => {
    expect(shouldTryFastInventoryExplore('与用户首选项相关的文件有哪些')).toBe(true);
    expect(shouldTryFastInventoryExplore('项目中哪里调用了SortWidgets')).toBe(true);
    expect(shouldTryFastInventoryExplore('BadgeManager角标数据来源于哪个系统服务')).toBe(true);
    expect(
      shouldTryFastInventoryExplore('壁纸从 WallpaperApplyPage 到 ScreenLockWallpaperManager 落盘'),
    ).toBe(false);
  });

  it('caller + co-named definition-visibility takes compact, not inventory-only', () => {
    const q =
      '项目中哪里调用了SortWidgets，其中哪些调用是用来确保IntGrid 的定义可见的？';
    expect(queryNeedsCoNamedUseBridge(q)).toBe(true);
    expect(queryAsLocalSymbolDetail(q)).toBe(true);
    expect(shouldTryFastInventoryExplore(q)).toBe(false);
    expect(shouldTryLightMechanismExplore(q)).toBe(false);
    expect(queryHasFocusedNamedAnchors(q)).toBe(true);
    // Plain caller survey without co-named visibility still uses inventory.
    expect(queryNeedsCoNamedUseBridge('项目中哪里调用了SortWidgets')).toBe(false);
    expect(shouldTryFastInventoryExplore('项目中哪里调用了SortWidgets')).toBe(true);
  });

  it('routes kit extra-deps / Type×method interaction / constants away from light dumps', () => {
    const kit =
      '调用 ServiceCollaborationKit 需要额外安装哪些依赖？项目里怎么引用的？';
    expect(shouldBuildKitModuleUsageSurvey(kit)).toBe(true);
    expect(shouldTryLightMechanismExplore(kit)).toBe(false);
    expect(shouldTryFastInventoryExplore(kit)).toBe(true);

    const place = 'CanPlace、Place 是怎么和 BinaryGrid 交互的？';
    expect(queryHasNamedMemberFocus(place)).toBe(true);
    expect(queryAsLocalSymbolDetail(place)).toBe(true);
    expect(shouldTryLightMechanismExplore(place)).toBe(false);

    const enPlace = 'How do CanPlace and Place interact with BinaryGrid?';
    expect(queryHasNamedMemberFocus(enPlace)).toBe(true);
    expect(shouldTryLightMechanismExplore(enPlace)).toBe(false);

    const constant =
      'audio.AudioVolumeType.RINGTONE 在项目中哪些函数或方法中被依赖或调用？';
    expect(queryShouldPreferExploreOverSearch(constant)).toBe(true);

    const grid = 'BinaryGrid 的 Set、Test 或 Fill 在哪些文件里被调用？';
    expect(queryAsCallerOrMethodSurvey(grid)).toBe(true);
    expect(queryHasNamedMemberFocus(grid)).toBe(false);
    expect(shouldTryFastInventoryExplore(grid)).toBe(true);
    expect(shouldTryLightMechanismExplore(grid)).toBe(false);
  });

  it('upstream/downstream local-detail uses compact', () => {
    expect(
      queryAsLocalSymbolDetail('OnSurfaceChangedCB函数的上下游是什么？实现了什么功能？'),
    ).toBe(true);
    expect(
      shouldTryFastInventoryExplore('OnSurfaceChangedCB函数的上下游是什么？实现了什么功能？'),
    ).toBe(false);
  });

  it('PascalCase SDK module usage is API inventory, not empty callers', () => {
    const q = 'Telephony在项目中使用了哪些调用方法，在文档中为什么没有说明？';
    expect(extractApiUsageTokens(q)).toContain('Telephony');
    expect(shouldBuildApiUsageSurvey(q)).toBe(true);
    expect(shouldBuildCallerInventory(q)).toBe(false);
    expect(shouldTryFastInventoryExplore(q)).toBe(true);
    // Agent English rewrite must keep the API inventory path (not compact on "usages").
    const en = 'Telephony API usages and call methods in the project';
    expect(queryAsApiUsageSurvey(en)).toBe(true);
    expect(shouldBuildApiUsageSurvey(en)).toBe(true);
    expect(extractLocalDetailAnchors(en)).toContain('Telephony');
    expect(extractLocalDetailAnchors(en)).not.toContain('usages');
    expect(queryAsLocalSymbolDetail(en)).toBe(false);
    expect(shouldTryFastInventoryExplore(en)).toBe(true);
    // Bag noise must not dilute Telephony into call/radio false positives.
    expect(extractApiUsageTokens('Telephony 调用方法 usage calls radio call sim')).toEqual([
      'Telephony',
    ]);
  });

  it('routes system-capability howto and declaration / return-consumer shapes', () => {
    expect(queryAsInRepoSystemCapabilityHowto('如何获取系统当前设置的语言')).toBe(true);
    expect(shouldTryLightMechanismExplore('如何获取系统当前设置的语言')).toBe(false);
    expect(shouldTryFastInventoryExplore('获取系统当前设置语言 language locale i18n')).toBe(true);

    expect(
      queryAsDeclarationSiteSurvey(
        'XComponent 在哪些文件中被声明，id 分别是什么，各自绑定到哪个 C++ 渲染器？',
      ),
    ).toBe(true);
    expect(
      queryAsDeclarationSiteSurvey('XComponent declaration id native render C++ renderer binding'),
    ).toBe(true);
    expect(shouldTryFastInventoryExplore('XComponent declaration id native render binding')).toBe(
      true,
    );

    const ret =
      'remoteDevice.createRemoteDevice getConnectionState 返回结果被项目中哪些其他函数使用';
    expect(queryAsReturnValueConsumerSurvey(ret)).toBe(true);
    expect(shouldBuildCallerInventory(ret)).toBe(true);
    expect(extractCallerSurveySymbols(ret)).toEqual(
      expect.arrayContaining(['getConnectionState']),
    );

    expect(
      queryAsModuleExportSurvey('LayoutRotatePacking C++ class NAPI expose to ArkTS'),
    ).toBe(true);

    expect(
      queryAsModuleDependencySurvey(
        'commonconstants 被多层引用，是否存在循环依赖？构建系统如何检测？',
      ),
    ).toBe(true);
    expect(
      queryAsConstantUsageSurvey(
        'audio.AudioVolumeType.RINGTONE 在项目中哪些函数或方法中被依赖或调用？',
      ),
    ).toBe(true);
    expect(shouldBuildApiUsageSurvey('XComponent declaration id binding')).toBe(false);
    expect(extractMemberAccessFromQuery('PluginManager::Export 失败时还会注册吗')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ receiver: 'PluginManager', member: 'Export' }),
      ]),
    );
  });

  it('detects test-only interpretation and mechanism entry seeds', () => {
    expect(
      queryAsTestOnlyInterpretation('OpenFolderDragHandler.test.ets里getSummary起什么作用'),
    ).toBe(true);
    expect(queryAsTestOnlyInterpretation('LocationController.ets中on方法做什么')).toBe(false);
    expect(extractMechanismEntrySeeds('NotificationManager如何订阅通知')).toContain(
      'NotificationManager',
    );
    expect(extractMechanismEntrySeeds('如何实现XML解析功能')).not.toContain('convertxml');
    expect(extractMechanismEntrySeeds('备份与恢复是如何实现的')).not.toContain('BackupManager');
    expect(shouldTryLightMechanismExplore('项目中是如何实现xml解析功能的')).toBe(true);
    expect(shouldTryLightMechanismExplore('与用户首选项相关的文件有哪些')).toBe(false);
  });

  it('detects local-symbol detail vs mechanism (token-budget routing)', () => {
    expect(
      queryAsLocalSymbolDetail(
        'EGLCore::EglContextInit 在 width 和 height 为 0 时直接返回 false，这会导致后续的 Draw 怎样',
      ),
    ).toBe(true);
    expect(queryAsLocalSymbolDetail('ARGS_POS_0 到 ARGS_POS_4 宏定义在 NAPI 参数位置里做什么')).toBe(true);
    expect(
      queryAsLocalSymbolDetail(
        'pointer.setPointerStyle是一个异步接口，返回 Promise，同步用 try-catch能否捕获错误',
      ),
    ).toBe(true);
    expect(queryAsLocalSymbolDetail('项目中是如何实现备份与恢复的')).toBe(false);
    expect(queryAsLocalSymbolDetail('与用户首选项相关的文件有哪些')).toBe(false);
    expect(
      shouldUseCompactExploreBudget('OnSurfaceChangedCB方法的入参是什么，实现的是什么功能'),
    ).toBe(true);
    expect(shouldFocusOnQueryNamedDefs('DrawerUninstallButton点击会发生什么', false, false)).toBe(
      true,
    );
    expect(queryAsLocalSymbolDetail('DrawerUninstallButton点击会发生什么')).toBe(true);
  });

  it('omits source for data-source inventory', () => {
    expect(
      shouldOmitSourceBodies({
        importSiteCount: 0,
        hasFilteredImports: false,
        callerBulletCount: 0,
        memberFileCount: 0,
        apiUsageFileCount: 0,
        configRendered: false,
        kitModuleSurveyRendered: false,
        inheritanceListed: false,
        domainFileCount: 0,
        dataSourceEdgeCount: 2,
      }, false, false),
    ).toBe(true);
  });
});

describe('fileMatchesQueryBasename', () => {
  it('matches exact basename for any source extension', () => {
    expect(
      fileMatchesQueryBasename(
        'feature/foo/LocationController.ets',
        ['LocationController'],
      ),
    ).toBe(true);
    expect(
      fileMatchesQueryBasename(
        'src/auth/UserService.ts',
        ['UserService'],
      ),
    ).toBe(true);
    expect(
      fileMatchesQueryBasename(
        'product/pcbase/control.ets',
        ['LocationController'],
      ),
    ).toBe(false);
  });
});
