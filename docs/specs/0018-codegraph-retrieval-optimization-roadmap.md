# CodeGraph 检索优化技术路线

## 1. 背景与目标

行业 AI Coding 场景并不缺少能够读写代码、执行命令和修改工程的 Coding Agent。现阶段更明确的业务诉求是：在不降低任务完成率的前提下，减少 Agent 为理解代码仓库而消耗的上下文 Token、搜索轮次和端到端时间。

HomeGraph 的定位因此不应是重新实现一个 Coding Agent，而应是：

> 面向 Coding Agent 的多语言、分层、预算感知 CodeGraph 上下文引擎。

它接收 Issue、代码理解问题或 Agent 当前状态，从代码图中选择能够支持当前任务的最小充分证据，再把这些证据提供给现有 Agent。

核心目标不是单纯让输出变短，而是：

> 在相同模型、相同 Agent、相同任务和基本相同成功率下，减少模型累计处理的代码上下文。

建议使用“每成功任务成本”作为综合指标：

```text
Cost per Solved Task = 全部任务消耗 / 成功解决的任务数
```

同时报告任务成功率、总 Token、成功任务平均 Token、端到端延迟、工具调用次数和无效上下文比例。

---

## 2. 当前工作的技术边界

### 2.1 CodeGraph 系统的三层结构

完整的 CodeGraph 系统可以分为三层：

| 层次 | 主要问题 | 典型内容 |
|---|---|---|
| 图构建层 | 如何把源码变成可信的图 | Parser、符号表、类型解析、调用边、继承边、跨语言绑定 |
| 图检索层 | 如何从大图中找到当前任务需要的最小子图 | 查询理解、节点召回、路径搜索、分层下钻、预算选择 |
| Agent 集成层 | 如何让 Agent 有效消费检索结果 | MCP 工具、输出协议、上下文去重、停止提示、轨迹统计 |

### 2.2 当前 HomeGraph 的实际状态

目前已有 HomeGraph 可以完成基础的代码索引、符号检索和关系查询。此前 Explore V2 的主要改动集中在：

- MCP 工具与兼容路由；
- L1/L2/L3 工程理解输出；
- 专项 usages、modules、native 查询；
- 输出裁剪和 Token 控制；
- Agent 调用引导与停止策略；
- Eval、工具轨迹和 Token 指标。

这些工作主要属于 Agent 上下文工程和基于规则的检索编排，并没有大规模重写 CodeGraph 的底层构建算法。

### 2.3 下一阶段是否涉及底层构图算法

近期主线应当放在**检索阶段**，而不是从头重做多语言 Parser、编译器前端或完整的静态分析系统。

也就是说，近期方案是：

```text
复用现有 CodeGraph
        ↓
改进查询与任务理解
        ↓
改进子图召回和关键路径搜索
        ↓
在 Token 预算下选择最小充分证据
        ↓
减少 Agent 后续 Grep、Read 和重复探索
```

但这不等于构建层完全不动。为了支持检索算法和公开 Benchmark，仍需进行有限的基础补强：

- 统一跨语言节点和边的 IR；
- 补充检索必需但当前缺失的关系，例如 test-covers；
- 给模糊解析边增加 confidence；
- 给每条边保存文件、行号和解析来源；
- 支持代码修改后的增量更新；
- 修复严重影响召回的符号解析错误。

判断原则是：

> 如果构建层问题会使检索算法拿不到必要关系，就修；如果只是为了建设更完整的静态分析器、但暂时不能改善任务检索，则不是近期优先项。

---

## 3. 一个具体的 Bug 修复示例

假设一个包含 10,000 个文件的 Python 仓库收到 Issue：

> 异步 HTTP 请求被取消后，连接池中的连接没有释放，请修复并增加回归测试。

正确修改涉及：

```text
http/client.py
http/connection_pool.py
tests/test_request_cancel.py
```

关键链路是：

```text
Client.request()
  → Transport.send()
  → ConnectionPool.acquire()
  → Response.close()
  → ConnectionPool.release()
```

