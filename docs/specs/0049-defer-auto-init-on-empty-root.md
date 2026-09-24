# 0049 — 空仓延后 MCP auto-init（不抢建 `.homegraph`）


| 字段 | 内容 |
| --- | --- |
| 编号 | 0049 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-23 |
| 范围 | MCP `--auto-init` / `HOMEGRAPH_AUTO_INIT`：空根不建库；定时探测；工具调用踢醒；单测与 CHANGELOG |
| 关联 | Spec 0021 / 0032（auto-init 快建+全量）；DevEco Code 原地 `devecocli create` 被 `.homegraph` 挡成 `PROJECT_EXISTS` |
| 非本 Spec | 改 DevEco Code；改 CLI `homegraph init`（显式 init 仍可建空库）；改 create/`--merge` 语义 |


---

## 1. 背景与目标

DevEco Code 挂 MCP 即 `--auto-init`。评测/新建场景下工作区先是**空目录**，auto-init 立刻写出 `.homegraph/`，随后 `devecocli create --project-path .` 因目录非空失败，Agent 多耗一轮 `--merge`（0922 task_2 等，全套常见）。

**目标：**

1. 空根：**不创建** `.homegraph/` / DB。  
2. MCP 进程仍存活时：**定时探测**；一旦可索引则跑**既有** auto-init（建库 → fast map → 后台 full）。  
3. 任意 `homegraph_*` 调用：若仍延后，**立即再探测**；已可索引则立刻 init，回复复用现有 `status=empty` / `fast` / … 门控文案。  
4. **不改** DevEco Code 注入方式。

---

## 2. 范围

### 2.1 做

- 导出 `isIndexableRoot(root)`：判定根是否已有可索引工程迹象（见 §3）。  
- `MCPEngine.tryAutoInit`：不可索引 → 不建库，武装 defer 探测；可索引 → 清探测，走现有建库路径。  
- 定时器：默认 **60s**（`HOMEGRAPH_DEFER_PROBE_MS` 可配；`0` = 仅工具踢醒、不定时）。每次同一 `isIndexableRoot`；成功 init **一次**后停表。  
- 工具路径：`retryInitIfNeeded` / 等价入口在无默认图时调用 `kickDeferredAutoInit`（立即探测 + 可能 init）。  
- `engine.stop` 清除定时器。  
- `appendProjectDaemonLog`：**若尚无** `.homegraph/` 目录则只写 stderr、不 mkdir（避免日志抢建占坑）。  
- 单测 + CHANGELOG `[Unreleased]`。

### 2.2 不做

- 新增产品态名字（不引入独立 `deferred` 对外状态；无库时继续 NotIndexed / 现有 empty 指引）。  
- 文件 watcher 在无 `.homegraph` 时监视空根（可选后续；本 Spec 用 timer + 工具踢醒即可）。  
- 把已存在的空 `.homegraph` 自动删掉（历史脏目录不在范围）。

---

## 3. 行为与约束

### 3.1 `isIndexableRoot(root)` 为真当且仅当（短路）

1. 根存在 `build-profile.json5`，或  
2. 在忽略目录（含 `.homegraph` / `node_modules` / `oh_modules` / `.git` / 常见 build 输出）之外，有界 walk 发现至少一个 `isSourceFile` 路径。

Walk 有目录/深度预算，探测必须廉价（适合 60s tick 与每次工具踢醒）。

### 3.2 场景表

| 条件 | 行为 |
| --- | --- |
| `--auto-init` + 空根 | 不建 `.homegraph`；武装 defer；stderr 说明 deferred |
| 定时/踢醒后变可索引 | **一次**既有 auto-init；停表 |
| 工具调用时仍空 | 不建库；既有「未索引 / status=empty」类 success 指引 |
| 工具调用时已可索引 | 立即 auto-init；首轮工具见 `building_fast`→`status=empty`（retry shortly）等既有门控 |
| 显式 CLI `homegraph init` | **不变**（仍可建空库） |
| `HOMEGRAPH_DEFER_PROBE_MS=0` | 不定时，仅工具踢醒 |

**约束：** 延后路径不得 `isError`；建库后状态机与 Spec 0032/0035 一致。

---

## 4. 验收标准

- [x] Spec 落盘  
- [x] 空根 auto-init 不创建 `.homegraph` / db  
- [x] `isIndexableRoot` 单测（空 / build-profile / 源文件）  
- [x] 延后后再放源文件：kick 或探测后会 init  
- [x] CHANGELOG Unreleased  

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 60s 内 Agent 已要检索 | 工具踢醒立即探测，不等下一拍 |
| 误判「空」（忽略过严） | 有 `build-profile` 即真；可调 walk 预算 |
| 定时器泄漏 | `stop()` 与成功 init 清表 |

回滚：去掉 defer 闸门，恢复「无索引即建库」。
