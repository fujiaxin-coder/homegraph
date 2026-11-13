# 0068 — 跨进程写锁可靠性、索引状态可诊断、daemon 建图锁冲突修复

| 字段 | 内容 |
| --- | --- |
| 编号 | 0068 |
| 类型 | 缺陷修复 / 变更 |
| 状态 | 已实现 |
| 日期 | 2026-11-12 |
| 范围 | `src/utils.ts`（`FileLock`）、`src/bin/homegraph.ts`（`status` / `sync` / `init` / `unlock`）、`src/index.ts`（`getLockInfo` / `init` 撞锁诊断）、`src/extraction/index.ts`（`SyncResult.lockUnavailable`）、`src/mcp/daemon.ts`（idle 门闩 + stall guard）、`src/mcp/engine.ts`（后台建图 abort + query pool 时序）、`src/mcp/index.ts`（async stop 适配）；测试 `test/security.test.ts`、`test/daemon-idle-watchdog-0047.test.ts`；CHANGELOG |
| 前置 | Spec 0032（产品索引状态机）、Spec 0047（daemon idle 与建图门闩）、Spec 0065（store-worker exclusive handoff） |
| 非本 Spec | DevEco Code / ProjectSpec 侧的任何代码改动（该仓库不可动）；`FileLock` 的路径级删除语义（保留 `unlink` 作为死锁清理手段） |

---

## 1. 背景与证据

DevEco Code 已内置 HomeGraph MCP（`--auto-init`），同时 ProjectSpec 生成架构文档前会通过 bootstrap 工具再 spawn 一个 HomeGraph CLI 进程做健康检查与建图。两者共享同一个 `.homegraph/`，在现场表现为：

```
HomeGraph automatic clean initialization failed:
EBUSY: resource busy or locked, unlink '...\.homegraph\homegraph.db'.
Original failure: HomeGraph index is incomplete, corrupt, or incompatible: {"state":"indexing", ...}
```

macOS/Linux 上同一缺陷不报 "in use"，而是 `index is incomplete` / `database is locked`。

分析后定位四个独立缺陷，其中第 1 条是根：**所有缺陷都必须在 HomeGraph 侧修复**，下游不做任何适配。

### 1.1 `FileLock` 会撬掉活进程的锁（根因）

`src/utils.ts` 的锁过期判定是 `lockAge < 2min && pidAlive` 才算"被持有"——**持锁方从不刷新 lock 文件的 mtime**，所以任何超过 2 分钟的合法索引（大仓库必然超）都会被后来者 `unlink` 抢锁。此时两个 writer 同时写同一个 DB：

- WAL 下立刻 `database is locked`，或 `index_state` 元数据互相覆盖；
- 索引被打断，`index_state` 永久停在 `indexing`，下游判"损坏"→ 删库 → Windows `EBUSY`。

即 macOS 上的 "database is locked" 不是"没有锁"，而是**锁自己把自己撬了**。

### 1.2 正常在途状态被当作损坏

`index_state = 'indexing'` 是 `indexAll` 在**开始**时写入、结束时才替换的标记（`src/index.ts:610`，结束写 `complete`/`partial`/`failed`）。下游无法区分"别人正在建图"与"上次建图被杀了"，只能都当损坏处理。

### 1.3 CLI 退出码系统性撒谎

- `sync()` 拿不到锁时返回零值 shape（`src/index.ts`），CLI 见 `totalChanges === 0` 打印 `Already up to date` 并 **exit 0**——调用方无从分辨"没有变更"与"没拿到锁"。
- `init` 的 `printIndexResult` 在 `!result.success` 时不设非零退出码（对比 `index` 命令有 `process.exit(1)`）。
- `init` 在已初始化工程直接 "Already initialized" + exit 0，即使索引缺失/在途/不完整。
- `init` 撞上活锁被吞成 "already initialized"，掩盖真实原因。

### 1.4 daemon 内部两个 writer 抢锁（Spec 0065 回归）

daemon 模式 `queryPool: true`，`runAutoInitCreate` 在建图**之前**就 `maybeStartPool(root)`。fresh init 的 `fastInit` 把主连接设为 `journal_mode = MEMORY`（全库锁），query pool worker 打开第二个连接，store worker 想独占写 → `store worker: database is locked`，**后台建图 100% 失败**。

实测对比（同一 fresh-init 场景，仅切 query pool）：

