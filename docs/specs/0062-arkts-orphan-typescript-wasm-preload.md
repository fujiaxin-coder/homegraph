# 0062 — ArkTS 孤儿 `.ets`：预加载 TypeScript WASM 供 shallow fallback

| 字段 | 内容 |
| --- | --- |
| 编号 | 0062 |
| 类型 | 修复 |
| 状态 | 已完成 |
| 日期 | 2026-10-30 |
| 范围 | `expandGrammarLanguages`（`arkts`→`typescript`）；`indexAll` 在 parse worker 开启时仍于**主线程**加载 grammar；P2 回归测 `ets-typescript-parser-fallback` |
| 非本 Spec | 将 oh-package / 裸 `.ets` 孤儿注册为 synthetic PROJECT 纳入 `analyseByModule`（会触发已索引模块重复 SIGNATURES，见 Spec 0036）；改 orphan 路由离开 tree-sitter；P1 `resolveChild` kind 扫描；P3 ViewTree `%AM` `file_path` |

---

## 1. 背景与目标

模块化 ArkTS batch（Spec 0036）故意**不**把遗忘 HAR / 无 `build-profile` 登记、且仅有 `oh-package.json5` 或裸 `.ets` 的树注册为 synthetic PROJECT→BODIES，以免 `file:` monorepo 依赖再次进入 ModuleCache SIGNATURES。这些文件在 batch commit 后走：

`isArkTSBatchCommitted() && !isArkTSBatchPersisted(path)` → `TreeSitterExtractor(path, source, 'typescript')`。

纯 ArkUI 仓的 `neededLanguages` 只有 `arkts`；`arkts` 无 WASM。主线程（`requiresInProcessExtraction('arkts')`）上 `getParser('typescript')` 为空 → `Failed to get parser for language: typescript`（errors.log 成片 `.ets`）。Parse worker 即使加载了 TS WASM，也帮不上主线程 isolate。

**目标：** 在**不**把孤儿重新纳入 `analyseByModule` 的前提下，保证上述 TypeScript shallow fallback 有可用 parser。

---

## 2. 范围

### 2.1 做

- `expandGrammarLanguages`：语言集含 `arkts` 时附带 `typescript`（与 svelte/vue/astro 附带 TS/JS 同模式）。
- `ExtractionOrchestrator.indexAll`：启用 parse worker 时，若 `neededLanguages` 含 `arkts`，主线程仍 `await loadGrammarsForLanguages(neededLanguages)`。
- 增量路径已走主线程 `loadGrammarsForLanguages`，经 expand 自动带上 `typescript`。
- 回归：batch 已 commit + 未 persist 的幽灵 `.ets` 调用 `extractFromSource(..., 'arkts')` 不得再出现 `Failed to get parser for language: typescript`。

### 2.2 不做

- 不把 oh-package HAR / packageless `.ets` 注册进 `analyseByModule`（重复加载风险仍由 Spec 0036 约束）。  
- 不新增 ets 专用 WASM；fallback 语法仍为 TypeScript。  
- 不保证孤儿获得与 PROJECT BODIES 同等的 ViewTree/RTA 深度。

---

## 3. 行为

| 场景 | 结果 |
| --- | --- |
| 索引集含 `.ets`（`arkts`），无独立 `.ts` | 仍加载 `tree-sitter-typescript.wasm` |
| batch 后未 persist 的 `.ets` → TS extractor | `getParser('typescript')` 非 null；无 `parser_error` / 上述 Failed 文案 |
| 仅 worker 加载 grammar、主线程未加载（修复前） | 主线程 orphan fallback 失败 — **修复后不允许** |
| 无 `arkts` 的工程 | 不因本 Spec 额外加载 typescript |

---

## 4. 验收

- [x] Spec 落盘；`expandGrammarLanguages` / 主线程 preload 按上表实现
- [x] `test/harmony-graph-stability/tests/ets-typescript-parser-fallback.test.ts` 通过（非 skip）
- [x] CHANGELOG `[Unreleased]` 有条目
