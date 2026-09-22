# 0036 — ArkTS 合成 orphan 收紧与禁止二次 analyseByModule


| 字段 | 内容 |
| --- | --- |
| 编号 | 0036 |
| 类型 | 缺陷修复 |
| 状态 | 已完成 |
| 日期 | 2026-09-18 |
| 范围 | `findSyntheticArkModuleRoot` / `listSyntheticArkModuleRoots`；`runArkTSBatch` 已提交后禁止全量重建；`extractSource` orphan tree-sitter 回退；`HomeGraph.indexAll` `durationMs`；相关单测；`scripts/index-peak-mem.ps1` 采样 |
| 关联 | Spec 0025（合成模块）；Spec 0034（build-profile 单引号）；SceneBoard 级鸿蒙多模块 init 劣化与「127/127 后又从 1/127 重跑」 |


---

## 1. 背景与目标

在 SceneBoard 类鸿蒙工程上观测到：

1. **合成 PROJECT 过宽**：`build-profile` 解析失败或 orphan 聚类时，会把 `feature/` 等父目录、或带重 `oh-package` 依赖的忘登记 HAR 注册成 synthetic PROJECT→BODIES，导致依赖 ModuleCache 暴涨、墙钟与 RSS 劣化；未修复的 parent swallow 还会对整棵 `feature/` 二次 BODIES。
2. **二次 `analyseByModule`**：流式 modular 批次落盘并 `releaseScene` 后，未进 PROJECT 的 orphan `.ets` 仍走 `ArkTSExtractor` → `runArkTSBatch`；因不在 `batchPersistedPaths` 内会再开一整遍无 `streamPersist` 的 `analyseByModule`（日志呈 127/127 完成 → 再从 1/127 开始）。
3. **报时偏短**：CLI 打印的 `durationMs` 只覆盖 extraction orchestrator，不含 resolve / linking / maintenance，与 peak 脚本墙钟不一致。

**目标：**

1. 合成模块仅保留 **Node `package.json`** 树（如 hvigor 插件）；禁止 climb 到会吞掉真实 Harmony `srcPath` 的父目录；`oh-package` / 无包 orphan 不进 AA BODIES。
2. 本轮 ArkTS batch 一旦 committed，**禁止**再 `runArkTSBatchFull`；未落盘 orphan 用 TypeScript tree-sitter 抽符号。
3. `indexAll` 返回的 `durationMs` = 完整墙钟（含 resolve/link/maintenance 等）。
4. peak 采样脚本避免全机 WMI 卡死，用进程树 PrivateMemory 反映真实峰值。

---

## 2. 范围

### 2.1 做

- `src/extraction/languages/arkts.ts`：`syntheticRootConflictsWithHarmonyModules`；`findSyntheticArkModuleRoot` 仅认 `package.json` + 冲突检查；`runArkTSBatch` 在 `batchBuildCommitted` 时对同 root 一律返回 hollow（含未 persist 的 orphan）。
- `src/extraction/tree-sitter.ts`：batch 已提交且文件未 persist 时，`.ets` 走 `TreeSitterExtractor('typescript')`，不调 `ArkTSExtractor`。
- `src/extraction/index.ts`：仅当 `isArkTSBatchPersisted` 时跳过读/解析；不再把「已 committed 的全部 ark 路径」假标为已索引。
- `src/index.ts`：`indexAll` 用 `wallStartedAt` 覆盖 `result.durationMs`。
- `test/languages/arkts/arkts-synthetic-modules.test.ts`：oh-package / 无包不合成；Node 插件不 climb 到 `feature/`。
- `scripts/index-peak-mem.ps1`：按 ParentProcessId 枚举后代；采样 PrivateMemory。
- `CHANGELOG.md` `[Unreleased]` Fixes。

### 2.2 不做

- 不默认开启 `HOMEGRAPH_ARKTS_ISOLATED`（隔离 AA 子进程；历史栈溢出重试风险另案）。
- 不在本 Spec 改 Parsing worker / synthesis 并发默认值（压峰实验另测）。
- 不改 MCP 工具协议或产品索引态。

---

## 3. 行为与约束

| 场景 | 期望 |
| --- | --- |
| orphan 在 `plugin/package.json` 下 | 仍可 `synthetic:plugin` |
| orphan 仅有 `oh-package.json5` 或无包 | 不注册 synthetic；AA 批次后 tree-sitter |
| orphan 路径会 climb 到含真实 Harmony 模块的父目录 | 不返回该父目录 |
| modular 流式 127/127 + releaseScene 之后 | 日志中 `analyseByModule: ENTER` 本轮仅一次 |
| `homegraph init` 打印的 duration | 接近 peak 脚本 `elapsed`（含 linking） |

---

## 4. 验收标准

- [x] `listSyntheticArkModuleRoots` 对 SceneBoard 形夹具：仅 Node `package.json` 插件入选；`visionglass` oh-package / 无包 themebase 等不入选；插件不合成 `feature/`。
- [x] `runArkTSBatch`：`batchBuildCommitted` 后同 root 任意 trigger 不调用 `runArkTSBatchFull`。
- [x] `extractSource('arkts')`：committed 且未 persist → tree-sitter typescript，不重建 Scene。
- [x] `indexAll` `durationMs` 覆盖 resolve/link 之后。
- [x] `arkts-synthetic-modules` vitest 通过；CHANGELOG Unreleased 已写。
- [x] Commit footer：`Spec: docs/specs/0036-arkts-synthetic-orphan-no-double-batch.md`。

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 忘登记 HAR 符号质量弱于 AA BODIES | 应用应把模块补进 root `build-profile.json5`；tree-sitter 保底 |
| 隔离 AA 未纳入 | 明确非目标；峰值后续用 parse/synth 串行等手段 |

回滚：revert 本 Spec 对应 commit。

---

## 6. 非目标

- `HOMEGRAPH_ARKTS_ISOLATED` 默认化。
- Parsing / linking 并发策略产品化（另实验）。
