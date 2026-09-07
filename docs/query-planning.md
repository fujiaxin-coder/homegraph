# Explore 查询规划

## 改了什么

在 HomeGraph 内部新增 `QueryPlan`，保存原问题、检索表达、意图、符号候选、子任务依赖、路由特征及规划开销。模型仍调用现有 `homegraph_explore`，不需要学习新工具，也不需要显式选择 L1/L2/L3。

执行器复用 usages / modules / native、inventory / light-mechanism / compact / general explore；浅层工程地图使用上游的 `homegraph_project`。内部规划不会创建新的 AST 索引或修改源码。

更新：LLM 的 general/flow 子步骤通过支持结构化hints的完整context检索，暂不进入尚未消费这些hints的旧inventory/light-mechanism/compact快路径；rules与专用survey路径维持原行为。步骤可带自己的可选 `searchTerms`，不再反复拼接原题全文。原题/taskContext保留在结构化计划和缓存身份中，多步结果只展示一次任务约束。

## 三种模式

内部规划提示现在要求每步query使用英文自然语言，顶层及各步searchTerms使用拆开的简短小写英文语义词；真实标识符（包括中文）、路径和字面量保持原样，原任务作用域与否定约束保留。不要求用户或宿主Agent改成英文提问；这是原来一次规划请求中的prompt调整，没有增加翻译模型、词典或语言硬校验。后续结构化检索与校验的更新见下节。模型遵循该要求也不等于已召回正确业务，需看真实MCP结果。

| 模式 | 行为 |
| --- | --- |
| `rules`（默认） | 使用已有确定性规则生成共享计划，不调用模型；保留原 query 和已有检索行为 |
| `off` | 回退原有 Explore 执行路径；上游功能和其他工具仍保留 |
| `llm` | 简单明确的问题继续本地处理；歧义或复合问题允许一次模型规划，失败回退 rules |

`llm` 是实验开关，不代表默认开启了远程模型。不会自动读取以前实验的 Poe 密钥、shell history 或其他产品的模型配置。

显式 `llm` 且带原始任务上下文时，非精确自然语言查询会获得一次有界规划机会，不再仅因 mechanism/usages/UI 等词法路线命中而跳过。精确符号/路径集合及明确应交给内置工具的请求仍优先保留低成本路径；无上下文时沿用旧资格规则。资格放行不表示模型计划一定有效，也不表示任务已解决。

## 启用模型规划

在启动 HomeGraph MCP 的环境里配置下面变量，再重启对应的 MCP/daemon。只改变客户端的环境，不会更新已经运行的 daemon。

```bash
export HOMEGRAPH_QUERY_PLANNER=llm
export HOMEGRAPH_QUERY_PLANNER_URL='https://your-compatible-provider.example/v1'
export HOMEGRAPH_QUERY_PLANNER_MODEL='your-planner-model'
read -r -s -p 'Planner API key: ' HOMEGRAPH_QUERY_PLANNER_API_KEY
export HOMEGRAPH_QUERY_PLANNER_API_KEY
export HOMEGRAPH_QUERY_PLANNER_TIMEOUT_MS=5000

node dist/bin/homegraph.js serve mcp --path /path/to/indexed-project
```

URL 为兼容接口 base URL，也接受以 `/chat/completions` 结尾的地址。适配器发送一次非流式 `POST /chat/completions`，不重试、不跟随重定向。应使用 HTTPS；HTTP 会明文传输问题和认证信息，仅适合明确受信的本地环境。

只发送当前 query、可选原始 taskContext 和固定规划指令，不额外读取并上传仓库源码、目录列表、图数据库或候选符号表。原问题本身仍可能包含业务敏感信息，启用前需确认供应商符合项目数据要求。

规划默认 5 秒，可显式调整到 100–10000ms，并在同一次工具请求截止前预留至少 1 秒检索时间；默认工具响应预算来自上游 `CODEGRAPH_QUERY_BUSY_TIMEOUT_MS`，未设置时为 15 秒。最多 3 个子任务，不为每个子任务重新申请 15 秒。同步 SQL/源码扫描仍不可抢占；worker 与主线程响应截止策略共同限制等待，执行器在步骤之间检查截止时间。

## 依赖执行示例

问题：“解释条目加载过程，然后找出选中操作在哪里复用。”

1. 定位加载与选中逻辑，取得确实展示了源码声明的节点候选和文件位置。
2. 完整context检索用节点ID保持前驱身份，而不是重新用裸名检索另一个同名节点；usages等专用survey仍走现有名称/关系适配路径。不能让模型猜一个 `SelectionManager`。
3. 合并带行号的证据；若某步无结果、失败或预算耗尽，保留其他步骤的内容，并说明未完成部分。

模型建议的名字若既不在原问题中、也不能在当前索引精确验证，会拒绝整份模型计划并回退。这里的验证只能证明“名字存在”，不能证明模型选中了业务上正确的对象；后者仍需真实任务评测。

自然语言anchors若没有精确索引匹配，会降为检索词；真正存在的中文代码标识符仍可保留。原文中的CamelCase/path只是允许的查询提示，不因出现在原题中就被认为已经定位到了源码。

