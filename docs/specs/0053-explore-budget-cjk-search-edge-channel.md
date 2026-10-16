# 0053 — Explore 调用预算口径、启发式边通道删除、回复去掉 node


| 字段 | 内容 |
| --- | --- |
| 编号 | 0053 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-10-16 |
| 范围 | explore 调用次数文案；`edges.synthesized_by` 与 ArkTS 跨文件边删除；explore/Partial 回复中的 `homegraph_node` 字样；单测与 CHANGELOG |
| 关联 | `explore-repeat-guard` 硬闸 `EXPLORE_CALL_BUDGET = 2`；Spec 0027（0 文件描述）；Spec 0051（默认工具面只有 explore/project） |
| 非本 Spec | 放宽 explore 硬闸；合并 `homegraph_project`；同名消歧；改 `getExploreBudget` 的输出档位；改 `homegraph_node` 工具自身的回复；跳过中文 FTS；WASM；局部变量 data-flow |


---

## 1. 背景与目标

1. **调用预算**：服务器在第 3 次 `homegraph_explore` 硬拒（上限 2）。工具描述和回复尾注却按 `getExploreBudget(fileCount)` 写成 1–5。agent 看到的次数和真正执行的次数不一致。  
2. **启发式边删除**：`deleteArkTSCrossFileCallEdges` 用 `metadata LIKE '%"synthesizedBy":"arkanalyzer"%'`。JSON 键序一变就漏删，增量索引留下旧调用边。  
3. **回复**：默认 tools/list 没有 `homegraph_node`，但 explore/Partial 回复仍让 agent 去调它。

中文整词（例如 `string.json` 的 value）在 FTS 里是有效 token。检索仍先走 FTS，没有命中再 LIKE。本 Spec 不改变这条顺序。

**目标：**

1. 对外的 explore **调用次数**一律写成 **2**，与硬闸相同。输出体积仍用 `getExploreBudget` 分档，不改。  
2. 边增加 `synthesized_by`，插入时写入，按该列删除 ArkTS 跨文件 `arkanalyzer` 调用边。  
3. explore / Partial / locate 回复不再出现 `homegraph_node`。其余 Read/Grep 句子不动。

---

## 2. 范围

### 2.1 做

- `EXPLORE_CALL_BUDGET = 2` 为硬闸与 `formatExploreCallBudgetNote` 的唯一数字。  
- schema v12：`edges.synthesized_by` + 部分索引；迁移从 `metadata.synthesizedBy` 回填。  
- `insertEdge` / `storeFileBundle` 写入该列。  
- `deleteArkTSCrossFileCallEdges`：`synthesized_by = 'arkanalyzer'` 且 `json_extract(metadata,'$.sourceFile')` 非空。  
- 从 explore、Partial、locate 横幅去掉 `homegraph_node`。  
- 单测与 CHANGELOG。

### 2.2 不做

- 把硬闸从 2 改成 1–5，或按仓库大小放宽。  
- 改 `getExploreBudget` 返回值（它仍只服务输出档位测试与分档）。  
- 重写「去 Read / narrow Grep」类句子。  
- 改 `homegraph_node` 被实际调用时自己的报错和 trail 文案。  
- 边唯一键加入 synthesizer（两通道撞同一条边仍 `INSERT OR IGNORE` 留一条）。  
- 中文查询跳过 FTS，或改写 LIKE 去扫 `docstring`（中文文案继续走 FTS）。  
- 中文分词器 / trigram。

---

## 3. 行为与约束

### 3.1 调用预算

| 表面 | 本 Spec 之后 |
| --- | --- |
| `decideExploreRepeat` | 仍 ≥2 次拒绝 |
| explore 工具描述（已索引、fileCount > 0） | `Budget: make at most 2 calls …` |
| explore 尾注 `Usually one explore is enough` | `budget ≤2` |
| `server-instructions` | 保持 `≤2` |
| `getExploreBudget` | 仍为 1/2/3/4/5，**不**写进调用次数文案 |

### 3.2 检索

`searchNodes` 保持既有顺序：有文本就先 FTS（含中文整词，如 Spec 0041 的 `string.json` value），无命中再按名称 LIKE，再 fuzzy。不按是否含中文分流。

### 3.3 边

- 新写入的启发式边：`synthesized_by` = `metadata.synthesizedBy`（无则 NULL）。  
- 旧库：打开时 migration v12 回填。  
- 删除 ArkTS 跨文件调用边只认列 `synthesized_by = 'arkanalyzer'`，不认 JSON 子串。其它通道（如 `callback`）即使 metadata 里有 `sourceFile` 也不删。

### 3.4 回复

- explore / Partial / locate 指引中删除 `homegraph_node` 字样，句子其余部分保留。  
- `neutralRetrievalGuidance` 仍能抹掉「Do **not** grep/read/`homegraph_search`…」这句（兼容旧文本里带 node 的写法）。

---

## 4. 验收标准

- [x] Spec 落盘（本文件）  
- [x] `formatExploreCallBudgetNote(1)` 与 `(20000)` 都是 at most **2**；initialize 指引仍为 ≤2  
- [x] `searchNodes('提交订单')` 经 FTS 命中 docstring 为该文案的 `submit_order`；名称子串 `登录` 仍可命中 `用户登录页`  
- [x] 键序不同的 metadata 经回填后，只删 `arkanalyzer` 跨文件边  
- [x] `insertEdge` 写入 `synthesized_by`  
- [x] Partial / locate 横幅断言不再要求 `homegraph_node`  
- [x] CHANGELOG Unreleased  

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 小仓库描述从「最多 1 次」改成「最多 2 次」，模型可能多试一次 | 硬闸本来就允许第 2 次；成功证据上限不变 |
| 大仓库描述从 3–5 改成 2，少一次必被拒绝的调用 | 检索结果不变，只少一次拒绝回合 |
| 未回填的旧行 `synthesized_by` 为空，通道删除删不到 | migration v12 在 open 时回填 |

回滚：描述改回 `getExploreBudget`；删除条件改回 metadata LIKE；回复加回 `homegraph_node`。列可留着，不影响旧删除语义。检索顺序不在本 Spec 的回滚范围内。