Bug 原因是取消异常进入了特殊控制流，没有执行 `release()`。

### 3.1 当前检索可能遇到的问题

当前 Explore 可能根据 `request`、`connection`、`release` 搜索相关符号，再固定展开一到两跳，最终返回：

```text
http/client.py
http/request.py
http/response.py
http/transport.py
http/connection.py
http/connection_pool.py
http/http2.py
http/retry.py
http/exceptions.py
tests/test_client.py
tests/test_pool.py
tests/test_transport.py
...
```

它可能找到了正确文件，但仍存在以下问题：

- 大量语义相关但修复不需要的文件被返回；
- 不同类型的图边没有根据任务动态加权；
- 固定两跳可能漏掉 `release()`，固定四跳又可能造成图爆炸；
- 测试关系没有与实现链路一起返回；
- 超出 Token 后按文本位置裁剪，可能裁掉真正关键的异常分支；
- Agent 获得大量上下文后仍要继续 Grep 和 Read。

### 3.2 目标检索结果

优化后的检索应当优先返回：

```text
任务判断：取消异常导致资源释放路径缺失

关键路径：
Client.request
  → Transport.send
  → ConnectionPool.acquire
  → Response.close
  → ConnectionPool.release

高风险分支：
Transport.send 捕获 CancelledError 后直接抛出；
该路径未进入调用 release() 的 finally 块。

相关实现：
- http/client.py: Client.request
- http/transport.py: Transport.send
- http/connection_pool.py: acquire/release

关联测试：
- tests/test_request_cancel.py
- 当前测试覆盖正常关闭，未覆盖 CancelledError
```

假设原始检索返回 20 个文件、30 个符号和 8,000 Token，目标是将其压缩为约 3 个文件、5 个符号和 2,000 Token，同时保留完整问题链路和测试证据。

---

## 4. 主要检索算法方向

## 4.1 查询感知的关系加权

算法首先从 Query 中识别：

```text
任务类型：Bug 修复
触发条件：请求取消
异常现象：连接没有释放
目标对象：连接池
可能机制：异常控制流、资源生命周期
需要证据：正常路径、取消路径、释放位置、关联测试
```

随后根据任务动态设置图关系权重。例如该问题中：

| 图关系 | 示例权重 |
|---|---:|
| exception-flow | 1.0 |
| acquire/release resource pair | 1.0 |
| calls | 0.9 |
| test-covers | 0.9 |
| overrides | 0.6 |
| imports | 0.3 |
| same-directory | 0.1 |

如果查询变成“HTTP 模块整体架构”，则 `module-depends-on`、`contains` 和 `imports` 权重更高，函数级异常路径权重降低。

候选节点评分可从可解释的线性模型开始：

```text
Score(v) =
    0.30 × QueryMatch(v)
  + 0.30 × PathRelevance(v)
  + 0.20 × EdgeType(v)
  + 0.10 × TestRelation(v)
  + 0.10 × Confidence(v)
```

第一版不必训练复杂模型，先通过规则和可调参数建立强基线，后续再研究学习排序。

## 4.2 L1/L2/L3 分层召回

将工程理解真正实现为逐层缩小搜索空间，而不只是输出格式上的三档。

### L1：仓库和模块层

从全部模块中选择与 Issue 最相关的候选：

```text
http       0.92
cache      0.31
database   0.18
其他       < 0.10
```

### L2：文件和组件链路层

在 `http` 模块内部召回：

```text
client.py → transport.py → connection_pool.py
                         ↘ test_request_cancel.py
```

### L3：符号和源码证据层

只展开：

```text
Client.request()
Transport.send()
ConnectionPool.acquire()
ConnectionPool.release()
test_request_cancelled()
```

这样避免一开始就在全仓库的全部函数节点上进行高成本细粒度搜索。

## 4.3 从固定 N 跳改为关键路径检索

固定 N 跳存在天然矛盾：跳数小会漏关键节点，跳数大又容易图爆炸。