```
pool on : full build complete=false | database-locked=true   ← 修复前
pool off: full build complete=true  | database-locked=false
```

时间线确认这是 **1.6.4 引入的回归**：1.6.3 无 store-worker（主线程自己写），pool worker 是只读连接，WAL 下与写者并存无冲突；1.6.4 的 `9eb26eb` 引入 store-worker + exclusive handoff，但只在 `indexAll` 内加 handoff，没调整 engine 的 pool 启动时序。错误被 `startBackgroundFullBuild` 的 catch 吞成一行 stderr 并降级到 `fast`，工具继续用 fast map 工作，**看起来没坏**——这是它长期未被发现的原因。

### 1.5 daemon 建图阻塞 idle 无上限

Spec 0047 规定"refcount=0 且建图中则延后 idle 退出"，但**没有上限**：建图卡死或异常耗时会让 daemon 永久占内存，与"关闭宿主后释放内存"的产品目标冲突。同时，直接杀进程会在写库中途关 DB（fresh init 的 MEMORY journal 下尤其危险）。

---

## 2. 方案

### 2.1 `FileLock` 改为 PID 活性优先

`acquire()` / `isHeldByOther()` / 新增 `inspect()`：**PID 活着就是持有者，mtime 不参与判定**。`STALE_TIMEOUT_MS` 从 2 分钟改为 30 分钟，且仅作为 **PID 复用兜底**（文件极老 + PID 恰好存活 ⇒ 视为被回收的 PID 冒名，可撬）。`isProcessAlive` 遇 `EPERM` 视为存活（与其他用户进程一致）。

> 持锁方不刷新 mtime，所以 mtime 与"锁是否有效"零相关。2 分钟去撬活锁是纯 bug。

### 2.2 `status --json` 暴露锁状态与建议动作

新增字段（原有字段一个不删）：

```json
{
  "lock": { "present": true, "heldByOther": true, "pid": 12345, "ageMs": 4200, "stale": false },
  "buildPhase": "indexing",
  "index": { "...": "...", "action": "wait" }
}
```

`index.action` 优先级（机器可读，下游无需猜 `index_state` 语义）：

| action | 条件 | 含义 |
| --- | --- | --- |
| `wait` | 锁被他人持有，或 buildPhase ∈ {indexing, building_fast} | 别人正在建图，等着，**不要动手** |
| `index-inplace` | `index.state === 'indexing'` 且无锁 | 上次被杀，原位重建即可自愈 |
| `reindex` | `index.state` ∈ {failed, partial} | 真损坏，全量重建 |
| `recreate` | `builtWithExtractionVersion < 当前` | 引擎升级，需重建 |
| `sync` | 索引完整但有 pending changes | 增量同步 |
| `none` | 全部就绪 | 无事可做 |

人类可读输出新增 `Index Lifecycle: Build Phase / Write Lock` 段。

### 2.3 退出码与状态如实

- `SyncResult` 新增 `lockUnavailable?: boolean`。`sync` 拿不到锁返回该标记；CLI 见到即 **exit 1**，不再打 "Already up to date"（quiet 模式同样 exit 1）。
- `init`：`!result.success` 时 `process.exitCode = 1`。
- `init` 在已初始化工程：读取真实 `index.state` + `pendingChanges`，不 ready 则 `exit 1` 并提示具体原因（不再无条件成功）。
- `init` 撞锁：抛出携带真实原因的 "Cannot initialize <root>: locked by another process (PID N, lock age Ns)"，不再伪装成 "already initialized"。
- `unlock`：先读 PID，**活进程持有则拒绝删除**（exit 1）——删除活锁 = 开第二个 writer。死锁/无效锁照常清理。

### 2.4 daemon 建图 idle 门闩 + 10 分钟 stall guard

保留 Spec 0047 语义（refcount=0 且建图中 → 等建完再 idle 退），新增上限：

- 首次进入 build-poll 分支记 `indexBlockingIdleSince`；等待超过 `HOMEGRAPH_DAEMON_INDEX_STALL_TIMEOUT_MS`（默认 **10 分钟**，`0` = 关闭上限）即 `stop('index stall guard')`。
- 建图结束或客户端连入时重置该时间戳。
- 决策逻辑抽为纯函数 `decideIndexStallAction`，便于单测。

