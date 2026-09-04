# 0019 — ArkUI 组件 `.id()` 落入节点字段


| 字段 | 内容 |
| --- | --- |
| 编号 | 0019 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-08-31 |
| 范围 | `nodes` schema / migration；`Node.arkuiId`；ArkTS ViewTree 抽取；相关单测；CHANGELOG |
| 关联 | ViewTree 索引（`src/extraction/languages/arkts.ts`）；[0007](./0007-arkui-migrate-snapshot.md)（migrate 仍以 `@Component` 定义为准） |


---

## 1. 背景与目标

ArkUI 允许在组件调用链上写 `.id('…')`（自动化定位 / 组件标识）。ArkAnalyzer 已把该属性放进 `ViewTreeNode.attributes`（key = `id`），但 HomeGraph 索引只消费回调类属性，**未持久化**这个组件 id。

注意：这不是图谱主键 `nodes.id`（`generateNodeId`），而是源码里的 UI 组件 id。

**目标：** 在节点上增加可选字段，索引期从 ViewTree 读出并写入，可供查询 / Agent 使用。

---

## 2. 范围

### 2.1 做

- `nodes` 增加可空列 `arkui_id`；`Node` 增加 `arkuiId?: string`；migration 升版本；读写路径（insert/update/row map）接好。
- ViewTree 遍历时：若 `attributes` 含字面量 `id`，且该节点解析到已有的自定义组件节点（`kind: component` / 已解析的 class→component id），则把该字符串写入对应节点的 `arkuiId`（同一节点多处不同 id 时保留**先写入**的非空值，不覆盖）。
- 单测：fixture 里 `SubComponent().id('…')`（或等价）后，对应 `component` 节点带 `arkuiId`。
- CHANGELOG `[Unreleased]` 用户向一句。

### 2.2 不做

- 不为系统控件（`Button` / `Text` / `Column` 等）新建「仅因 `.id()`」的图谱节点（避免污染 `homegraph_arkui_migrate` 的 `kind=component` 枚举）。
- 不把 `arkui_id` 打进 `nodes_fts`（本需求只存字段；全文另案）。
- 不改 MCP 工具契约 / server-instructions（除非后续有按 id 查询需求）。
- 不处理表达式形式的 id（非字面量 Constant）——读不到则留空。

---

## 3. 行为与约束

| 场景 | 行为 |
| --- | --- |
| `Foo().id('bar')` 且 `Foo` 已索引为 component | `Foo` 的 component 节点 `arkuiId === 'bar'` |
| 同一 `Foo` 多处 `.id('a')` / `.id('b')` | 先到先得；后者不覆盖 |
| 仅有 `Button().id('x')` | 不建节点、不写字段（非目标） |
| 无 `.id()` | `arkuiId` 缺省 / SQL NULL |
| 旧库升级 | migration 加列；需重索引后才有值 |

字段命名：TS `arkuiId`，SQL `arkui_id`。

---

## 4. 验收

- [x] Spec 确认后实现。
- [x] 新库 `schema.sql` 与 migration 均含 `arkui_id`；`CURRENT_SCHEMA_VERSION` 递增。
- [x] ViewTree 带字面量 `.id()` 的自定义组件节点可查到 `arkuiId`。
- [x] 相关 vitest 通过；CHANGELOG `[Unreleased]` 已写。
- [x] 提交关联本 Spec（合入后状态 →「已完成」）。

---

## 5. 状态

**已完成** — `Node.arkuiId` / `nodes.arkui_id`（schema + migration v10）；ViewTree 字面量 `.id()` 写入自定义 `@Component` 节点；测试见 `arkts-viewtree.test.ts`；CHANGELOG `[Unreleased]` 已记。
