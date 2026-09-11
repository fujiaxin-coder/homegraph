# ArkTS 第二批：按查询目标查找有向路径

日期：2026-09-11。Spec：`docs/specs/0030-arkts-query-paths.md`。

## 目的与改动

第一批解决“源码被截断”；第二批解决“端点找到了，中间怎么连接仍不清楚”。
例如模型已经知道 `PipelineStart.start` 和 `ValueStore.apply`，这次会在有限范围内
寻找 `start → clean → clamp → apply`，把中间方法与必要注册声明一起返回。
目标是减少为了补齐证据而追加的搜索、读文件和模型轮次。

| 改动位置 | 通俗说明 |
| --- | --- |
| `src/graph/evidence-paths.ts`（新增） | 消费现有 planner 的关系、特征、已验证绑定和查询中的符号，形成调用/事件/状态/结构目标。按方向找路径；共享被调用者 `A→C←B` 不算 A 到 B 的调用链。排序区分关系是否适用及来源；代价不是正确概率。 |
| `src/db/queries.ts` | 增加受行数限制的邻居读取；优先读取与已知端点直接相连的边。精确限定名查询也支持行数上限，以补齐被旧分词规则忽略的 `Type.start` 等端点。 |
| `src/mcp/arkts-evidence-packs.ts` | 完整路径成为一个高优先级证据包：中间声明和注册声明都能返回，才标记 `provided`；过期、缺失或放不下则报告缺口。路径已找到时不再铺开无关邻居。 |
| `src/mcp/tools.ts` | 在第一批适用的 explore 路径中调用上述逻辑，传入已有 QueryPlan。继续沿用共享输出预算和真实源码收据。 |
| `src/mcp/query-cache.ts` | 缓存格式升至 5，新策略开关参与 explore/search 的缓存键，防止对照组串用结果。 |
| `src/mcp/server-instructions.ts`、工具描述 | 告诉模型如何理解方向、停止原因和歧义，缺哪项证据再补查哪项。 |

核心是 HomeGraph 内部检索和 MCP 返回代码，**没有增加 planner 模型请求，也没有改
planner 的生成 prompt**。不修改 codingeval、预建索引、解析器或合成边规则。
字面量/资源证据及独立 usages/modules/native 路径保持原有行为。

## 搜索与证据边界

- 最多 4 个端点、3 对相邻端点、每条路径 4 跳。默认方向未指定时，分别尝试整条
  正向和整条反向路径，结果始终显示图中实际方向。
- 最多 48 次邻接读取、128 个访问节点，每次最多保留 24 条邻边。数据库最多返回
  25 行，其中多出的 1 行用于检测截限；48 次逻辑读取可各执行最多 2 条有界 SQL。
- 路径搜索有 60 ms 墙钟检查。它是阶段间的合作式停止，不能中断正在执行的 SQLite
  查询，也不包含前置端点查询、源码读取或整个 MCP 请求的用时。
- 对查询/planner 中最多 4 个精确限定名尝试点号/双冒号形式，每次最多取 25 个身份
  候选。裸名同名且无法确定所属类型/文件时，返回 `ambiguous_anchor`。
- 源码仍受第一批上限约束：36 个候选、8 个文件、单文件 512 KiB、总读取 2 MiB，
  正文遵守现有项目规模预算。整条路径的源码依赖无法容纳时，不声称路径完整。
- 不使用 import、contains、返回类型作为调用捷径。状态刷新边只参与状态目标；
  状态/事件路径还必须包含相应图元信息，普通调用链不能单独证明这类关系。

`supported` 表示搜索找到了所选端点间的有限静态路径；源码未完整提供时，MCP 将其
改为 `source_incomplete`。`no_path_in_scope` / `budget_exhausted` 只说明本次未找到，
不能推断关系不存在。`neighbors_only` 是单端点的有限邻居证据。
任何 `complete` / `provided` 都不代表编码任务完成，也不证明运行时条件、顺序或值传播。

