/**
 * Shape-level explore routing corpus.
 *
 * These are *categories* of agent queries (ZH + EN rewrites), not eval-set IDs.
 * Every case pins the exclusive route so fixing one shape cannot silently
 * regress another (the failure mode of one-off probe scripts).
 */

export type ExploreRoute =
  | 'defer'
  | 'light'
  | 'inventory'
  | 'local'
  | 'other';

export interface ExploreRouteCase {
  /** Stable id for failure messages — not an eval question id. */
  id: string;
  /** Human-readable shape label. */
  shape: string;
  query: string;
  expect: ExploreRoute;
  /** Optional classifier pins (defense in depth). */
  pins?: {
    preferExplore?: boolean;
    kitInstall?: boolean;
    dataSource?: boolean;
    lifecycle?: boolean;
    memberFocus?: boolean;
    literalHunt?: boolean;
  };
  /** Soft upper bound when LIVE_PROBE is on (chars). */
  maxChars?: number;
  /** Live: output must match each of these (string or RegExp source). */
  mustContain?: Array<string | RegExp>;
  /** Live: output must not match. */
  mustNotMatch?: Array<string | RegExp>;
}

/** Pure-routing cases — always run in CI. */
export const ROUTING_CORPUS: ExploreRouteCase[] = [
  // --- defer / skip ---
  {
    id: 'literal-text-import',
    shape: 'repo-wide literal / imported text object hunt',
    query: '全仓中有哪些从图形包中导入的 text 对象，导入它编辑文字有什么优势',
    expect: 'defer',
    pins: { literalHunt: true, preferExplore: false },
  },
  {
    id: 'literal-copy-hunt',
    shape: 'literal string / copy hunt',
    query: '全搜字面量绑了哪些中文 text 字符串',
    expect: 'defer',
    pins: { literalHunt: true },
  },
  {
    id: 'concept-existence',
    shape: 'concept / existence without anchors',
    query: '此工程中是否存在完整的未成年人保护的模式业务？',
    expect: 'defer',
    pins: { preferExplore: false },
  },
  {
    id: 'vcs-history',
    shape: 'git / commit history',
    query: '看一下最近一次提交改了什么',
    expect: 'defer',
  },
  {
    id: 'media-assets',
    shape: 'media / binary asset inventory',
    query: '列出工程里所有 png 图片资源',
    expect: 'defer',
  },

  // --- light mechanism ---
  {
    id: 'mech-xml-parse',
    shape: 'domain how-implemented (xml) — lean convertxml, not Xml* flood',
    query: '项目中是如何实现xml解析功能的',
    expect: 'light',
    // Session tok↑ when explore is ~5k+ and agent still Greps; keep payload lean.
    maxChars: 7_000,
    mustContain: [/convertxml/i, /Partial locator|ANSWER NOW|Coarse locate/i, /Locator partial|Mechanism explore complete|Source Code|Coarse locate/i],
  },
  {
    id: 'mech-xml-parse-en-implementation',
    shape: 'agent EN rewrite (XML parsing implementation) — convertxml soft-close',
    query: 'XML parsing implementation',
    expect: 'light',
    maxChars: 8_000,
    mustContain: [/convertxml|ConvertXML/i, /Coarse locate|ANSWER NOW|Mechanism explore complete/i],
    mustNotMatch: [/^\s*>\s*\*\*Partial locator\*\*/m],
  },
  {
    id: 'mech-pipeline-activate',
    shape: 'domain pipeline (parse/install/activate) — not Delete* Primary',
    query: '主题包下载完成后解析和安装主题包流程 download theme package parse install',
    expect: 'light',
    maxChars: 9_000,
    mustContain: [/ThemeActivate|ThemePack|Installer|Coarse locate|Partial locator|ANSWER/i],
    mustNotMatch: [/Primary Type: `Delete/i],
  },
  {
    id: 'mech-notification',
    shape: 'domain how-implemented (notification)',
    query: '项目中是如何实现通知订阅管理的，涉及的多线程或多进程是怎样的？',
    expect: 'light',
    maxChars: 9_000,
    mustContain: [/Partial locator|ANSWER NOW|Coarse locate/i, /NotificationManager|NotificationSubscribe|Source Code|Locator partial|Coarse locate/i],
  },
  {
    id: 'mech-theme-install-steps',
    shape: 'download→parse→install call-chain',
    query: '用户下载一个完整主题包后，解析和安装的步骤中会走到哪些代码？',
    expect: 'light',
    maxChars: 8_000,
    mustContain: [/ThemePack|ThemePackage|SkinInstaller/i, /Partial locator|ANSWER NOW|Coarse locate/i],
  },
  {
    id: 'mech-native-gl-thread',
    shape: 'lib*.so + GLES/EGL thread',
    query: 'libeffectrender.so 链接了 GLESv3 和 EGL，OpenGL上下文在哪个线程创建？与XComponent的UI线程是否相同？',
    expect: 'light',
    maxChars: 8_000,
    mustContain: [
      /CMake|EGLCore|PluginRender|plugin_manager|GLESv3/i,
      /ANSWER NOW|Coarse locate/i,
    ],
    mustNotMatch: [/enum-member coverage may be incomplete/i],
  },

  // --- inventory ---
  {
    id: 'inv-kit-taskpool',
    shape: 'kit API usage sites',
    query: '哪些代码依赖@kit.ArkTS的taskpool这个api端点',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 7_500,
  },
  {
    id: 'inv-telephony-en-bag',
    shape: 'PascalCase SDK module EN bag → @kit import survey',
    query: 'Telephony 调用方法 usage calls radio call sim',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 8_000,
    mustContain: [
      /API usage sites|@kit \/ @hms Telephony|@kit\.TelephonyKit|@hms\.telephony/i,
      /ANSWER NOW/i,
    ],
  },
  {
    id: 'inv-kit-extra-deps',
    shape: 'kit extra install / deps',
    query: '调用ServiceCollaborationKit需要引入其他参数和依赖么？',
    expect: 'inventory',
    pins: { preferExplore: true, kitInstall: true },
    maxChars: 3_500,
  },
  {
    id: 'inv-kit-extra-deps-zh',
    shape: 'kit 额外安装依赖',
    query: '调用 ServiceCollaborationKit 需要额外安装哪些依赖？',
    expect: 'inventory',
    pins: { kitInstall: true },
    maxChars: 3_500,
  },
  {
    id: 'inv-kit-extra-deps-en-bag',
    shape: 'kit install-deps EN rewrite (parameters/dependencies — not bare import list)',
    query: 'ServiceCollaborationKit import usage parameters dependencies',
    expect: 'inventory',
    pins: { preferExplore: true, kitInstall: true },
    maxChars: 3_500,
    mustContain: [/Kit module|oh-package/i, /ANSWER NOW/i],
    mustNotMatch: [/Listed \*\*\d+\*\* import site\(s\)\. \*\*ANSWER NOW\*\* from the dependency list/i],
  },
  {
    id: 'inv-system-language',
    shape: 'system-capability howto',
    query: '如何获取系统当前设置的语言',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 3_000,
  },
  {
    id: 'inv-hover',
    shape: 'hover handler survey (no named Type)',
    query: '鼠标悬停在应用图标背景上会有什么反应',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 5_000,
    mustContain: [/onHover|AppIconCommonView|HoverAnimationUtil|AppIconHoverEvent/i, /ANSWER NOW/i],
    mustNotMatch: [/HoverConstants.*controlcenter/i],
  },
  {
    id: 'inv-module-cycles',
    shape: 'leaf *common circular deps',
    query:
      'staticcommon/launchercommon、screenlockcommon、systemuicommon、controlcentercommon 这四个模块之间是否存在相互依赖？如果存在，是否形成了循环依赖？',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 4_000,
  },
  {
    id: 'inv-module-cycles-leaf-constants',
    shape: 'single *constants leaf + cycle ask (not concept-skip)',
    query: 'fooconstants 谁依赖它，是否存在循环依赖，对系统有何影响？',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 4_000,
  },
  {
    id: 'inv-dts-wrap',
    shape: '.d.ts wrap call sites',
    query:
      'harmonyShare.d.ts这个文件中似乎对 systemShare 进行了封装，这个目的是什么，它们在什么地方被调用了',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 3_000,
  },
  {
    id: 'inv-constant',
    shape: 'ALL_CAPS / enum member usages',
    query: 'audio.AudioVolumeType.RINGTONE 在项目中哪些函数或方法中被依赖或调用？',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 3_500,
  },
  {
    id: 'inv-field-mutex',
    shape: 'field/mutex co-use',
    query:
      'triggerSubThreadDraw 里启动的子线程会调用 drawOnSubThread。drawOnSubThread 里用了 m_eglMutex，还有哪些函数也会用到这个锁？',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 3_500,
  },
  {
    id: 'inv-field-new-delete',
    shape: 'field new/delete lifetime',
    query: 'PluginRender 里的 m_eglCore 指针，在哪些地方被 new 出来？又在哪些地方被 delete 掉？',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 4_000,
  },
  {
    id: 'inv-drawmodifier',
    shape: 'member usage listing (.drawModifier)',
    query: '哪些组件使用了 .drawModifier 或 DrawContext 进行自定义绘制？',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 4_000,
  },
  {
    id: 'inv-listed-methods',
    shape: 'Type + listed methods callers',
    query: '哪些文件调用了BinaryGrid 模板类的 Set、Test 或 Fill 方法？',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 3_500,
  },
  {
    id: 'inv-config-getters',
    shape: 'GetWidth/GetHeight via config_',
    query:
      '项目中哪里调用了GetWidth() 或 GetHeight() 方法，通过config_ 或 this->config_ 间接调用也算。',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 4_000,
  },
  {
    id: 'inv-data-source-badge',
    shape: 'Manager data-source',
    query: 'BadgeManager 管理应用图标上的角标数字，角标数据来源于哪个系统服务？',
    expect: 'inventory',
    pins: { dataSource: true, preferExplore: true },
    maxChars: 4_000,
  },
  {
    id: 'inv-event-dispatch-datashare',
    shape: 'Event types → Manager dispatch',
    query:
      'SysUIDataShareEvent 定义的数据共享事件类型有哪些，各被 DataShareMgr 分发给哪些 Manager 处理？',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 12_000,
    mustContain: [
      /Event type classes|TimeFormatEvent|NtfHideContentEvent/i,
      /ANSWER NOW/i,
      /DataShareMgr|Manager|produceOn|InnerEventUtil\.on|\.on\(/i,
    ],
    mustNotMatch: [/enum-member coverage may be incomplete/i],
  },
  {
    id: 'inv-multi-type-extends',
    shape: '≥3 named *Installer/*Parser Types + dependency ask → extends bases',
    query:
      'ThemePackParser、ThemePackageInstaller、SkinInstaller、IconsInstaller、FontInstaller五个类之间的依赖关系是怎样的',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 4_000,
    mustContain: [/extends|AbsResourceInstaller|ResourceBasicInstaller/i, /ANSWER NOW/i],
  },
  {
    id: 'inv-data-source-account',
    shape: 'Manager 状态来源 → data-source (not lifecycle dump)',
    query: 'AccountManager 内部对于账户状态变化的“状态来源”是如何统一或区分的？',
    expect: 'inventory',
    pins: { dataSource: true, lifecycle: false, preferExplore: true },
    maxChars: 6_000,
  },
  {
    id: 'inv-container-composition',
    shape: 'shared container + ViewModel injection survey',
    query: '哪些页面共享 CommonScbScreen 作为容器，各自如何向 SCBGeneralScreenViewModel 注入差异化配置？',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 6_000,
    mustContain: [
      /Container composition|ViewModel injection/i,
      /LocalStorageLink|screenSession|CommonScbView/i,
      /ANSWER NOW/i,
    ],
  },
  {
    id: 'inv-napi-export',
    shape: 'path-module NAPI export surface',
    query: 'feature/foldeffect 模块通过 NAPI 暴露了哪些 API 接口',
    expect: 'inventory',
    pins: { preferExplore: true },
    maxChars: 3_000,
  },

  // --- local / compact ---
  {
    id: 'local-ui-page',
    shape: 'Page UI surface / navigation',
    query: 'ThemeHome使用了哪些UI组件，可以跳转到哪些页面',
    expect: 'local',
    maxChars: 8_000,
  },
  {
    id: 'local-ui-cluster',
    shape: 'Page + Dialog cluster',
    query:
      'WallpaperApplyPage 内嵌了 @CustomDialog 的 WallpaperApplyDialog，dialog 内的壁纸预览图片加载使用的是 $r 系统资源还是网络下载？',
    expect: 'local',
    maxChars: 8_000,
  },
  {
    id: 'local-type-method-interact',
    shape: 'Type×method interaction (not light / not member inv)',
    query:
      'LayoutDraftExt 类里的draft.CanPlace(element) 和 draft.Place(element)是怎么和BinaryGrid 交互来检测重叠和更新网格的？',
    expect: 'local',
    pins: { memberFocus: true },
    maxChars: 8_000,
  },
  {
    id: 'local-canplace-en',
    shape: 'CanPlace/Place ↔ Grid (EN)',
    query: 'How do CanPlace and Place interact with BinaryGrid?',
    expect: 'local',
    pins: { memberFocus: true },
    maxChars: 8_000,
  },
  {
    id: 'local-visibility-bridge',
    shape: 'caller + definition visibility',
    query: '项目中哪里调用了SortWidgets，其中哪些调用是用来确保IntGrid 的定义可见的？',
    expect: 'local',
    maxChars: 7_000,
  },
  {
    id: 'local-export-fail',
    shape: 'conditional Export wiring',
    query:
      'PluginManager::Export 获取 OH_NATIVE_XCOMPONENT_OBJ 失败时，OnSurfaceCreatedCB 还会被注册吗？',
    expect: 'local',
    maxChars: 7_000,
  },
  {
    id: 'local-release-dtor',
    shape: 'Release ↔ destructor compare',
    query:
      'OnSurfaceDestroyedCB 里调了 PluginManager::GetRender()->Release()。这个 Release 函数做了哪些事情？跟 PluginRender 的析构函数里做的事有没有重复？',
    expect: 'local',
    pins: { lifecycle: true },
    maxChars: 8_000,
  },
  {
    id: 'local-flag-impact',
    shape: 'assigned flag impact on timing',
    query:
      'OnSurfaceChangedCB sets isChangeSurface = true. How does this flag affect later render timing?',
    expect: 'local',
    maxChars: 7_500,
  },
  {
    id: 'local-lifecycle-stub',
    shape: 'Type lifecycle when primary Type is SDK stub-only',
    query: 'SceneSession 的状态机有哪些状态？foreground→background 转换触发哪些回调？',
    expect: 'local',
    pins: { lifecycle: true, preferExplore: true },
    maxChars: 8_000,
    mustContain: [
      /SDK lifecycle surface|State enum|Callbacks/i,
      /sessionStateChange|foreground|background|ANSWER NOW/i,
    ],
    mustNotMatch: [/Stub digests only — treat as Partial locator/i],
  },
  {
    id: 'local-member-ui-consequence',
    shape: 'Type.member + UI consequence (filter sites = UI effect)',
    query: 'LauncherCardInfo.isExpired 返回 true 时，小艺建议卡片在 UI 上如何标记？',
    expect: 'local',
    pins: { memberFocus: true },
    maxChars: 5_000,
    mustContain: [/UI-consequence|filter sites|AddFormToFormStackCommand|isExpired/i, /ANSWER NOW/i],
  },
  {
    id: 'local-member-purpose',
    shape: 'named member purpose',
    query: 'LiveCardWeatherUtil 里用 hdsEffect 做出来的是什么样的天气相关视觉效果？',
    expect: 'local',
    maxChars: 7_000,
  },
];

/** Resolve exclusive route for a query (mirrors ToolHandler explore branching). */
export function resolveExploreRoute(query: string, q: typeof import('../../src/search/query-utils')): ExploreRoute {
  if (q.queryShouldDeferToBuiltinTools(query)) return 'defer';
  if (q.shouldTryLightMechanismExplore(query)) return 'light';
  if (q.shouldTryFastInventoryExplore(query)) return 'inventory';
  if (q.queryAsLocalSymbolDetail(query) || q.shouldUseCompactExploreBudget(query)) return 'local';
  return 'other';
}
