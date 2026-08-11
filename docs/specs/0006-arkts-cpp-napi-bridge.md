# 0006 — ArkTS ↔ C++ NAPI 跨语言调用桥接


| 字段 | 内容 |
| --- | --- |
| 编号 | 0006 |
| 类型 | 需求 / 设计 |
| 状态 | 已完成 |
| 日期 | 2026-08-10 |
| 范围 | 解析/解析器层：从 NAPI 注册点抽取 `(jsName → nativeSymbol)`，合成 ArkTS↔C++ 边；`homegraph_explore` / `node` 可端到端打通；测试与文档 |
| 关联 | 实现：`src/resolution/frameworks/arkts-napi.ts`；动态分发原则见 `docs/design/dynamic-dispatch-coverage-playbook.md`；对照仓 `scene_board_ext` |


---

## 1. 背景与目标

OpenHarmony / HarmonyOS 工程里，ArkTS 经 `libXxx.so` 调到 C/C++ NAPI 入口，再进入业务实现。静态抽取在 `.so` 边界断开；旧 `arkts-napi` 只覆盖 photos 风格的 `Class_method`（如 `Asset_setCropRect`），对 `scene_board_ext` 等仓里的 camelCase 扁平导出、`napi_define_class` 等**基本无效**。

**目标：**

1. 用统一中枢产出注册表 `Export{jsName, nativeSymbol, …}`，再合成跨语言边（不追求「通语言 AST 互解析」）。
2. 以多个**绑定前端**覆盖常见 NAPI 写法；喂同一中枢。
3. 在典型流上让 `homegraph_explore` 端到端连通（如 `mattes.draw` → `NapiDraw`；`addVerticalRuler` → `NapiAddVerticalRuler` → `AddVerticalRuler`）。
4. 对源码无法静态恢复的映射：**只标 `.so` 边界，不强连**（半桥不如不桥）。

**成功标准：** 对纳入前端能识别的注册点，ArkTS 调用点 → NAPI wrapper（→ 有把握时同文件业务函数）在图中有边；agent 用符号袋 explore 时不必靠 Read/Grep 拼跨语言链。

---

## 2. 范围

### 2.1 做（已实现）

- 泛化 `arkts-napi`：前端抽取 + 中枢 resolve；FrameworkResolver 接入。
- **中枢**：resolve 期 `jsName → Node[]`（路径含 `napi` 优先消歧）。
- **绑定前端**：见 §4 矩阵中标「做」的项（F1–F5、`Class_method` 兼容、S2）。
- ArkTS / TS：`import … from 'libFoo.so'` 与属性/方法调用对齐到 `jsName`。
- **第二跳（S2）**：`NapiXxx` → 同文件业务符号（命名约定 + 同文件可见调用/定义），保守；不确定则停在 wrapper。
- 单测 + e2e（`arkts-napi.test.ts` / `arkts-napi-e2e.test.ts`）；CHANGELOG / local-dev-guide 已更新。

### 2.2 不做

- 完整 C 预处理器 / 任意宏展开引擎。
- 跑构建、加载 `.so`、运行时 NAPI 反射。
- 硬连**仓外 / 无源码**的 `.so`。
- 纯运行时拼出来的导出名（非常量字符串）。
- `JSBIND_*` / 仅构建产物胶水、无源码宏时的抽取。
- 单独用 `napi_set_named_property` 与别处成对拼名（仅 `napi_create_function` 字面量名抽取；`set_named_property` 只作文件 cue）。
- C++→ArkTS 回调 / `napi_call_function` 反向全通道。
- 跨语言边做成 MCP 新工具（仍靠 `explore` / `node` / callers·callees）。

---

## 3. 架构：一个中枢 + 多个绑定前端

```text
C/C++ 源码 ──► [Frontend A/B/C…] ──► Export[] ──► NapiRegistry
ArkTS 调用 / .so import ─────────────────────────► resolve → calls/references 边
NAPI wrapper 体 / 命名 ──────────────────────────► S2（有把握）→ 业务函数
```

前端产出（实现字段名 `nativeName`）：

```ts
interface NapiExport {
  jsName: string;        // ETS 可见名：draw / addVerticalRuler / getTidByName
  nativeName: string;    // C/C++ 回调符号（已去 `Class::` 前缀）：NapiDraw / …
  line: number;
  kind: 'flat' | 'class';
  className?: string;    // define_class 时
}
```

Resolve 规则（摘要）：

- 调用侧 `arkts` / `typescript`，查注册表；置信度约 0.75，低于精确 name-match。
- **不再**以「仅 `^[A-Z].*_`」为唯一准入；`Class_method` 仅作兼容前端。
- 原则：能静态闭合的一次做完；闭合不了的停在明确边界。

---

## 4. 绑定前端与覆盖矩阵


