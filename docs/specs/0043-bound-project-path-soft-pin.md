# 0043 — 绑定根下 `projectPath` 软钉死（不换库）


| 字段 | 内容 |
| --- | --- |
| 编号 | 0043 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-21 |
| 范围 | MCP 已加载默认工程根时，`projectPath` 解析到其它索引根则钉回绑定根 + 英文提示；单测与 CHANGELOG |
| 关联 | Spec 0028（`--path` 地板，祖先劫持）；Spec 0038（工程根文首提示）；codingeval 076 Exp_018：agent 传 sibling `076_retry_…` 而 MCP `--path` 为 `076_wip_…` |
| 非本 Spec | 无默认工程时的跨仓 `projectPath`；硬拒绝 / `isError`；按字符串父子路径猜根；嵌套 monorepo 子索引例外白名单 |


---

## 1. 背景与目标

MCP 以 `--path`（或等价默认打开）绑定工程根 `R` 后，工具仍接受可选 `projectPath`。Agent 常传入 **兄弟仓 / 父目录 / 错误绝对路径**；`getHomeGraph` 会 `findNearestHomeGraphRoot(P)` 并 **打开另一份** `.homegraph/` 图谱，造成串台（018），而不是 MCP「自己换库」。

**目标：** 有默认绑定根时，**索引根不一致则不换库**，仍用 `R` 回答，并在成功结果文首用英文说明；**不** `isError`（避免整会话弃用 HomeGraph）。

**判定单位：** 解析后的索引根（含 `.homegraph/` 的目录），**不是** path 字符串的父子关系。

---

## 2. 范围

### 2.1 做

1. 仅当 `ToolHandler` 已有默认 `HomeGraph`（绑定根 `R = resolve(getProjectRoot())`）时生效。
2. 调用带 `projectPath = P`：
   - `R' = findNearestHomeGraphRoot(P)`（可无）
   - 若 `R'` 存在且 `resolve(R') === R` → 照常使用默认实例（含子路径向上落到同一根）；**无**钉死提示
   - 若 `R'` 缺失或 `resolve(R') !== R` → **忽略换库**，返回默认实例；设置一次钉死提示（成功结果文首前置）
3. 提示英文固定结构（可多行），须含：绑定根绝对路径、被忽略的 `projectPath`、（若有）其解析到的根、以及「下列结果仅来自绑定根」；**不得** `isError`
4. 挂载点：与 Spec 0035/0038 同一成功装饰路径（`withProductStatusFooter`）；幂等（已含标记则不重复）
5. **无**默认工程时：保持现有跨仓 `projectPath` 打开行为（#964 monorepo）
6. 单测 + CHANGELOG `[Unreleased]`；可选 `server-instructions` 一句

### 2.2 不做

- 硬拒绝 / 清空结果 / 要求 agent 改 path 后才能答
- 用 `startsWith` 等字符串父子关系代替索引根比较
- 允许「`R'` 在 `R` 文件系统内部」的嵌套子索引例外（本版一律钉 `R`；若以后要 monorepo 例外另开 Spec）
- 改变 Spec 0028 对启动根解析的地板行为

---

## 3. 行为摘要

| 条件 | 行为 |
| --- | --- |
| 无默认 `HomeGraph` + `projectPath` | 现行为：按 `P` 解析并打开（或 NotIndexed 成功形指引） |
| 有默认 `R`，未传 `projectPath` | 用 `R` |
| 有默认 `R`，`resolve(R') === R` | 用 `R`，无钉死提示 |
| 有默认 `R`，`R'` 缺失或 `≠ R` | 用 `R` + 文首英文钉死提示；不打开 `R'` 的 DB |
| 敏感路径等 `PathRefusalError` | 仍拒绝（安全优先于钉死） |

---

## 4. 验收标准

- [x] 两仓均已索引：handler 默认绑 A，`projectPath=B` 的 search/explore 命中 A 的符号且文含钉死提示；不 `openSync` 到 B
- [x] `projectPath` 为 A 下子路径 → 无钉死提示，仍为默认实例
- [x] handler 无默认工程时，`projectPath=B` 仍可打开 B（回归跨仓）
- [x] 提示非 `isError`；CHANGELOG Unreleased；本 Spec 完成后勾选并改状态（commit 另发）

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 同会话刻意查第二个已索引仓被钉回 | 文档：一 MCP 一工程；无 `--path`/无默认时仍可跨仓 |
| 嵌套 monorepo 子包 `.homegraph` 被钉回父根 | 本版显式不做例外；需要时另 Spec |
| 提示过长 | 固定短英文 ≤5 行 |

回滚：去掉 `getHomeGraph` 钉死分支与文首提示即可。

---

## 6. 非目标

- Spec 0042 检索/资源清单语义
- 宿主改 agent 传参方式（D）
