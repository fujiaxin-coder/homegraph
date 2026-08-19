# 0013 — ArkUI migrate：`collectObserved` 按 scope 反向收集


| 字段  | 内容                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编号  | 0013                                                                                                                                              |
| 类型  | 变更 / 性能                                                                                                                                           |
| 状态  | 已完成（随 1.5.4 合入）                                                                                                                                     |
| 日期  | 2026-08-19                                                                                                                                        |
| 范围  | `src/arkui/migrate-snapshot.ts` 的 `collectObserved`；相关单测；CHANGELOG                                                                                |
| 关联  | [0007](./0007-arkui-migrate-snapshot.md)（`observedClasses` 语义）；索引期 `observed-ref` 边见 `src/extraction/languages/arkts.ts` `indexObservedClassRefs` |


---

## 1. 背景与目标

`buildArkUIMigrateSnapshot` → `collectObserved` 当前为：

1. `getNodesByKind('class')` + `getNodesByKind('struct')`（全图物化）
2. 过滤带 `@Observed` / `@ObservedV2` 的节点
3. 对每个候选 `getIncomingEdges`，再与 scope 内 `stateVarIds` 求交；保留 `inScopeFile || referencedBy.length > 0`

大仓（数万 class/struct）上第 1 步主导耗时，易导致 `homegraph_arkui_migrate` 超时。快照最终只要 **scope 文件内的 Observed 类** 或 **被 scope 状态变量经** `observed-ref` **引用的 Observed 类**，全图扫描不必要。

索引期已有字段 → Observed 类的 `references` 边（`metadata.via === 'observed-ref'`），查询期可从 `stateVarIds` 反向走边。

**目标：**

1. `collectObserved` **不再**对 `class`/`struct` 做全图 `getNodesByKind`。
2. 在既有索引边上，`observedClasses` 与 0007 语义对齐（同 scope 下结果与旧实现等价，见 §3）。
3. 大图上成本与 scope 内状态变量数 + scope 文件节点数同阶，而非全库 class 数。

---



## 2. 范围



### 2.1 做

- 重写 `collectObserved(graph, scopeNodes, stateVarIds)`：
  - **引用路径：** 对每个 `stateVarId`，`getOutgoingEdges` → 保留 `kind === 'references'` 且 `metadata.via === 'observed-ref'`（可选同时认 `metadata.synthesizedBy === 'arkui-migrate'` **仅当** `via === 'observed-ref'`，勿单独用 `synthesizedBy` 匹配全部 migrate 边）→ `target` 为 `class`/`struct` 且装饰器含 Observed/ObservedV2 → 纳入，并聚合 `referencedBy`。
  - **同文件路径：** 对每个 scope 组件文件 `getNodesInFile`，过滤 `class`/`struct` + Observed/ObservedV2；无引用边也纳入（`referencedBy` 可为空）。
  - 合并去重（按 node id）；属性列表（contains → field/property + Track/Trace）保持现行为。
- 单测：语义回归（现有 fixture 仍过）+ **证明不走全图 kind 扫描**（mock `getNodesByKind` 在 `collectObserved` 路径上不被调用，或注入海量无关 class 时仍只返回 scope 相关项且耗时可接受）。
- CHANGELOG `[Unreleased]` Fixes 一句（用户向：大项目 `arkui_migrate` 不再因全图扫 Observed 类卡住）。



### 2.2 不做

- **不**改索引期 `indexObservedClassRefs` 建边规则。
- **不**改快照 JSON schema / MCP 工具名 / 入参。
- **不**在本 Spec 修 `resolveScope` 目录/文件分支的 `getNodesByKind('component'|'struct')` 全量（同类风险，另开 Spec 或 follow-up）。
- **不**改 skill / 外部文档为「永久降级方案」替代本修复（可选一句 local-dev 提示非必须）。

---



## 3. 行为与约束

```text
stateVarIds ──outgoing observed-ref──► Observed class/struct ──► observedClasses
scope files ──getNodesInFile + Observed filter──► 同文件 Observed（可无 referencedBy）
```


| 约束  | 说明                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------- |
| 等价  | 同一索引、同一 scope：新旧实现的 `observedClasses` 按 `id` 集合一致；同 id 的 `observationDecorator`、`properties`、`referencedBy`（集合）一致 |
| 边过滤 | 只认 `via === 'observed-ref'`；禁止用宽泛 `synthesizedBy === 'arkui-migrate'` 把 storage/passage 边当 Observed 引用            |
| 无边  | 仅同文件 Observed、尚无任何 state→类 `observed-ref` 时仍出现在结果中                                                                |
| 跨文件 | 仅靠 `observed-ref` 进入；无边则不出现（与旧实现「无入边且非 scope 文件则丢弃」一致）                                                            |
| API | 仍通过 `MigrateSnapshotGraph`；优先已有 `getOutgoingEdges` / `getNodesInFile` / `getNode`，不新增全图 API                       |


---



## 4. 验收

- [x] Spec 状态经确认 →「已确认」后再开实现分支。
- [x] `collectObserved` 实现符合 §2.1 / §3；无 `getNodesByKind('class'|'struct')`。
- [x] `test/languages/arkts/arkts-migrate-snapshot.test.ts`（及 migrate-index 相关断言）通过。
- [x] 新增用例覆盖：海量无关 class 不污染结果；同文件无引用 Observed 仍收录；仅 `observed-ref` 计 `referencedBy`。
- [x] CHANGELOG `[Unreleased]` Fixes 用户向一句。
- [x] PR 关联本 Spec；合入后状态 →「已完成」。

---



## 5. 状态

**已完成**（随 1.5.4 合入）— `collectObserved` 反向 `observed-ref` + scope 文件；测试：`arkts-migrate-snapshot.test.ts` 新增 spec 0013 用例。