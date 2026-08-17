# HomeGraph 文档索引

从这里选入口；**不要**再平行维护第二套「怎么开发 / 怎么 commit」长文。

| 你想… | 去读 |
| --- | --- |
| Spec、commit、PR、拉代码 | 仓库根 [DEVELOPMENT.md](../DEVELOPMENT.md) |
| 本地 build / CLI / Cursor MCP | [local-dev-guide.md](./local-dev-guide.md) |
| A/B 测评怎么做（外部仓 + 仓内入口） | [how-to-evaluate.md](./how-to-evaluate.md) |
| npm 发包、GitHub Release、GitCode 发行版、镜像 | [RELEASE.md](./RELEASE.md) |
| Agent 架构与检索原则（给 AI） | 仓库根 [AGENTS.md](../AGENTS.md) |
| 原理：节点/边/提取/消解 | [homegraph-principles.md](./homegraph-principles.md) |

---

## Specs（SDD）

需求与验收落在 [`specs/`](./specs/)。未写入 Spec 不开始非琐碎实现（豁免见 DEVELOPMENT §1.5）。下一编号按目录里已有最大号 +1（见 DEVELOPMENT）。

---

## Guides

| 文档 | 用途 |
| --- | --- |
| [guides/language-verification.md](./guides/language-verification.md) | 新语言 / 真实仓验证电池（原 `SEARCH_QUALITY_LOOP.md`） |

---

## Design（进行中或已落地的设计）

优先读 playbook，再读配套 design：

| 文档 | 用途 |
| --- | --- |
| [design/dynamic-dispatch-coverage-playbook.md](./design/dynamic-dispatch-coverage-playbook.md) | 动态分发覆盖矩阵与验证法 |
| [design/callback-edge-synthesis.md](./design/callback-edge-synthesis.md) | 回调/合成边机制 |
| [design/dispatch-synthesizer-backlog.md](./design/dispatch-synthesizer-backlog.md) | 合成器 backlog |
| [design/value-reference-edges.md](./design/value-reference-edges.md) | 同文件 value-ref 设计与矩阵 |
| [design/value-reference-edges-playbook.md](./design/value-reference-edges-playbook.md) | 新语言扩展 value-ref 操作手册 |
| [design/adaptive-explore-sizing.md](./design/adaptive-explore-sizing.md) | explore 自适应体量 |
| [design/chained-call-resolution.md](./design/chained-call-resolution.md) | 链式调用消解 |
| [design/function-ref-capture.md](./design/function-ref-capture.md) | 函数引用捕获 |
| [design/template-markup-parser.md](./design/template-markup-parser.md) | 模板标记解析 |
| [design/mixed-ios-and-react-native-bridging.md](./design/mixed-ios-and-react-native-bridging.md) | iOS / RN 桥 |

已结案笔记在 [`design/archive/`](./design/archive/)（历史，默认别当现行规范）。

---

## Benchmarks

| 文档 | 用途 |
| --- | --- |
| [benchmarks/call-sequence-analysis.md](./benchmarks/call-sequence-analysis.md) | 调用序列 / 读位移分析（现行常引） |
| [benchmarks/homegraph-ab-matrix.md](./benchmarks/homegraph-ab-matrix.md) | 多语言 S/M/L A/B 矩阵快照 |
| [benchmarks/answer-directly-vs-explore-agent.md](./benchmarks/answer-directly-vs-explore-agent.md) | 主会话直答 vs Explore 子代理 |

数字会过期；方法论比单元格数字更重要。

---

## Grammars

tree-sitter 补丁说明：[`grammars/`](./grammars/)（cobol / vbnet 等）。

---

## 维护约定

- **新增设计**：放 `design/`，并在本索引加一行。
- **已落地且不再指导日常开发**的长笔记：移到 `design/archive/`，文首标明 Archive。
- **改 agent 行为**：改 `src/mcp/server-instructions.ts` + CHANGELOG，不在 `docs/` 再写一份工具说明书。
