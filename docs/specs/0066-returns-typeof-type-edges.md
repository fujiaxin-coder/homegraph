# 0066 — 返回/参数类型边（`returns` / `type_of`）可反查

| 字段 | 内容 |
| --- | --- |
| 编号 | 0066 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-11-05 |
| 范围 | 抽取阶段类型注解改标 `returns`/`type_of`；解析仅连类型节点（歧义丢弃）；ArkTS 从 `returnType`/参数类型发边；JSDoc `@returns`/`@param` 作签名补源；单测 `spec-0066-returns-typeof-edges`；CHANGELOG |
| 非本 Spec | 无 JSDoc 就跳过成员；新 MCP 工具；改 `nodes.return_type` 列语义；Dart/Scala 等整签混抽路径全面改标；Neo4j 模型 |

---

## 1. 背景与目标

函数/方法返回类型主要落在 `nodes.return_type`（及签名/`references`），`EdgeKind` 虽有 `returns`/`type_of`，但抽取侧类型注解几乎一律发 `references`，**不能稳定按类型节点入边反查「谁返回了 TypeX / 谁以 TypeX 为参」**。对照文档型 API KG：Method→Type 的 `RETURNS`/`PARAMS` 是一等关系；JSDoc `@returns`/`@param` 可补类型字符串。HomeGraph 已有 `docstring`（Spec 0020），缺的是结构化类型边。

**目标：** 把返回/参数类型连到已有类型节点；歧义宁可不连；签名优先、JSDoc 补缺；`return_type` 字段保留给链式推断。

---

## 2. 范围

### 2.1 做

- tree-sitter：参数类型位置 → `type_of`；返回类型位置 → `returns`（可分清字段的语言路径；含 TS/JS 默认路径）。
- 解析：`returns`/`type_of` 只匹配类型类节点（`class`/`interface`/`type_alias`/`enum`/`struct`/`protocol`/`trait`/`component`）；同语言族；**唯一候选才连边**（同文件优先后仍 ≥2 → 丢弃）。
- ArkTS：方法上的规范化 `returnType` 与参数类型发 `returns`/`type_of` 未解析引用。
- JSDoc：从 `docstring` 解析 `@returns`/`@param {Type}`；仅当签名侧未给出可用类型名时补发引用（不替代正文进 FTS）。
- 单测：跨文件 TS `returns`/`type_of` 边 + 类型入边反查；歧义不连；JSDoc 补返回类型。
- CHANGELOG `[Unreleased]` 用户向一句。

### 2.2 不做

- 不为「无注释成员」跳过建节点。
- 不新增专用 MCP 工具（现有 node/explore 关系区已认 `returns`/`type_of`）。
- 不改动 `return_type` 字段用途；不强制旧库不重索引即有边（升级后需 re-index）。
- 不在本 Spec 把 Dart 整签混抽等路径全部改标（仍可为 `references`；影响分析照旧）。

---

## 3. 行为

| 场景 | 结果 |
| --- | --- |
| `foo(): Bar` 且图中唯一 `Bar` 类型节点 | `foo --returns--> Bar` |
| `foo(x: Bar)` 且唯一 `Bar` | `foo --type_of--> Bar`（参数类型） |
| 同名类型节点 ≥2 且同文件消歧后仍不唯一 | 不建边 |
| 仅 JSDoc `@returns {Bar}`、签名无返回类型 | 可建 `returns`（解析成功时） |
| 签名已有返回类型 | 以签名为准；不因 JSDoc 重复乱连 |
| 原始类型 / void 等 | 不建边（与现有非类返回规范化一致） |

---

## 4. 验收

- [x] Spec 落盘
- [x] 抽取/解析/ArkTS/JSDoc 接线按 §2.1
- [x] `spec-0066-returns-typeof-edges` 测例通过
- [x] CHANGELOG `[Unreleased]` 有条目