新的检索目标不是“返回种子节点周围的全部邻居”，而是寻找能够解释任务的高价值路径。例如：

```text
起点：request / cancel
终点：release / connection pool
偏好边：calls、exception-flow、resource-flow
```

第一版可使用加权最短路径或 Beam Search。后续可研究 Steiner Tree、Personalized PageRank 或学习型路径排序。

最终返回的不是零散相关符号，而是：

> 连接在哪里申请、正常情况下在哪里释放，以及取消路径为什么绕过释放。

## 4.4 Token 预算下的最小充分子图

如果当前只允许返回 2,000 Token，算法不应先拼接大量文本再截断，而应提前选择最有价值的证据组合。

候选内容示例：

| 内容 | Token | 任务价值 |
|---|---:|---:|
| `Client.request` 取消分支 | 280 | 0.80 |
| `Transport.send` 异常处理 | 380 | 0.92 |
| `Pool.acquire` 关键片段 | 180 | 0.85 |
| `Pool.release` 实现 | 220 | 0.96 |
| 取消场景测试 | 350 | 0.90 |
| 整个 `connection_pool.py` | 3,000 | 0.70 |
| HTTP 模块说明 | 800 | 0.30 |

选择目标可以表示为：

```text
最大化：相关性 + 路径覆盖 + 置信度 + 证据多样性
最小化：Token + 冗余
约束：总 Token 不超过预算
```

即：

```text
max αRel(S) + βCoverage(S) + γConfidence(S)
    - λToken(S) - μRedundancy(S)
```

这可以先实现为带路径覆盖约束的贪心或背包选择，再逐步升级算法。

## 4.5 状态感知的增量检索

如果 Agent 第一轮已经看过：

```text
Client.request
Transport.send
ConnectionPool.release
```

修改后测试报告：

```text
AssertionError: pool.active_count == 1
```

第二轮不应再次返回前三个函数，而应只补充：

```text
ConnectionPool._deactivate()
ConnectionPool.active_count
PoolFixture.assert_empty()
```

这里需要区分两个概念：

- 增量构图：代码发生修改后，只重新索引变化的节点和边；
- 增量检索：只补充 Agent 尚未获得的新证据，避免重复上下文。

二者结合才能降低多轮任务的累计 Token。

## 4.6 证据、来源与置信度

每个返回关系都应带有：

- 文件和行号；
- 关系类型；
- 解析器或规则来源；
- 置信度；
- 是否通过源码文本核验；
- 对应代码版本。

对于静态分析无法完全确定的关系，可区分：

```text
resolved
probable
textual-only
unresolved
```

这能降低错误图边误导 Agent 的风险，也是工业场景可信性的基础。

---

## 5. 与 Agent 工程的区别

Agent 的调用方式可以保持不变：

```text
homegraph_explore("异步 HTTP 请求取消后连接没有释放")
```

如果只是修改 Prompt，告诉 Agent“优先查连接池”，属于 Agent 工程。

如果 Agent 调用完全不变，但 HomeGraph 根据任务动态选择关系、搜索关键路径，并在预算内选择不同子图，则属于 CodeGraph 检索算法优化。

为了证明增益来自检索算法，实验应固定：

```text
同一个模型
同一个 Agent
同一个系统提示词
同一个最大轮次
同一组问题
```

只替换上下文获取方式：

```text
Grep / BM25
Embedding
固定 N 跳 CodeGraph
查询感知 + 分层 + 预算约束 CodeGraph
```

---

## 6. Benchmark 与指标设计

### 6.1 第一阶段：检索层 Benchmark

建议优先使用：

- RepoBench-R：跨文件代码检索；
- CrossCodeEval：Python、Java、TypeScript、C# 跨文件上下文；
- RepoQA/CodeRepoQA：仓库级代码理解和证据定位。

检索层指标包括：

- gold 文件 Recall@K；
- gold 函数 Recall@K；
- MRR；
- 关键路径覆盖率；
- 返回 Token；
- 无关源码比例；
- 单位 Token 的 Recall；
- 索引和检索延迟。