**berthed 中断而非强杀**：`engine.stop()` 改为返回 `Promise<void>`，先把 `AbortController.abort()` 传给后台 `indexAll({ signal })`，等索引在下一个文件批次 yield 点停下（该点 DB 事务已提交、状态一致），再关 DB。daemon 的 `stop()` 改为 `await this.engine.stop()`。实测闭环：abort 后 DB 无损坏、可正常重开、`index --inplace` 重建成功。

### 2.5 query pool 延迟到建图完成后启动

`runAutoInitCreate` 不再在建图前 `maybeStartPool`；改到 `startWatchingAfterAutoInit`（建图完成/放弃后的回调）里启动。open 路径（已有库、WAL）保持原时序——那里没有 fresh-init 的 MEMORY journal 独占问题。

---

## 3. 行为摘要

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 索引跑 5 分钟，另一进程来抢锁 | 撬锁 → 双 writer → `database is locked` | PID 活着 → 拒绝，报 PID 与锁龄 |
| 索引在途，下游查状态 | 只有 `state=indexing`，只能猜 | `action=wait`，明确"等着" |
| 索引被杀，下游查状态 | 只能猜 | `action=index-inplace`，明确"原位重建" |
| sync 拿不到锁 | exit 0 "Already up to date" | exit 1 + 明确原因 |
| init 索引失败 | exit 0 | exit 1 |
| init 撞活锁 | "already initialized" | 报真实 PID 与锁龄 |
| `unlock` 时有活进程持锁 | 无条件删除（引爆） | 拒绝删除并提示 |
| 关窗时索引在建 | 等建完，**无上限** | 等建完 + 60s，**上限 10 分钟** |
| 上限到期 | （不存在） | 优雅 abort 索引后退出，DB 保持一致 |
| daemon 首次打开新工程 | 后台建图 100% 失败（pool 抢锁） | 建图成功，pool 在建图后启动 |

---

## 4. 验收标准

- [x] `FileLock`：老 mtime + 活 PID ⇒ 拒绝；死 PID ⇒ 清理；超过 30 分钟 + 活 PID ⇒ 允许（PID 复用兜底）
- [x] `inspect()` 报告持有人 pid / age / stale
- [x] `status --json` 含 `lock` / `buildPhase` / `index.action`，原有字段不变
- [x] `sync` 锁失败 exit 1；`init` 失败 exit 1；`init` 不谎报已初始化
- [x] `unlock` 拒绝活锁、清理死锁
- [x] idle 门闩保留；stall guard 默认 10 分钟，`0` 关闭
- [x] abort 后 DB 无损坏、可重开、可 `--inplace` 重建
- [x] fresh-init 下 query pool 延迟启动，后台建图成功（修复回归）
- [x] `test/security.test.ts`（52 过 / 2 skip）、`test/daemon-idle-watchdog-0047.test.ts`（11 过）、`test/product-index-states.test.ts`（14 过）、`test/mcp-daemon.test.ts`（8 过 / 1 skip）
- [x] `tsc --noEmit` 与 `npm run build` 干净

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| PID 复用导致误判"锁被持有" | 30 分钟 reuse floor 兜底；`unlock` 提供人工出口 |
| `status --json` 新字段破坏下游解析 | 纯追加，不删不改任何既有键 |
| `sync` 从 exit 0 变 exit 1 影响既有脚本 | 只在"拿不到锁"这一原本静默失败的路径上改变；这是修正而非破坏 |
| stall guard 杀掉超大仓库的建图 | 默认 10 分钟可调；`HOMEGRAPH_DAEMON_INDEX_STALL_TIMEOUT_MS=0` 回到 Spec 0047 行为；中断后下次 open 自愈 |
| pool 延迟启动降低首屏查询并发 | 仅 fresh-init 路径；建图完成后立即启动，热路径（已有库）零变化 |

回滚：`FileLock` 恢复 2 分钟判定、`status` 去掉新字段、退出码恢复原状、daemon 恢复无上限等待、`maybeStartPool` 移回建图前。

---

## 6. 附：本 Spec 暴露但未纳入的独立问题

- **`init` 的 60 秒超时属于 DevEco/ProjectSpec 侧**（`bootstrap.ts` 的 `Bun.spawn` 超时），不在 HomeGraph 仓库内，本 Spec 不处理。
- **`rmSync` 删库的调用方**同在 ProjectSpec 侧；HomeGraph 已通过 `--inplace` 与 `recreate()` 的人话报错提供安全替代，下游改用即可。
