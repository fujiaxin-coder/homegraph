# 0021 — 产品宿主快建 / 全量索引与 `homegraph_project`


| 字段 | 内容 |
| --- | --- |
| 编号 | 0021 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-03 |
| 范围 | MCP auto-init；快建 project map；`homegraph_project`；schema v11；watch 固定窗口；全量子进程；相关测试与指引 |
| 关联 | DevEco Code 产品内嵌（vendor + `--auto-init`，仓外）；`server-instructions.ts` |


---

## 1. 背景与目标

DevEco Code 等产品宿主需要把 HomeGraph 做成**默认能力**（非用户手配 MCP）：打开未索引工程时自动建库，并尽快给出工程地图，再后台补全符号图。原先 auto-init 直接在 MCP 进程内 `indexAll`，大仓会堵死 stdio，宿主报 `MCP connection closed`。

**目标：**

1. **快建（秒级）**：模块边界 + 源文件清单，可供 Agent 立刻查询。  
2. **全量（后台）**：现有符号 / 边索引，不阻塞 MCP 工具面。  
3. **新工具 `homegraph_project`**：读浅层工程地图；全量未完时深层工具给出可恢复指引（非 `isError`）。  
4. **产品策略**：`--auto-init` / `HOMEGRAPH_AUTO_INIT`；watch 可选固定窗口（如 5 分钟，首变启动、不延长）。

---

## 2. 范围

### 2.1 做（本仓 HomeGraph）

- CLI / MCP：`--auto-init` 与 `HOMEGRAPH_AUTO_INIT`；daemon 派生子进程时透传 `--auto-init`。  
- 无 `.homegraph/` 时：建库 → 快建 project map → 标记 `build_phase` → **detached** `homegraph index` 全量（MCP 进程保持响应）；打开已有库时 heal 卡住的 phase。  
- Schema v11：`project_modules` / `project_module_files`；metadata：`build_phase`（`none|building_fast|fast|indexing|full`）等。  
- `HomeGraph.buildProjectMap` / `getProjectMap` / `getBuildPhase`；扫描优先 Harmony `build-profile`，否则 ohpm / workspace。  
- MCP 工具 `homegraph_project`；深层工具在无符号且 phase≠full 时 success 形指引。  
- Watch：`HOMEGRAPH_WATCH_FIXED_WINDOW_MS` → `fixedWindow`（首事件启动定时器，后续只累积、不重置）。  
- `server-instructions` 提及 `homegraph_project`；单测覆盖 project-map 与 fixedWindow。  
- CHANGELOG `[Unreleased]` 用户向说明。

### 2.2 不做

- DevEco Code 仓内 vendor 同步 / 打包 / 安装脚本（产品侧独立）。  
- 把假符号写入 `nodes`/`edges` 充当快建。  
- 改默认 debounce 行为（无 `HOMEGRAPH_WATCH_FIXED_WINDOW_MS` 时仍为原 debounce）。  
- 强制用户关闭自动更新或其他宿主版本策略。

---

## 3. 行为与约束

| 场景 | 行为 |
| --- | --- |
| 产品 MCP 带 `--auto-init`，工程无 `.homegraph/` | 创建 DB；快建后 `build_phase=fast`；spawn 后台 `index`；MCP 可继续 listTools / `homegraph_project` |
| 快建完成、全量未完 | `homegraph_project` 可用；无节点时 explore 等提示仍在 indexing，建议用 project 或稍后重试 |
| 全量完成（`index_state=complete|partial`） | `build_phase=full`（轮询或 open 时 heal） |
| `HOMEGRAPH_WATCH_FIXED_WINDOW_MS=300000` | 首次变更启动 5min 窗口；窗口内后续变更不延长；到期增量 sync |
| 旧库无 project map | `homegraph_project` 可按需扫描写入 |

**约束：** 可恢复条件不得用 `isError`（避免 Agent 放弃 HomeGraph）。全量优先 detached，spawn 失败可回退同进程 `indexAll`。

---

## 4. 验收

- [x] Spec 落盘；实现与本文一致（代码已先行，按 DEVELOPMENT §1.4.1 收尾）。  
- [x] schema / migration **v11** 含 project map 表；`CURRENT_SCHEMA_VERSION === 11`。  
- [x] `--auto-init` / `HOMEGRAPH_AUTO_INIT`：无索引工程可建库 + 快建 + 后台全量。  
- [x] 全量默认 **detached**，避免大仓堵死 MCP stdio。  
- [x] `homegraph_project` 注册并可返回模块→文件地图；phase 门控为 success 形指引。  
- [x] `HOMEGRAPH_WATCH_FIXED_WINDOW_MS` 固定窗口行为有单测。  
- [x] `test/project-map.test.ts` 通过；`server-instructions` 已提及 project。  
- [x] CHANGELOG `[Unreleased]` 已写；提交 footer 关联本 Spec。

---

## 5. 状态

**已完成** — 快建表 + `homegraph_project` + auto-init（快建后 detached 全量）+ 固定窗口 watch + heal `build_phase`；测试见 `test/project-map.test.ts`、`test/watcher.test.ts`（fixedWindow）；产品侧 DevEco vendor 集成不在本 Spec 合入范围。
