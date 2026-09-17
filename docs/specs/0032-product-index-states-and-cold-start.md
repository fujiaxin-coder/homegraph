# 0032 — 产品四态索引返回与 auto-init 冷启动收敛


| 字段 | 内容 |
| --- | --- |
| 编号 | 0032 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-14 |
| 范围 | MCP 工具四态返回（empty/fast/full/syncing）；auto-init 冷启动建库与竞态 open；写锁探测；单测与 CHANGELOG |
| 关联 | [0021](./0021-product-fast-map-and-auto-init.md)；DevEco Code 产品宿主（仓外，本 Spec 不含其改动） |


---

## 1. 背景与目标

产品宿主（如 DevEco Code）挂上 MCP 即 `--auto-init`。Agent 需要稳定知道「现在能不能用、用哪类工具」，而不是猜索引是否建好。现有 `build_phase` 门控文案不统一；冷启动在尚无 `.homegraph/` 时可能短暂多进程竞态 init，输家未可靠 open。

**目标：**

1. **四态返回**：对外统一 `empty` / `fast` / `full` / `syncing`；工具结果 success 形提醒；**不**按态隐藏 `tools/list`。  
2. **冷启动**：先尽快建空库；`building_fast` 立即落盘；竞态输家 **open 已有库**（含「已初始化却未 open」路径）。  
3. **写冲突**：他进程持有 `homegraph.lock` 或本进程正在 index/sync 写库时，可读路径归为 `syncing`，不死等锁。

---

## 2. 范围

### 2.1 做（本仓 HomeGraph）

- 新增产品态解析与固定文案（`empty|fast|full|syncing`），供深工具门控、`homegraph_project`、explore 0-file 描述对齐。  
- `FileLock` 可探测「他进程持锁」；`HomeGraph` 暴露写锁探测供 MCP 使用。  
- `HomeGraph.init`：在 `.homegraph/` 就绪后用 `homegraph.lock` 串行化空库创建；输家抛「已初始化/锁定」供上层 open。  
- MCP `tryAutoInit`：已初始化 → open；init 成功后立即 `building_fast`；竞态失败 → 短重试 open；**快建**同进程同步完成；**全量**同进程后台 `indexAll`（可 yield，不拉 sibling CLI）；watch 延后到全量完成。  
- 工具执行遇 `SQLITE_BUSY` / database is locked → success 形 `syncing` 文案（非 `isError`）。  
- 单测 + CHANGELOG `[Unreleased]`。

### 2.2 不做

- 模块级 sync 新策略；双库；改 DevEco Code 仓。  
- 改 agent prompt / 大改 `server-instructions` 以「提高触发率」。  
- 隐藏未就绪工具；引入用户环境变量作为产品默认开关。

---

## 3. 行为与约束

| 场景 | 行为 |
| --- | --- |
| `building_fast` / `none`，无地图 | 产品态 `empty`；深工具与 `homegraph_project` 提示稍后重试 |
| `fast` / `indexing`，地图可用 | 产品态 `fast`；深工具（尚无符号节点时）引导 `homegraph_project`；project 返回地图并标明全量未完 |
| `full` | 产品态 `full`；深工具正常 |
| `full`（或可读库）但 `homegraph.lock` 被他进程持有 / 本进程 `isIndexing` / 读遇 BUSY | 产品态 `syncing`；success 形「写库中，稍后重试」 |
| 双进程同时 auto-init | 一进程建成空库；另一进程 open 已有库并继续；不双写建库死等 |
| 全量构建（auto-init） | **同一 MCP/daemon 进程**后台 `indexAll`（解析走现有 worker 线程，主线程 yield）；不 spawn `homegraph index` 子进程；watch 延后到全量完成 |
| `tools/list` | 始终暴露默认工具面（延续 #964） |

**约束：** 可恢复条件不得用 `isError`。内部 `build_phase` 枚举保留；产品四态为 MCP 对外语义层。

---

## 4. 验收

- [x] Spec 落盘；实现与本文一致。  
- [x] 四态文案有单测；深工具 / project 门控与态一致。  
- [x] 冷启动：init 后立即为 `building_fast`；竞态路径可 open。  
- [x] 他进程持写锁时深工具得 `syncing`（非死等）。  
- [x] BUSY 捕获为 success 形 `syncing`。  
- [x] CHANGELOG `[Unreleased]` 已写；提交 footer 关联本 Spec。

---

## 5. 状态

**已完成** — `src/mcp/index-availability.ts` + 深工具/`homegraph_project`/BUSY 门控；`FileLock.isHeldByOther` + `HomeGraph.isWriteLockedByOther`；`init`/`initSync` 建库锁；`tryAutoInit` 竞态 open + 立即 `building_fast`；测试见 `test/product-index-states.test.ts`。