## 在哪里看新增指标

工具响应的 `_meta.homegraphQueryPlan` 包含紧凑诊断，不把整份规划或源码重复塞进正文：

- `source / intent / route / matchedFeatures / confidence`：采用本地还是模型规划，以及命中的路由特征。
- `planningEligible / planningReason / skip_reason / ruleRoute`：是否具备规划资格、原因、未规划的跳过原因和原始规则路线；与实际请求数及provider回退分开。精确查询是主动跳过，缺配置或超时是provider回退。旧轨迹可能没有这些字段。
- `modelRequests / planningMs / inputTokens / outputTokens`：额外规划请求和开销；没有模型请求时 token 为 0；发出请求但供应商没有返回用量时为 `null`，不是 0。
- `durationMs`：本次工具调用耗时，包含规划、等待和执行；不是外层 Agent 完整任务耗时。
- `steps`：各步骤 id、意图、状态、耗时；`locatedNodes`记录实际返回的源码节点ID/名称/文件/行号，`resolvedAnchors`保留简短名称以兼容旧诊断。二者不是业务正确性标签。
- `fallbackReason / cacheHit`：回退原因与是否命中缓存。缓存命中时不冒充重新执行步骤。

部分 Agent 的 UI 不展示 `_meta`，需要从原始 MCP 响应读取。本次未修改 eval 来消费这些字段；后续跑 A/B 时应统计规划开销与 Agent 开销之和，不能只看主模型 token。

## 第一版边界

- 原有 section builder 仍有形状规则：当前将共享计划接到入口、主要快路径、部分深层判断及 ContextBuilder，并用 canonical query 兼容其余 builder。**不是已经删除所有正则，也不是底层建图算法优化。**
- 多步骤聚合目前保守返回 Partial，不把某个子步骤的 `ANSWER NOW` 当成整个问题已回答。缺失证据不等同“代码不存在”。
- 依赖绑定只来自前序步骤已展示的源码声明，最多8个候选；位置摘要先计入共享输出预算，正文被裁短也不会传递不可见的节点。没有结构化源码记录的快捷section不产生新绑定，不用全局模糊搜索凑候选；继承节点的再次出现不算本步骤的新定位。它还不是精确的字段/数据流执行引擎。
- 模型规划接收本次 Explore query 及可选 taskContext，不接收整个对话。宿主可通过 HOMEGRAPH_QUERY_TASK_CONTEXT 传入原题；Agent 的 taskContext 只能补充该原题，不能将其替换。两者合并后上限4000字符，原题优先保留。
- 模型计划不复用 MCP 响应缓存；rules 计划的缓存区分意图、关系方向和索引状态。这样避免把模型故障或索引未完成的临时结果缓存下来。
- 已验证本地模拟供应商、真实小型索引、实际 worker 链路及 Qwen3-32B 实际检索；103 题推理结果已留存。尚未完成补丁正确性审查或 SDK/设备验收，不能据此声称准确率、token 或延迟已经改善。

## 回退与验证

```bash
export HOMEGRAPH_QUERY_PLANNER=off
# 然后重启对应 MCP/daemon

npm run build
npx vitest run test/query-plan.test.ts test/query-plan-integration.test.ts test/query-plan-cache.test.ts test/context-retrieval-hints.test.ts
```

模型测试使用模拟 HTTP 响应；worker 测试读取构建后的 `dist/mcp/query-worker.js`，因此需要先 build。规格见 [0022](specs/0022-structured-query-planning.md)。

## 结构化检索与证据恢复（Spec 0024）

Planner 仅在 `homegraph_explore` 的符合条件请求内调用，并非题目进入 Agent 时自动调用，也不接管其他工具。每个请求最多一次模型调用；同一个已校验 plan 传给 worker，各步骤不会再次调用模型。

- `searchTerms` 保存短检索概念，`literalTexts` 保存从输入原样复制的 UI 文案；解释用的 step query 不直接作为模型计划的搜索种子。输出提示要求每步最多六个短概念和必填的 `dependsOn` 数组，解析器验证结构并在无效时回退。
- `sourceScope` 区分 local/sdk/all；业务检索优先本地证据。文案查找可沿资源值、资源键和源码引用定位，受文件数、字节、时间及输出预算限制。
- `relation` 区分 incoming_references、registration_sites、outgoing_calls、module_imports、module_cycles。引用/注册走 usages，调用链走 flow，导入和循环走不同模块查询。未提供符号的引用请求先定位源码，引用义务仍标记未完成。
- 输出合并同一位置的重复声明，标记截断并保留源码位置与指纹。`_meta.homegraphEvidence` 记录 complete/partial/empty/sdk-only 和覆盖情况，检索完成不等于代码任务完成。
- 重复查询保护保留总次数限制；弱证据可有限补查，文件发生变化后重验缓存证据。原始源码块中的文字不受收尾指引替换影响。

规格见 [0023](specs/0023-task-aware-query-plan-validation.md) 与 [0024](specs/0024-grounded-planner-retrieval.md)。
