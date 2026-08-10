# 0006 — ArkTS ↔ C++ NAPI 跨语言调用桥接


| 字段 | 内容 |
| --- | --- |
| 编号 | 0006 |
| 类型 | 需求 / 设计 |
| 状态 | 已确认（实现中） |
| 日期 | 2026-08-10 |
| 范围 | 解析/解析器层：从 NAPI 注册点抽取 `(jsName → nativeSymbol)`，合成 ArkTS↔C++ 边；`homegraph_explore` / `node` 可端到端打通；测试与文档 |
| 关联 | 现有 `src/resolution/frameworks/arkts-napi.ts`（需泛化，不可继续只认 `Class_method`）；动态分发原则见 `docs/design/dynamic-dispatch-coverage-playbook.md`；对照仓 `scene_board_ext` |


---

## 1. 背景与目标

OpenHarmony / HarmonyOS 工程里，ArkTS 经 `libXxx.so` 调到 C/C++ NAPI 入口，再进入业务实现。静态抽取在 `.so` 边界断开；现有 `arkts-napi` 只覆盖 photos 风格的 `Class_method`（如 `Asset_setCropRect`），对 `scene_board_ext` 等仓里的 camelCase 扁平导出、`napi_define_class` 等**基本无效**。

**目标：**

1. 用统一中枢产出注册表 `Export{jsName, nativeSymbol, file, kind}`，再合成跨语言边（不追求「通语言 AST 互解析」）。
2. 以多个**绑定前端**尽量覆盖常见 NAPI 写法；喂同一中枢。
3. 能在 `scene_board_ext` 等真实仓上，让 `homegraph_explore` 对典型流（如 `mattes.draw` → `NapiDraw` → 实现；`addVerticalRuler` → `NapiAddVerticalRuler` → `AddVerticalRuler`）端到端连通。
4. 对源码无法静态恢复的映射：**只标 `.so` 边界，不强连**（半桥不如不桥）。

**成功标准：** 对纳入前端能识别的注册点，ArkTS 调用点 → NAPI wrapper（→ 可选同文件业务函数）在图中有边；agent 用符号袋 explore 时不必靠 Read/Grep 拼跨语言链。

---

## 2. 范围

### 2.1 纳入

- 泛化 / 替换现有 `arkts-napi` 解析逻辑（或拆「前端抽取 + 中枢 resolve」），保留 FrameworkResolver 接入方式。
- **中枢**：索引期或 resolve 期构建 `jsName → Node[]`（可带 `nm_modname` / `.so` 名消歧）。
- **绑定前端**（按优先级实现，见 §3）：
  1. 静态 `napi_property_descriptor` 数组字面量（含 `nullptr` / `NULL`）
  2. OH 常用宏（`DECLARE_NAPI_FUNCTION` / `METHOD` / `PROPERTY` 等）按宏形参抽，等价展开
  3. `napi_create_function` + `napi_set_named_property`（同 Init 作用域内字面量成对）
  4. `napi_define_class` **与** `napi_define_sendable_class`
  5. （可选后续）`JSBIND_*` 源码宏；或索引目录中已生成的胶水文件
- ArkTS / TS 侧：`import … from 'libFoo.so'` 与属性/方法调用对齐到 `jsName`。
- **第二跳**（同文件、可静态证明时）：`NapiXxx` / 注册的 native 符号 → 其体内调用的真实业务函数（或稳定命名约定），`provenance: 'heuristic'`，带 `synthesizedBy`。
- 单测（合成 fixture）+ 至少一份对照真实形态的集成/探针说明；CHANGELOG `[Unreleased]` 用户向一句；必要时更新 `docs/local-dev-guide.md`。

### 2.2 不纳入

- 不实现完整 C 预处理器 / 任意宏展开引擎。
- 不跑构建、不加载 `.so`、不做运行时 NAPI 反射。
- 不硬连**仓外 / 无源码**的 `.so`（如仅 `import AigcSdk from 'libaigceffect.so'`）。
- 不覆盖纯运行时拼出来的导出名（非常量字符串）。
- 不把跨语言边做成 MCP 新工具；仍靠现有 `explore` / `node` / callers·callees 暴露。
- 不在本 Spec 内做 C++→ArkTS 回调/事件全通道（可另开 Spec；本版以 ArkTS→C++ 主路径为主，若实现成本低可顺带 `napi_call_function` 字面量反向，但不作为本版验收硬项）。

