# 0051 — MCP 默认精简工具面（explore / project）


| 字段 | 内容 |
| --- | --- |
| 编号 | 0051 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-28 |
| 范围 | MCP `tools/list` 默认暴露面；`HOMEGRAPH_MCP_TOOLS`；`server-instructions`；explore 工具描述交叉引用；单测与 CHANGELOG |
| 关联 | Spec 0017 / 0023（专用工具与 allowlist）；DevEco Code 集成上下文占比（工具描述默认写入） |
| 非本 Spec | 删除 handler 实现；改索引/查询语义；改 DevEco Code 宿主注入；缩短 explore 正文或 initialize 长文以外的产品 UI |


---

## 1. 背景与目标

DevEco Code 集成后，MCP 工具描述会默认进入模型上下文。全量约 17 个 `homegraph_*` 工具时，tools/list（description + inputSchema）约占 HG 相关表面的大部分；codingeval 轨迹（如 `084_full_local_hg_*`）显示 Agent 几乎只用 `homegraph_explore` / `homegraph_project`，其余工具（含 `arkui_migrate` / `node` / `files` / spec / usages 等）无实质增益或 0 调用。

**目标：**

1. **默认** `tools/list` 只暴露两件套：`homegraph_explore`、`homegraph_project`。  
2. `server-instructions` 与剩余工具描述**不再指向**已默认下线的工具名（含 `homegraph_arkui_migrate`）。  
3. 全量目录与单测仍可通过 `HOMEGRAPH_MCP_TOOLS=all`（或 `*`）/ 显式逗号列表恢复；**不删**现有 handler（含 `arkui_migrate`）。  
4. 工具 schema 体积相对全量显著下降。

---

## 2. 范围

### 2.1 做

- `DEFAULT_MCP_TOOL_SHORT_NAMES` + `resolveMcpToolAllowlist` / `getStaticTools` / `ToolHandler.getTools`：  
  - 未设置或空白 `HOMEGRAPH_MCP_TOOLS` → 默认两件套；  
  - `all` / `*` → 全量定义表；  
  - 逗号短名（或 `homegraph_` 全名）→ 显式子集。  
- 小仓（&lt;500 文件）裁剪：仅在宿主**显式** `HOMEGRAPH_MCP_TOOLS=all`（或 `*`）时仍套用既有 TINY 核心集；默认精简面与显式逗号列表不再二次裁。  
- 重写 `SERVER_INSTRUCTIONS` / `SERVER_INSTRUCTIONS_NO_ROOT_INDEX`：只描述两件套分工；usage/dependency/native 关系归 `homegraph_explore`；不推荐默认不可见的 `arkui_migrate`。  
- `homegraph_explore` 描述去掉指向 `usages` / `modules` / `native` 的句子。  
- vitest 默认 `HOMEGRAPH_MCP_TOOLS=all`，单测继续覆盖全量 handler；allowlist / specialized-routing 断言对齐新默认。  
- CHANGELOG `[Unreleased]`。

### 2.2 不做

- 从源码删除 `homegraph_node` / `search` / `arkui_migrate` / `spec_*` 等实现或 CLI 子命令。  
- 改 explore 检索算法、预算数字或索引 schema。  
- 强制 DevEco 再设一层 allowlist（默认 unset 即精简）。

---

## 3. 行为与约束

### 3.1 `HOMEGRAPH_MCP_TOOLS`

| 值 | `tools/list` | `execute` |
| --- | --- | --- |
| 未设置 / 仅空白 | 两件套 | 非两件套 → disabled（与 list 一致） |
| `all` 或 `*` | 全量（小仓可再 TINY 裁） | 全量允许 |
| `explore,project,…` | 仅列出的短名 | 未列出 → disabled |

短名匹配：`node` 与 `homegraph_node` 等价。ArkUI 迁移场景需显式加入 `arkui_migrate`，或使用 `all`。

### 3.2 默认两件套职责

| 工具 | 用途 |
| --- | --- |
| `homegraph_project` | 工程/模块/Harmony skeleton 与资源**路径**导航，无符号正文 |
| `homegraph_explore` | 未解析的跨符号机制、usage/依赖/NAPI 关系、route/resource/capability 证据 |

指引仍为 path-first / bash-first；HomeGraph 可选，难度本身不强制图查询。

### 3.3 约束

- 默认精简不得把「工具未暴露」伪装成索引故障；disabled 文案沿用既有 allowlist 提示。  
- 显式 allowlist **优先**于小仓 TINY 裁剪（与 Spec 0023 一致）。  
- initialize 指引与 `tools/list` **不得**再推荐默认不可见的工具名。  
- 环境变量写在 **MCP 服务配置的 `environment`** 中（与 `HOMEGRAPH_NO_DAEMON` 同级）；Windows 系统/用户环境变量对 MCP 子进程一般不生效。

---

## 4. 验收标准

- [x] Spec 落盘（本文件）  
- [x] 未设置 env 时 `getStaticTools` / `getTools` 仅为两件套  
- [x] `HOMEGRAPH_MCP_TOOLS=all` 暴露全量；逗号列表可恢复子集（含 `arkui_migrate`）  
- [x] `server-instructions` 不含默认下线工具名（含 `homegraph_arkui_migrate` / `usages` / `modules` / `native` / `node`）  
- [x] explore 描述不再 divert 到 usages/modules/native  
- [x] 相关单测通过；CHANGELOG Unreleased  

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 需要 node/search/arkui_migrate/diff_impact 的外部 Agent 回归 | `HOMEGRAPH_MCP_TOOLS=all` 或显式列表；handler 未删 |
| 小仓 + `all` 仍 TINY 裁掉专用工具 | 显式逗号列表绕过 TINY；文档写明 |
| 指引与 list 不一致导致乱调 | initialize 与 explore 描述同步删交叉引用 |

回滚：将 `resolveMcpToolAllowlist` 在 unset 时改回 `'all'`，并恢复旧 `server-instructions` 文案。
