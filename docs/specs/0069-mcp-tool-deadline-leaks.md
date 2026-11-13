# 0069 — MCP 工具 deadline 泄漏修复（transport 线程阻塞路径）

| 字段 | 内容 |
| --- | --- |
| 编号 | 0069 |
| 类型 | 缺陷修复 / 变更 |
| 状态 | 已实现 |
| 日期 | 2026-11-11 |
| 范围 | `src/mcp/tools.ts`（`execute` 预分发 fast-path 门控、`handleProject` 按需建图、`shouldRunInProcessFastPaths`）、`src/mcp/query-pool.ts`（常量导出 + 文档修正） |
| 前置 | 无硬依赖（相关机制来自 #662 query pool / Spec 0032 索引状态机） |
| 非本 spec | 不改 15s 默认值与 [1s, 45s] 钳制语义（保持既有约定）；不做步骤内抢占式取消（见 §5 未来工作） |

---

## 1. 背景与证据

### 1.1 现象

homegraph-verify-kit 评测（81 题、98 次 HG 工具调用，repo 索引 1.2GB / scene_board_ext）观察到多个 >60s 的单次 MCP 工具调用，其中成功调用最长 104s。而工具 deadline 机制（`CODEGRAPH_QUERY_BUSY_TIMEOUT_MS`，默认 15s）应当把所有调用限制在远低于 60s MCP 客户端硬超时的范围内。

### 1.2 根因

工具 deadline 的实现是 `setTimeout` + `Promise.race`（`runReadToolWithDeadline`）。**定时器在事件循环被同步代码阻塞时无法触发**——这是 JS 运行时的基本约束，不是实现 bug。因此任何在 race 之前、或在主线程上同步执行的"真工作"，都完全不受 deadline 保护。审计发现两条泄漏路径：

**泄漏 A：`homegraph_project` 按需建图（同步全仓扫描跑在 transport 线程）。**
`handleProject` 在 `map.modules.length === 0` 时（遗留索引 / CLI init 从未跑过 fast path 的状态）同步调用 `cg.buildProjectMap()`——这是一次完整的目录树扫描 + 模块发现 + 语言检测 + SQLite 写入。实测证据：评测中 Q061 的 `homegraph_project` 调用耗时 81.9s。扫描期间：

- transport 线程被阻塞，MCP 响应无法 flush；
- deadline 的 setTimeout 无法触发（race 还没开始，且即使开始也无法在阻塞期间结算）；
- 客户端 ~60s 硬超时后收到空错误（`-32001`），或 host 记录一个远超 deadline 的墙钟时长。

**泄漏 B：explore/search 预分发 fast-path 块在 deadline race 之前执行。**
`execute()` 在进入 `runReadToolWithDeadline` 之前，于主线程同步运行 `tryPlannedFastPath` / `trySpecializedExploreRoute` / `tryFastInventoryExplore` / `tryLightMechanismExplore` / `tryCompactLocalSymbolExplore`（继承谱系、caller 清单、源码切片等真实 DB/IO 工作）。该块的设计动机是"命名成员/局部紧凑查询在温热主连接上几十毫秒完成"——但 query pool 存在的整个前提就是同步 SQLite/CPU 会冻结 transport。同一份代码注释（`execute` 内、`runReadToolWithDeadline` 头注）既承认了阻塞风险，又在 race 之前保留了一个不受保护的同步块，这是自相矛盾的。实测证据：多个 >60s 的成功 explore 调用均为该 session 唯一一次 HG 调用（Q030 63.1s / Q031 103.5s / Q045 96.2s / Q060 104s / Q062 101.6s / Q092 93.9s），特征与"fast path 未命中、走到慢路径且无 deadline 保护"一致。

### 1.3 为什么不是"调大 deadline"

deadline 的价值在于把不可控的慢调用收敛为 success-shaped busy/partial 指引。泄漏路径上的工作根本没进 race，调大数字无效。正确修复是把慢工作移出主循环，或在移不出去时立即返回指引。

## 2. 方案

### 2.1 修复 A：按需建图后台化

`handleProject` 不再内联扫描：

1. `map.modules.length === 0` → 调用 `startBackgroundProjectMapBuild(cg)`：
   - 单飞守卫（`projectMapBuilding` 布尔字段）：并发首调用只触发一次扫描，不 N 路扇出；
   - 先 `setImmediate` 让步，使调用方的 syncing 回复先 flush；
   - 后台执行 `cg.buildProjectMap()` + 相位推进（原逻辑保留：`none` → `full`/`fast`）；
   - 完成/失败写 stderr 日志，复位守卫。