## 目录与使用

第二批位于独立目录 `smat052-query-paths-20260911`，基于第一批 `25d6033`。
第一批 `smat051-evidence-packs-20260911` 保留。第二批分支是 `feat/arkts-query-paths`。

构建后，将现有 MCP 配置中的程序路径指向第二批的 `dist/bin/homegraph.js`；目标
项目的现有索引可以复用。重启 MCP，并为每组对照使用新会话。

- 默认启用两批改动。
- `HOMEGRAPH_ARKTS_QUERY_PATHS=0`：保留第一批，关闭第二批策略。
- `HOMEGRAPH_ARKTS_EVIDENCE_PACKS=0`：关闭整个证据包路径，使用之前的渲染逻辑。

## 验证记录

`npm run build` 通过。17 个相关测试文件、153 项测试通过，覆盖多跳/方向/同名、
高出度/循环/超时/读取预算、过期与注册源码、MCP 与开关、缓存、多步 QueryPlan、
ArkUI ViewTree/状态、NAPI、字面量定位与现有路径边界；未运行全仓测试集。

两份真实 ArkAnalyzer → SQLite → MCP 的合成源码检查保存在 `validation/`：

| 检查 | 结果 |
| --- | --- |
| `scripts/query-path-smoke.cjs` | 第一批只返回部分连接；第二批返回 `PipelineStart.start → NormalizeInput.clean → ClampInput.clamp → ValueStore.apply`，两段中间源码完整，关系均保留真实索引的 heuristic/arkanalyzer 来源。原始结果、输入源码、节点和边在 `query-path-smoke.json`。 |
| 同一多跳示例的输出量 | 第一批 1,409 字符、证据不全；第二批 1,886 字符、所选路径证据完整。不能据此声称单次输出 token 更少或真实推理更快。 |
| `scripts/evidence-pack-smoke.cjs` | ArkUI 按钮、回调、if/else 和跨文件 Store 代码完整保留，第二批输出 1,836 字符。结果在 `evidence-smoke.json`。 |

联调中曾发现精确限定名 `PipelineStart.start` 的 `start` 被通用分词省略。修复前
原始输出保存在 `query-path-smoke-before-qualified-fix.json`，已增加 MCP 回归测试。
纯静态类夹具最初没有可达入口，只生成声明而没有调用边；最终夹具包含真实 ArkUI
入口。检索不会为索引缺边补造关系，解析器覆盖仍是边界。

Headroom 使用现有外部 0.37.0 lossless-v2 adapter，未恢复 codingeval 定制代码。
实际兼容检查确认 HomeGraph 证据正文逐字节保持一致；合成重复构建日志通过无损
往返验证，本地 tokenizer 计数为 843 → 20。后者是测试日志的压缩量，不能当作
benchmark 的 token 节省。结果见 `headroom-compatibility.json` 和
`headroom-query-path-compatibility.json`。

检查脚本支持指定外部 adapter、Python、tokenizer 和结果键：

```bash
node scripts/query-path-smoke.cjs
node scripts/evidence-pack-smoke.cjs
python -B scripts/verify-headroom-evidence.py \
  --adapter /path/to/headroom_adapter.py --python /path/to/headroom-python \
  --tokenizer /path/to/tokenizer.json
python -B scripts/verify-headroom-evidence.py \
  --adapter /path/to/headroom_adapter.py --python /path/to/headroom-python \
  --tokenizer /path/to/tokenizer.json \
  --evidence validation/query-path-smoke.json --result-key batch2 \
  --output validation/headroom-query-path-compatibility.json
```

这些检查没有调用模型服务、访问答案或隐藏测试。真实 codingeval 的准确率、总时长、
模型轮次与 token 仍需单独对照；预建索引继续单独记录。外部实验启动链路仍需显式
接入 Headroom，普通 codingeval 不会因为本次 HomeGraph 改动而自动启用它。
