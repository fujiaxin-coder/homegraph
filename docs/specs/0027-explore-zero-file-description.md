# 0027 — `homegraph_explore` 描述在 0 文件态的措辞修复


| 字段 | 内容 |
| --- | --- |
| 编号 | 0027 |
| 类型 | 缺陷 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-10 |
| 范围 | `src/mcp/tools.ts` `getTools()` 的 explore 描述后缀；单测；CHANGELOG |
| 关联 | [0021](./0021-product-fast-map-and-auto-init.md)（auto-init 快建/全量两段管线与 `build_phase`）；#964（tools/list 单次快照） |


---

## 1. 背景与目标

**现场证据（DevEco Code 评测，3 会话 × 0 次 homegraph 调用）**：宿主在 MCP 连接瞬间请求一次 `tools/list`（#964 记录的常态），此刻 auto-init 尚在建库，`stats.fileCount === 0`，于是 explore 描述被快照为：

> `Budget: make at most 1 calls for this project (0 files indexed).`

模型把 **"(0 files indexed)" 读成终态**——推理原文："so homegraph isn't indexed for this project. I should fall back to read/grep/glob"——**整个会话永久降级**，尽管全量索引数秒后完成（实测 393 文件 / 12458 节点约 6–20 秒）。描述快照永不刷新，误导不可自愈。

这与本仓两条既定原则冲突：

1. **Errors teach abandonment**：响应形态上早已保证SUCCESS-shaped guidance（`maybeDeepToolPhaseGate`），但**描述文本**在会话开始前就教了一次放弃；
2. **Adapt the tool to the agent**：`getExploreBudget(0) = 1` 的预算注记对 0 文件项目毫无意义——没有可预算的检索面。

**目标：**

1. `fileCount === 0` 时，描述后缀**不再出现** "Budget: make at most … (0 files indexed)"；
2. 措辞按真实状态分派，且与**调用时** `maybeDeepToolPhaseGate` 的 SUCCESS-shaped 指引**同源**：
   - `index_state === 'failed'` → 如实告知上次全量构建失败，请转告用户重跑 `homegraph index`（索引是用户的决定，不是 agent 的）；
   - `build_phase !== 'full'` → "still building"，指向 `homegraph_project`，索引完成后重试；
   - `build_phase === 'full'` 且 0 文件 → 如实"本项目尚未索引任何文件，结果为空"；
3. `fileCount > 0` 的预算注记**逐字节不变**（0021 的预算单调性约定不动）。

## 2. 设计

### 2.1 判定顺序（getTools 内，均在现有 try/catch 保护下）

```
fileCount > 0            → 原预算注记（不变）
index_state === 'failed' → 失败注记（转告用户）
build_phase !== 'full'   → 构建中注记（homegraph_project 先行，稍后重试）
其余（full + 0 文件）     → 空项目注记
```

`failed` 先于 `building`：全量失败时 `build_phase` 回落为 `fast`（见 `startInProcessFullIndex` 的 catch），若先判 `!== 'full'` 会把失败伪装成构建中。

### 2.2 与快照时序的相容性

描述被宿主冻结，但新措辞在索引完成后**仍然正确**："retry once indexing finishes" 的行为终点是真实结果；旧措辞 "(0 files indexed)" 的终点是永久放弃。快照会过时，但不会说谎。

### 2.3 显式非目标

- 不改 `getExploreBudget` / `getExploreOutputBudget` 的档位（0021 约定）；
- 不做 `notifications/tools/list_changed` 推送（宿主支持度不一，另行评估）；
- 不改 `maybeDeepToolPhaseGate` 的调用时指引（描述向它对齐，不是反向）。

## 3. 验收

1. `fileCount === 0`（各 phase / index_state 组合）描述不含 `(0 files indexed)`、不含 `Budget: make at most`；
2. 构建中注记包含 `homegraph_project` 与重试指引；
3. `fileCount > 0` 描述与旧版逐字节一致；
4. 注解（readOnlyHint 等，#1018）在描述改写后存活；
5. `npm test` 全绿。
