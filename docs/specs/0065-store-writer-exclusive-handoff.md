# 0065 — Fresh-index store-worker 独占交接（关主连接后再写）

| 字段 | 内容 |
| --- | --- |
| 编号 | 0065 |
| 类型 | 修复 |
| 状态 | 已完成 |
| 日期 | 2026-11-04 |
| 范围 | `DatabaseConnection` 独占交接 API；`HomeGraph.indexAll` → `ExtractionOrchestrator` store-worker 启停；`feed` 背压在 `flushError` 时抛出；单元测 `spec-0065-store-writer-handoff` |
| 非本 Spec | 把 ArkTS Scene 迁入 worker_thread；拉长全局 `busy_timeout`；改 FileLock / daemon 生命周期；`HOMEGRAPH_ARKTS_ISOLATED` 行为 |

---

## 1. 背景与目标

Fresh 全量索引在 ArkTS（及 metadata / bulk 窗口）阶段用**主线程连接**写库，随后为叠 parse∥INSERT 再开 **store-worker 第二条连接**。两阶段本应串行，但主连接在 Phase B 仍开着；在 `journal_mode=MEMORY` / wasm DELETE、Windows 等路径上，worker 写库易 `SQLITE_BUSY`。`flushOrdered` 只记 `flushError` 不抛出时，`feed` 背压变成微任务空转 → CPU 100% 假死，`index_state` 停在 `indexing`。

**目标：** store-worker 活跃期间主连接必须关掉（独占写）；worker 结束后再按 bulk 窗口友好方式重开并 `rebind`；store 失败时索引失败退出而非忙等。

---

## 2. 范围

### 2.1 做

- `DatabaseConnection.closeForExclusiveWriter` / `reopenAfterExclusiveWriter({ fastInit })`：关柄交给独占写者；重开**不**跑 `open()` 的 `healBulkNodeLoad`（避免中途结束 bulk FTS 窗口）；`fastInit` 时恢复 MEMORY/OFF。
- Fresh + store-worker：创建 worker **之前** `release`；worker `close` 之后（含失败/abort 路径）`reclaim` + `QueryBuilder.rebind`；若 graph sources 含 SDK，reclaim 后 `restoreOhosApiDbAttach`（ATTACH 随连接关闭丢失）。
- `feed` 背压循环：`flushError` / `aborted` 时立即 throw，禁止 `await` 空 resolve 空转。
- 单测：交接后第二连接可写、reopen 可读回；背压 guard 在 `flushError` 时抛出。

### 2.2 不做

- 不把 ArkTS Scene/persist 改到 worker_thread。
- 不强制 `HOMEGRAPH_NO_STORE_WORKER`；kill switch 仍可用。
- 不在本 Spec 修多进程 daemon 占库（仍靠 FileLock / 用户停 daemon）。

---

## 3. 行为

| 场景 | 结果 |
| --- | --- |
| Fresh index 启用 store-worker | 主连接在 worker `open` 前已 close；worker 期间主线程不访问 DB |
| Worker drain/close 正常或异常 | 主连接 reopen（保留 fastInit pragma 语义）+ queries rebind；随后 `endBulk*` 仍可用 |
| 未启用 store-worker | 不 release；行为与改前一致 |
| Store 写入失败置 `flushError` | 背压循环抛出该错误；不出现持续 CPU 忙等 |

---

## 4. 验收

- [x] Spec 落盘
- [x] 独占交接 API + indexAll 接线；背压 `flushError` 抛出
- [x] `spec-0065-store-writer-handoff` 测例通过
- [x] CHANGELOG `[Unreleased]` 有条目
