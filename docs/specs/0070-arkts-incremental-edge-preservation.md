# 0070 — ArkTS 增量 sync 边保持

| 字段 | 内容 |
| --- | --- |
| 编号 | 0070 |
| 类型 | 缺陷修复 |
| 状态 | 已完成 |
| 日期 | 2026-11-12 |
| 范围 | `src/extraction/languages/arkts.ts`（`runArkTSBatchIncrementalModules` / `persistIncrementalModuleResults`）；测试 `test/harmony-precision` 新用例；CHANGELOG |
| 非本 Spec | 全量路径的 `deleteArkTSCrossFileCallEdges`（保持现状）；source 限定的选择性删除（评估为可选，暂不做）；component 双节点返工（独立问题）；ark 边 line/col（独立问题） |

---

## 1. 背景

增量 sync（`sync` → `primeArkTSBatch({changedFiles})` → `runArkTSBatchIncrementalModules`）存在两个叠加缺陷，导致一次增量后全工程 ark 调用边大面积静默丢失，直到下次全量 `indexAll` 才恢复：

1. **全局删边、局部补边**：批次开头 `deleteArkTSCrossFileCallEdges()` 的 SQL 谓词是 `kind='calls' AND provenance='heuristic' AND synthesized_by='arkanalyzer' AND json_extract(metadata,'$.sourceFile') IS NOT NULL`，而 `emitArkCallEdge` 给**每条** calls 边都写 `sourceFile`——该 DELETE 实际清空全工程所有 ark calls 边（同文件 + 跨文件），与函数名的 "CrossFile" 语义不符。随后只重析脏模块，source 在干净模块的边永不重发，直接蒸发。
2. **seed 空壳覆盖**：`seedMapsFromOtherLoadedFiles` 把 SIGNATURES 级的干净依赖文件塞进 `fileResults`；`persistIncrementalModuleResults` 对 fileResults 里所有文件 force 落盘，干净模块的完整节点行被签名级空壳顶掉。

## 2. 原则（与用户确认的方案）

- **脏模块调用别人的边**：全部删除（重析后重发）。现状已由 FK 级联天然覆盖——脏模块文件重析必走 `deleteFile` → `deleteNodesByFile`，edges 的 `FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE` 随 source 节点删除删边。**不需要显式 DELETE**。
- **别人调用脏模块的边**：不删。target 侧节点 id 不变 → 边存活；id 变（方法挪行）→ `persistFileResult` 的 #899 快照重绑（`getCrossFileIncomingEdgesWithTarget` 按 kind+name 匹配新 id 重插）救回。现状即正确。
- **干净模块数据**：已落盘，拿来即用，不重写。

## 3. 改动

### 3.1 移除 incremental 路径的全局删边

`runArkTSBatchIncrementalModules` 中删除 `queries.deleteArkTSCrossFileCallEdges()` 调用（原 arkts.ts:1611）。source 在脏模块的边由 FK 级联随 `deleteFile` 删除。

**保持不变**：

- `primeArkTSBatch` full 模块路径的同类调用（全模块重析，全删安全）。
- incremental 失败回退 full 分支中的同类调用（回退后是全量重建）。

### 3.2 增量落盘限定脏模块前缀

`persistIncrementalModuleResults` 增加可选参数 `allowedPathPrefixes?: string[]`：

- 传入时（incremental 路径，传脏模块 `srcPath` 集合）：只对路径命中前缀（`p === prefix || p.startsWith(prefix + '/')`，与 `findLongestHarmonyModule` 同判）的文件 force 落盘。
- 未命中前缀的文件（`seedMapsFromOtherLoadedFiles` 产生的干净 SIGNATURES 文件）：留在 `fileResults`，随 `releaseArkTSBatchHeavyPayload` 丢弃，不落盘。
- 未传（保持现有调用形状）：行为不变，全部 force 落盘。

调用点 `runArkTSBatchIncrementalModules` 传 `moduleSrcPaths`。

## 4. 行为矩阵

| 场景 | 改动前 | 改动后 |
| --- | --- | --- |
| 脏模块文件方法体编辑（签名/行号不变） | 全工程 ark calls 边被删；只有脏模块重发 | 干净模块边原样保留；脏模块边级联删后重发 |
| 脏模块方法改名/挪行 | 同上；incoming 边因全局删除丢失 | target 端旧边随 id 级联删，#899 快照重绑到新 id |
| 脏模块删除一处调用 | 边残留风险（全局删除掩盖） | source 节点重析不 emit → 边随级联自然消失 |
| seed 的干净依赖文件 | 被空壳 force 覆盖（node_count 骤降） | 不落盘，DB 保留原完整行 |
| 全量 indexAll / full 回退 | 全删 + 全模块重发（不变） | 不变 |

## 5. 验收

- [x] Spec 落盘
- [x] `runArkTSBatchIncrementalModules` 不再调用 `deleteArkTSCrossFileCallEdges`
- [x] `persistIncrementalModuleResults` 支持前缀限定；incremental 调用点传入脏模块 srcPath
- [x] `test/harmony-precision` 新增增量用例：干净模块 → 脏模块的跨文件 ark calls 边在脏模块 sync 后保留；干净模块文件 node_count 不被 seed 空壳覆盖
- [x] 既有 `test/harmony-precision` 全绿
- [x] CHANGELOG `[Unreleased]` 有条目（引用 Spec 0070）

## 6. 明确不做

- source 限定的选择性 `DELETE`（评估为冗余保险：级联已覆盖，多一条子查询扫 nodes 的慢 SQL）。
- 同文件/跨文件边区分（删除粒度由 source 节点归属决定，与文件内/跨文件无关）。