2. 立即返回 `productIndexGuidance('syncing')`（success-shaped，遵守既有 abandonment 规则：永不 `isError`）。
3. agent 重试的下一次调用读到已持久化的 project map，正常出图。

语义变化：首次对未建图索引调用 `homegraph_project` 的返回从"阻塞 N 秒后出图"变为"立即返回 syncing 指引，图在下一次调用可用"。对 agent 交互模型而言这是一个更好的契约——MCP 客户端在 ~60s 处杀连接，>60s 的"成功"实际上从未被消费。

### 2.2 修复 B：warm pool 时跳过进程内 fast-path 块

提取判定为公开方法 `shouldRunInProcessFastPaths(toolName)`：

```
toolName ∈ {homegraph_explore, homegraph_search}
且 (queryPool 为空 或 非(healthy && ready))
```

- **pool 空闲且温热（healthy && ready）**：跳过主线程 fast-path 块，调用进入 `runReadToolWithDeadline` → pool。worker 内的 `executeReadTool` 仍会运行同样的 fast paths（行为不丢），但现在 soft deadline 真正保护调用——15s 后得到 busy/partial 而非无限等待。
- **pool 冷启动中（ready=false）或崩溃熔断（healthy=false）**：保留 fast-path 块。既有权衡不变：命名成员查询在温热主连接上出结果，优于排在冷 worker 后面。
- **直接/direct 模式（queryPool=null）**：不变。

注意：`runReadToolWithDeadline` 对轻量工具（search/node/callers/callees/files/project）的进程内派发保持不变——这些工具的语义就是"主连接上毫秒级完成"，且 pool 冷开销（第二个完整 DB 打开）远大于收益。本修复只针对 explore（重工具）在 race 之前的同步块。

### 2.3 修复 C：文档与常量对齐

- `DEFAULT_BUSY_TIMEOUT_MS = 15_000`、`MAX_BUSY_TIMEOUT_MS = 45_000` 导出（原先模块内私有，测试无法钉死）；
- `query-pool.ts` 头注与 `QueryPoolOptions.softTimeoutMs` 注释中的过时数字（"default 20s, clamped ≤30s"）修正为 15s / 45s——代码本身已是 15s，注释是历史遗留错误。

## 3. 测试

`test/tool-deadline-leaks-0069.test.ts`（6 用例）：

| 用例 | 钉死的行为 |
| --- | --- |
| 15s 默认值（env 未设） | `DEFAULT_BUSY_TIMEOUT_MS === 15_000`；`resolveBusyTimeoutMs()` / `resolveToolDeadlineMs()` 一致 |
| 60s 误设钳制到 45s | 防止软超时追平 ~60s 客户端硬超时 |
| 首调用立即返回 syncing | 未建图索引上 `homegraph_project` 在 2s 内返回 syncing 指引（旧行为是内联扫描）；重试拿到 Project map |
| 并发首调用单飞 | 3 个并发首调用只触发 1 次 `buildProjectMap()` |
| 温热路径不变 | 已建图索引直接出图，不返回 syncing |
| fast-path 门控谓词 | pool null/cold/unhealthy → 走主线程 fast paths；healthy+ready → 跳过；非 explore/search 工具恒 false |

回归：query-pool / product-index-states / project-map / cooperative-yield / explore 系列（repeat-guard、light-mechanism-partial、multi-type-deps、specialized-routing、output-budget、arkts-query-paths、adaptive-explore-sizing）全绿。

## 4. 兼容性

- 无 schema / CLI / 工具面变更。
- `homegraph_project` 首调语义变化（§2.1）：唯一可观测差异。依赖该工具立即出图的脚本（非 agent 场景）需要重试一次。
- 遗留索引（无 project map 行）在 daemon 模式下通常已由 auto-init 后台建图（engine.ts 路径未动），按需路径主要影响"索引存在但从未跑 fast path"的直接打开场景。

## 5. 未来工作

- `executeQueryPlan` 的步骤间 deadline 检查（`Date.now() >= deadline`）仍是协作式检查点，单个 step 内部的长同步段无法中断。step 内抢占需要把图查询改为分批 + yield（依赖 cooperative-yield 基础设施扩展到查询层），另立 spec。
- pool worker 内的同步段同样无法被 pool 侧 softTimer 抢占（timer 在主循环，worker 阻塞不影响主循环，但该 worker 上的后续排队调用会堆积到 admission 上限）。现状可接受：admission 控制已限制扇出。