---

## 3. 架构：一个中枢 + 多个绑定前端

```text
C/C++ 源码 ──► [Frontend A/B/C…] ──► Export[] ──► NapiRegistry
ArkTS 调用 / .so import ─────────────────────────► resolve → calls/references 边
NAPI wrapper 体 / 命名 ──────────────────────────► 可选第二跳 → 业务函数
```

所有前端**只**负责产出：

```ts
interface NapiExport {
  jsName: string;        // ETS 可见名：draw / addVerticalRuler / getTidByName
  nativeSymbol: string;  // C/C++ 回调符号：NapiDraw / getTidByName / …
  filePath: string;
  line: number;
  kind: 'flat' | 'class';
  className?: string;    // define_class 时
  moduleHint?: string;   // nm_modname / 邻近 libXxx.so 线索（可选）
}
```

Resolve 规则（摘要）：

- 仅当调用侧语言为 `arkts`（及必要时同工程的 `ts`），且引用能关联到 `lib*.so` 导入或已声明的 NAPI 导出名时，才走框架 resolve。
- 用调用末段名（`mattes.draw` → `draw`）查注册表；多候选时优先同模块 / 路径含 `napi` 的节点，置信度低于精确 name-match（建议 ~0.7–0.8），避免压过同名精确边。
- **废弃**「仅 `^[A-Z].*_`」作为唯一准入；`Class_method` 仍可作为**额外前端或兼容路径**，不得再当唯一形状。

原则对齐 playbook：**能静态闭合的链路一次做完**（注册 + 调用对齐 + 有把握的第二跳）；闭合不了的停在明确边界。

---

## 4. 绑定前端与覆盖矩阵


| ID | 写法 | 抽取方式 | 本版 | 备注 |
| --- | --- | --- | --- | --- |
| F1 | `napi_define_properties` + descriptor 字面量 | 正则/轻量扫描 `{"js", …, NativeSym}` | **必做** | `scene_board_ext` foldeffect / multimodalinput |
| F2 | `napi_define_class` / `napi_define_sendable_class` + properties | 类名 + 同上 descriptor | **必做** | layoutrotatepacking；sendable 与 class 同等对待 |
| F3 | `DECLARE_NAPI_FUNCTION("foo", NapiFoo)` 等 OH 宏 | 识别已知宏名与两实参，不入完整 cpp | **必做** | 文本扫宏即可；未列出的宏可后续加表 |
| F4 | `napi_create_function` + `napi_set_named_property` | 同函数内字面量名对齐 | **必做** | 无静态 descriptor 数组时的主路径 |
| F5 | 条件分支内仍是字面量/宏 | 与 F1–F4 相同扫描（不求执行路径） | **必做**（顺带） | 两边都注册则都进表；不模拟 `if` |
| F6 | `JSBIND_CLASS` / `JSBIND_FUNCTION` 等 | 源码宏前端，或扫 generated | **可选 / 后续** | 胶水不在源码且无宏时 → 边界 |
| F7 | 仓外 `.so` | 不建跨语言边 | **边界** | 可文档化「native boundary」提示，不强连 |
| F8 | 动态非字面量导出名 | 不抽取 | **不做** | |

**第二跳（S2，本版应做、可保守）：**

- 当 native 符号体在同文件（或同翻译单元可廉价看到的相邻定义）内对另一符号有明确 `calls`，或存在稳定命名（`NapiAddVerticalRuler` → `AddVerticalRuler`）且目标唯一时，合成到业务函数。
- 不确定则**只停在 NAPI wrapper**，不猜。

---

## 5. 行为与约束

1. **确定性**：同一源码多次索引，Export 集合稳定；不引入 LLM。
2. **精度优于召回**：宁可漏边，不把无关 `draw` 链到错误模块；无 `lib*.so` / 无注册命中时不发电边。
3. **边元数据**：启发式边使用现有约定（如 `provenance: 'heuristic'`，`metadata.synthesizedBy: 'arkts-napi'` 或更细前端名）。
4. **探测**：`detect()` 在存在 `lib*.so` 导入或 NAPI 注册 API/宏时为 true，避免无 NAPI 仓误伤。
5. **错误形态**：找不到映射时静默不解析（与其他 framework resolver 一致），不 `isError`。
6. **性能**：按文件过滤（`.c/.cc/.cpp/.cxx` + 含 napi/宏线索再深扫）；注册表可按 `ResolutionContext` 缓存。