| ID | 写法 | 抽取方式 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| F1 | `napi_define_properties` + descriptor 字面量 | `{"js", nullptr\|NULL, NativeSym, …}` | **做** | flat camelCase、`.c` `NULL` |
| F2 | `napi_define_class` / `napi_define_sendable_class` + properties | 类名 + 同上 descriptor | **做** | sendable 与 class 同等 |
| F3 | `DECLARE_NAPI_FUNCTION` / `METHOD` / `PROPERTY` / `GETTER` / `SETTER` | 宏名 + 两实参 | **做** | 显式宏表，非通用 cpp |
| F4 | `napi_create_function(env, "name", …, Native, …)` | 字面量名 + 回调符号 | **做** | |
| F5 | 条件分支内仍是字面量/宏 | 全文扫描，不模拟 `if` | **做** | 两边都注册则都进表 |
| Compat | photos `Class_method` | descriptor 行 + `napi_value Class_method(` | **做** | 回归 |
| S2 | `NapiFoo` → `Foo` | 同文件、命名可证 | **做** | 无把握则停 wrapper |
| F6 | `JSBIND_*` / 仅 generated 胶水 | — | **不做** | |
| F7 | 仓外 `.so` | — | **不做** | 无注册表命中 → 无假边 |
| F8 | 动态非字面量导出名 | — | **不做** | |

---

## 5. 行为与约束

1. **确定性**：同一源码多次索引，Export 集合稳定；不引入 LLM。
2. **精度优于召回**：无 `lib*.so` / 无注册命中不发电边。
3. **边元数据**：`provenance: 'heuristic'`，`synthesizedBy: 'arkts-napi'`（及框架 resolve 路径）。
4. **探测**：`detect()` 在存在 `lib*.so` 导入或 NAPI 注册 API/宏时为 true。
5. **错误形态**：找不到映射时静默不解析，不 `isError`。
6. **性能**：`.c/.cc/.cpp/.cxx` + NAPI cue 再深扫；注册表按 `ResolutionContext` 缓存。

---

## 6. 对照与验收锚点

### 6.1 `scene_board_ext`（主对照）

| 流 | 期望 |
| --- | --- |
| `MultiModalInputUtil.getMultiModalTid` → `getTidByName` | ETS → `napi_init.c` 中 `getTidByName` |
| `ScreenEffectPage` → `mattes.draw` / `setDirection` / `finishDraw` | → `PluginManager::Napi*`（及有把握时到业务） |
| `LayoutRotatePackingProxy.addVerticalRuler` | → `NapiAddVerticalRuler` →（S2）`AddVerticalRuler` |
| `libaigceffect.so` | **无**跨语言实现边 |

### 6.2 兼容

- photos / imageEditor 风格 `Asset_setCropRect` 仍连通。

### 6.3 探针

```text
homegraph_explore 符号袋含：draw NapiDraw / getTidByName / addVerticalRuler NapiAddVerticalRuler
→ Flow 跨 ets 与 cpp，无断在 .so
```

---

## 7. 验收标准

- [x] 注册抽取不再依赖「仅 `Class_method`」；F1/F2/F3/F4 有单测 fixture（含 `DECLARE_NAPI_*`、`create_function`、`define_sendable_class`）
- [x] flat / define_class / photos 主链在索引后 callers/callees 可跨语言连通（`arkts-napi-e2e.test.ts`）
- [x] 无源码 so **不**产生假实现边
- [x] photos 风格 `Class_method` 回归通过
- [x] 第二跳仅在有把握时出现；无把握时边停在 NAPI 入口
- [x] CHANGELOG `[Unreleased]` 有用户向说明；local-dev-guide 已同步
- [x] 端到端覆盖：flat camelCase、define_class 实例方法、DECLARE_NAPI_*、create_function、define_sendable_class

---

## 8. 风险

| 风险 | 应对 |
| --- | --- |
| OH 宏变体多 | 显式宏名表，遇新宏加一行 |
| JSBIND 只在构建产物 | **不做**；无源码则边界 |
| 同名 `draw` 多模块 | 路径含 `napi` 优先；低置信 |
| 半桥诱导 Read | 有把握才做 S2；否则停在 wrapper |

**没有**「零前端、全写法通用」的静态解；通用性来自 **Export 中枢 + 可插拔前端**。

---

## 9. 参考

- 实现：`src/resolution/frameworks/arkts-napi.ts`、`test/languages/arkts/arkts-napi.test.ts`、`test/languages/arkts/arkts-napi-e2e.test.ts`
- 本地对照：`docs/local-dev-guide.md`（ArkTS NAPI 提问示例）
- 跨语言先例：`docs/design/mixed-ios-and-react-native-bridging.md`
- 对照工程：`D:\code\scene_board_ext`（`feature/foldeffect`、`layoutrotatepacking`、`multimodalinput`）