### 6.2 第二阶段：Agent 端到端 Benchmark

再接入 SWE-bench 或同类真实 Issue 修复任务。

端到端指标包括：

- resolved rate / Pass@1；
- 总 Token；
- fresh input、cache read/write、output Token；
- 成功任务平均 Token；
- 每成功任务成本；
- 首次命中正确文件和函数的轮次；
- Grep、Read 和重复 Explore 次数；
- 无关文件读取数；
- 端到端延迟。

### 6.3 必要消融实验

建议至少比较：

```text
A. BM25 / 文本检索
B. Embedding 检索
C. 固定 N 跳 CodeGraph
D. C + 查询感知关系权重
E. D + L1/L2/L3 分层
F. E + Token 预算选择
G. F + 多轮增量去重
```

这可以分别回答：图结构、任务感知、分层、预算控制和状态去重各自贡献了多少。

---

## 7. 建议实施阶段

### Phase 0：固定基线与评测口径

- 固定模型、Agent、提示词和工具权限；
- 建立 BM25、Embedding、固定 N 跳图检索基线；
- 统一 Token、时延和成功率口径；
- 保存完整检索结果和 Agent 轨迹。

### Phase 1：可解释的查询感知检索

- 任务类型和实体识别；
- 关系类型动态加权；
- 模块、文件、符号三级候选召回；
- 高价值路径搜索；
- 文件、行号和置信度输出。

### Phase 2：预算约束和状态感知

- 估算节点、路径和源码片段的 Token 成本；
- 最小充分子图选择；
- 去重与多轮增量上下文；
- 明确的信息缺口和停止条件。

### Phase 3：构建层必要补强

- Python 和 TypeScript/Java 至少形成两种公开语言支持；
- 统一 IR；
- test-covers、exception-flow 等必要关系；
- provenance、confidence 和增量索引。

这一阶段不是重写整个编译器前端，而是围绕 Benchmark 暴露的召回缺陷补关系。

### Phase 4：公开 Benchmark 和论文

- 在 RepoBench-R、CrossCodeEval 上做检索实验和消融；
- 在 SWE-bench 子集上做同 Agent A/B；
- 分析成功率、Token、延迟与失败模式；
- 形成“分层、预算感知 CodeGraph 检索”的论文方法。

---

## 8. 近期优先级结论

### P0：检索算法

1. 查询感知的关系加权；
2. L1/L2/L3 分层召回；
3. 关键路径而非固定 N 跳；
4. Token 预算下的最小充分子图；
5. 多轮上下文去重。

### P1：构建层必要补强

1. 检索需要的缺失关系；
2. 边的来源和置信度；
3. 跨语言统一 IR；
4. 增量索引和严重解析缺陷修复。

### P2：Agent 接入与产品工程

1. 稳定 MCP 接口；
2. 上下文状态传递；
3. 工具输出协议；
4. 轨迹、指标和报告。

近期可以概括为：

> 主要研究对象是 CodeGraph 检索，不是重新发明 CodeGraph Parser，也不是继续依赖 Prompt 驱动工具调用。构建层按检索需要进行补强，Agent 层作为固定接入和验证载体。

---

## 9. 可形成的技术主张

建议将后续技术和论文主题收敛为：

> Hierarchical and Budget-Aware Code Graph Retrieval for Token-Efficient Software Engineering Agents

对应三个核心创新：

1. 分层 CodeGraph：从模块到文件，再到符号和源码；
2. 预算感知的最小充分子图：在 Token 约束下最大化任务证据覆盖；
3. 状态感知的增量上下文：根据 Agent 已有证据，只返回新增信息。

期望最终证明：

```text
相同模型 + 相同 Agent + 相同任务

接入优化后的 CodeGraph 检索后：
- 任务成功率保持不变或提高；
- 上下文 Token 明显下降；
- Grep/Read 和重复搜索减少；
- 每成功任务的成本下降；
- 在多语言公开 Benchmark 上仍然成立。
```
