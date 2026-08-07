# 0005 — MCP 图谱数据源开关（`--sources` / `HOMEGRAPH_SOURCES`）

| 字段 | 内容 |
| --- | --- |
| 编号 | 0005 |
| 类型 | 需求 |
| 状态 | 已完成 |
| 日期 | 2026-08-07 |
| 范围 | MCP `serve mcp` 运行时是否使用工程库（项目 `.homegraph` 主图）与/或 SDK 库（`~/.homegraph/api` OHOS API ATTACH）；CLI/env；daemon 隔离；status 暴露；测试与文档 |

---

## 1. 背景与目标

HomeGraph 查询侧有两类数据：

1. **工程库（project）**：项目 `.homegraph/homegraph.db` 中的符号与边  
2. **SDK 库（sdk）**：`~/.homegraph/api/ohos-api-*.db`，经 `ATTACH DATABASE … AS ohos_api` 联邦进查询  

增量开发评测需要四臂对比：不挂 MCP / 只 SDK / 只工程 / 双开。用户与脚本需要**一个好拧的旋钮**，默认行为与今日一致（双开）。

**目标：**

1. 对外一个模式枚举：`both | project | sdk | none`，默认 `both`  
2. 正式入口：`homegraph serve mcp --sources <mode>`；同义环境变量 `HOMEGRAPH_SOURCES`（未传 CLI 时生效）  
3. 优先级：`--sources` > `HOMEGRAPH_SOURCES` > `both`  
4. 不同 `sources` 不共用同一 MCP daemon（避免评测臂串台）  
5. `homegraph status` / `homegraph_status` 能看到当前生效模式  

---

## 2. 范围

### 2.1 纳入

- `src/graph-sources.ts`：解析与标志位  
- `serve mcp` CLI `--sources`；启动时写入/尊重 `HOMEGRAPH_SOURCES`  
- `HomeGraph` open 路径：按模式决定是否 ATTACH SDK；工程关闭时查询不返回主库节点  
- `sources=none`：MCP 不打开工程图；工具成功态 guidance（非 `isError`）  
- daemon socket / pid 路径按 sources 隔离（`both` 保持现有 `daemon.sock` / `daemon.pid` 路径以兼容）  
- 单测 + README / local-dev-guide / CHANGELOG `[Unreleased]` 短说明  

### 2.2 不纳入

- 不改变 `init` / `index` 是否构建 SDK db（开关只管 **MCP/查询运行时**）  
- 不改 Commit4Spec / `commit4spec.db`  
- 不要求 GitCode CI  
- 不强制 installer 写入 `--sources`（默认双开即可）  

---

## 3. 行为与约束

### 3.1 模式语义

| 模式 | 工程主图节点 | SDK `ohos_api` ATTACH / 查询 |
| --- | --- | --- |
| `both`（默认） | 是 | 是（与今日一致） |
| `project` | 是 | 否 |
| `sdk` | 否（仍打开项目 db 以读取绑定元数据并 ATTACH） | 是 |
| `none` | 不打开 HomeGraph | 不 ATTACH |

`sdk` 仍要求项目已 `homegraph init`（存在 `.homegraph/`），以便解析 OHOS API 版本与 db 路径；只是答案里不出现工程符号。

### 3.2 配置

```text
homegraph serve mcp --sources sdk
HOMEGRAPH_SOURCES=project
```

非法值 → 启动失败（CLI stderr + 非 0），或库 API 抛错；不静默回落。

### 3.3 Daemon

`spawnDetachedDaemon` 必须把生效的 `--sources` 传给子进程。  
`sources !== both` 时使用独立 pid/socket 命名（或 hash 含 sources）；`both` 保持旧路径。

### 3.4 工具错误形态

`none` 或当前模式导致无可用图时：返回 **success-shaped** 文本说明如何打开对应源，**不要** `isError: true`。

---

## 4. 验收标准

- [ ] `--sources` 与 `HOMEGRAPH_SOURCES` 解析单测（含优先级、非法值）  
- [ ] `project` 不 ATTACH；`sdk` 搜索结果不含工程节点；`both` 与现网一致  
- [ ] `none` 下 MCP 工具不抛 isError，有明确 guidance  
- [ ] 不同 sources 的 daemon 路径不同；`both` 路径与改前一致  
- [ ] status 输出含 `Graph sources: …`  
- [ ] 文档与 CHANGELOG `[Unreleased]` 已更新  

---

## 5. 参考

评测脚本示例：

```bash
# 只 SDK
HOMEGRAPH_SOURCES=sdk homegraph serve mcp --path "$APP"
# 或
homegraph serve mcp --path "$APP" --sources project
```