---

## 6. 对照与验收锚点

### 6.1 `scene_board_ext`（主对照）

| 流 | 期望 |
| --- | --- |
| `MultiModalInputUtil.getMultiModalTid` → `getTidByName` | ETS → `napi_init.c` 中 `getTidByName` |
| `ScreenEffectPage` → `mattes.draw` / `setDirection` / `finishDraw` | → `PluginManager::Napi*`（及有把握时到 `PluginRender`） |
| `LayoutRotatePackingProxy.addVerticalRuler` | → `NapiAddVerticalRuler` →（S2）`AddVerticalRuler` |
| `libaigceffect.so` | **无**跨语言实现边 |

### 6.2 兼容

- photos / imageEditor 风格 `Asset_setCropRect` 仍应连通（回归，勿只为 scene_board 改坏）。

### 6.3 探针（实现阶段）

```text
homegraph_explore 符号袋含：draw NapiDraw / getTidByName / addVerticalRuler NapiAddVerticalRuler
→ Flow 跨 ets 与 cpp，无断在 .so
```

---

## 7. 建议实现分期


| 阶段 | 内容 | 退出标准 |
| --- | --- | --- |
| P0 | 中枢 + F1 + F2（含 sendable）+ ETS `.so` 对齐；丢掉唯一 `Class_method` 门禁；保留其作为兼容 | scene_board 扁平 + class 两条流通；photos 回归 |
| P1 | F3 宏表 + F4 create_function/set_named_property；S2 保守第二跳 | 宏/动态挂载 fixture 单测绿 |
| P2 | F6 JSBIND / generated（按真实子仓需求再开） | 另验收，不阻塞 P0/P1 合入 |

本 Spec **验收以 P0+P1 为硬项**；P2 可在同 PR 或后续 Spec。

---

## 8. 验收标准

- [x] 注册抽取不再依赖「仅 `Class_method`」；F1/F2/F3/F4 有单测 fixture（含 `DECLARE_NAPI_*`、`create_function`+`set_named_property`、`define_sendable_class`）
- [x] `scene_board_ext` 三条主链（multimodalinput / foldeffect / layoutrotatepacking）在索引后 explore 或 callers/callees 可跨语言连通（迷你探针 + `arkts-napi-e2e.test.ts`：flat / define_class 实例 / photos）
- [x] `libaigceffect.so` 类无源码 so **不**产生假实现边（无源码则无注册表命中）
- [x] photos 风格 `Class_method` 回归通过（单测 + e2e）
- [x] 第二跳仅在有把握时出现；无把握时边停在 NAPI 入口
- [x] CHANGELOG `[Unreleased]` 有用户向说明；local-dev-guide 如需同步已更新
- [x] 端到端索引链覆盖：flat camelCase、define_class 实例方法、DECLARE_NAPI_*、create_function、define_sendable_class（`test/languages/arkts/arkts-napi-e2e.test.ts`）

---

## 9. 风险与非目标再强调

| 风险 | 应对 |
| --- | --- |
| OH 宏变体多 | 维护显式宏名表，遇新宏加一行，不做通用 cpp |
| JSBIND 只在构建产物 | P2；否则边界 |
| 同名 `draw` 多模块 | moduleHint / 导入的 so 名 / 路径消歧；低置信 |
| 半桥诱导 Read | 有把握才做 S2；否则停在 wrapper 并在 explore 展示清晰断点 |

**没有**「零前端、全写法通用」的静态解；通用性来自 **Export 中枢 + 可插拔前端**，而不是单一正则通吃。

---

## 10. 参考

- 现实现：`src/resolution/frameworks/arkts-napi.ts`、`test/languages/arkts/arkts-napi.test.ts`
- 本地对照说明：`docs/local-dev-guide.md`（ArkTS NAPI 提问示例）
- 跨语言先例：`docs/design/mixed-ios-and-react-native-bridging.md`、RN / Swift↔ObjC framework resolvers
- 对照工程：`D:\code\scene_board_ext`（`feature/foldeffect`、`layoutrotatepacking`、`multimodalinput`）
