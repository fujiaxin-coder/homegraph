# 0015 — 关闭 MCP 进程 RSS 内存软上限

| 字段 | 内容 |
| --- | --- |
| 编号 | 0015 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-08-21 |
| 范围 | MCP / daemon 上基于 `process.memoryUsage().rss` 的软上限与其接线；相关测试与 Unreleased CHANGELOG |
| 关联 | `src/mcp/memory-budget.ts`；调用方 `src/mcp/tools.ts`、`src/mcp/engine.ts`；`test/memory-budget.test.ts`；`vitest.config.ts` 中的 `HOMEGRAPH_MAX_RSS_MB` |

---

## 1. 背景与目标

MCP 用 `HOMEGRAPH_MAX_RSS_MB`（默认 1024、硬夹到 4096）对比 `process.memoryUsage().rss`，超限则：

- 所有工具入口直接返回 success-shaped **Partial**（`rssBudgetPartialResult`），不再查图；
- callers 收集中途 `break`；
- catch-up sync 因「接近上限」跳过，或 mid-flight 抛 `HOMEGRAPH_RSS_BUDGET` 中止。

该闸在 **Windows Working Set** 与 **macOS resident_size** 上不可比：同一套大仓（如 ~1.7GB `homegraph.db`）Windows 更易误杀，且超限后 RSS 不回落，长寿命 daemon 会粘死整场会话/评测。mac 侧往往不触发，造成跨平台行为分裂。

**目标：** 默认与可配置路径均 **不再** 因进程 RSS 拒绝工具或中止 catch-up；去掉跨平台不可比的 RSS 软上限。

---

## 2. 范围

### 2.1 纳入

| 项 | 要求 |
| --- | --- |
| 工具硬拒 | 删除或永久短路 `ToolHandler.execute` 中 `isOverRssBudget()` → `rssBudgetPartialResult` |
| callers 中断 | 删除 `collect` 循环内 `if (isOverRssBudget()) break` |
| catch-up | `shouldSkipCatchUpSync` **不再**因 `isNearRssBudget()` 跳过；`sync({ onProgress })` **不再**因 `isOverRssBudget()` 抛 `HOMEGRAPH_RSS_BUDGET` |
| API 表面 | `isOverRssBudget` / `isNearRssBudget` / `rssBudgetPartial*` / `resolveMaxRssMb`：删除，或保留为恒 `false` / 无操作并标注 deprecated（优先删除未再引用的符号） |
| 环境变量 | `HOMEGRAPH_MAX_RSS_MB` 不再影响运行时行为；文档/测试/ vitest 注入中清除或注明无效 |
| 测试 | 更新或删除 `test/memory-budget.test.ts` 中依赖「RSS 上限会触发」的用例；保留与 **非 RSS** 逻辑相关的断言（见下） |
| CHANGELOG | `[Unreleased]` 增加用户向说明：MCP 不再按进程 RSS 软拒工具 |

### 2.2 保留（明确不删）

| 项 | 理由 |
| --- | --- |
| 大索引跳过 catch-up（`db` ≥ 64MB 等 `LARGE_INDEX_SKIP_CATCHUP_*`） | 按**文件体积**降载，与 RSS 口径无关；仍可用 `HOMEGRAPH_FORCE_CATCHUP_SYNC` / `HOMEGRAPH_SKIP_CATCHUP_SYNC` |
| `mmap_size = 0`、SQLite `cache_size` 等连接配置 | 控制工作集膨胀，不是「超限拒工具」 |
| Query pool 默认 concurrency=1 | 并发策略，不是 RSS Partial 闸 |
| ArkTS 索引路径的 `PROCESS_RSS_CAP_MB` / `memoryLimitMB` / `--max-old-space-size` | **索引期**资源约束，本 Spec **不改**；若后续要动，另开 Spec |
| `src/resolution/memory-budget.ts`（resolver pool / synth 并发） | 与 MCP RSS 软拒无关，本 Spec **不改** |

### 2.3 不纳入

- 换成 RssAnon / Private Bytes 等跨平台可比度量并重新设闸；
- 评测 harness（`homegraph_eval`）改动；
- 调整默认 explore 输出预算或 session fuse。

---

## 3. 行为约束

1. 在任意平台、任意 `HOMEGRAPH_MAX_RSS_MB`（含未设置）下：MCP 工具 **不得** 仅因 RSS 返回 `hit its process memory budget` 类 Partial。
2. catch-up：仅因显式 env、大索引策略、或真实 sync 错误跳过/失败；**不得**再出现因 memory budget 的 skip/abort 文案路径（实现后日志字符串应更新，去掉 “memory budget” 归因，若仍保留大索引 skip）。
3. 删除/短路后：`npm run build` 与受影响单测通过；无悬挂 import。

---

## 4. 验收标准

- [x] 仓库内无「RSS 超限 → 工具 Partial / callers break / catch-up RSS abort」的有效路径
- [x] `HOMEGRAPH_MAX_RSS_MB` 不再改变 MCP 工具是否执行
- [x] 大索引 / `HOMEGRAPH_SKIP_CATCHUP_SYNC` / `HOMEGRAPH_FORCE_CATCHUP_SYNC` 行为仍符合现有非 RSS 语义
- [x] `npm run build`；`npx vitest run test/memory-budget.test.ts`（或该文件删除后相关套件）通过
- [x] `CHANGELOG.md` `[Unreleased]` 有对应说明
- [x] 本 Spec 状态改为「已完成」

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 超大仓长寿命 daemon 可能涨到多 GB | 接受；靠已有 mmap off、小 cache、pool=1；极端情况由 OS/用户杀进程 |
| 误删大索引 skip catch-up | 验收清单强制保留体积/env 分支 |

回滚：恢复 `memory-budget` 闸与调用点（git revert 本 Spec 实现提交）。

---

## 6. 实现状态

状态：**已完成**（2026-08-21）。

已删 MCP RSS 闸与 `HOMEGRAPH_MAX_RSS_MB` 行为；`shouldSkipCatchUpSync` 仅保留 env + 大索引体积策略。
