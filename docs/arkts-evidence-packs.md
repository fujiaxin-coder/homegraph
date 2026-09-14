# ArkTS 第一批证据包改动与验证

日期：2026-09-11。对应 Spec：`docs/specs/0029-arkts-evidence-packs.md`。

## 改了什么

以前，工具找到代码后可能只返回一段窗口或截断后的方法。现在，在已经定位到
ArkTS 符号的适用路径上，按完整声明及其关系依赖组装输出：能放下就完整返回，
放不下就明确列出缺口。希望减少模型为了补齐条件、被调用方法和注册位置而多走的轮次。

| 位置 | 实际改动 |
| --- | --- |
| `src/mcp/arkts-evidence-packs.ts` | 新增源码/关系/缺口类型和组装器。选择完整声明，关系同时携带两端及注册声明；共享源码只输出一次。用文件哈希校验索引范围，限制文件读取，过滤虚拟入口，标明 ArkUI 关系来源。 |
| `src/mcp/tools.ts` | 接入现有 compact、light mechanism 和符号 flow 路径。多步 planner 事先分配剩余预算；省略证据时不保留虚假的后续绑定。实际返回的源码范围才登记进会话；缓存源码先校验指纹。 |
| `src/mcp/query-cache.ts` | 缓存格式升到 4；开关开启/关闭使用不同缓存键，包括复用 compact 的 search。 |
| `src/mcp/server-instructions.ts`、工具描述 | 解释完整声明、静态关系和缺口的含义；继续按需使用图工具，缺什么查什么。 |
| `test/arkts-evidence-packs.test.ts` 等 | 覆盖条件/分支、关系依赖、预算、文件改动、越界、会话记录、多步 planner 和缓存；更新真实 ArkUI 回归的输出断言。 |

主要改动在 MCP 的证据选择和返回代码。没有增加模型调用，没有修改 planner 的
生成 prompt，也没有修改 codingeval 或预建索引流程。

本批不是新的 ArkTS 解析器。字面量/资源证据以及独立 usages/modules/native
工具仍走原有路径；图本身不能表达的关系仍会缺失。`complete` 仅指本次有限候选
和静态关系证据已提供，不能表示编码任务完成、行为正确或运行时顺序已证明。

## 使用和对照

独立工作目录：`smat051-evidence-packs-20260911`。已合入当时的上游 main
（`53591d3`，含 1.5.7 路径边界和索引状态提示修复），保留原 050 目录。

此目录 `npm run build` 后，将现有 MCP 启动配置中的 HomeGraph 程序路径指向
这里的 `dist/bin/homegraph.js`。原项目索引可复用；不需要为了本批重建索引。

- 默认启用本批证据包。
- 启动 MCP 前设置 `HOMEGRAPH_ARKTS_EVIDENCE_PACKS=0` 可使用旧渲染器。
- 更改开关后重启 MCP；每组实验使用新会话。
- 在同一 051 构建上切换开关，可单独比较本批影响。直接比较 050 和 051
  还会包含此次合入的上游修复。

读取上限：36 个候选、12 个展开锚点、48 条关系、8 个文件、单文件 512 KiB、
合计 2 MiB。正文仍受现有项目规模输出预算约束，标题、行号、关系和缺口都计入。
大型声明可能整体省略并给出定位线索，不能声称已经返回。

## 本地验证

- `npm run build` 通过。
- 16 个相关测试文件、138 项测试通过，包括真实 ArkAnalyzer 的 ArkUI 状态、
  生命周期、事件解析及 NAPI 回归；未运行整个仓库测试集。
- `node scripts/evidence-pack-smoke.cjs` 用自造的 ArkUI 按钮、条件状态更新和
  跨文件 Store 建立真实索引，然后执行 MCP ToolHandler，保存两种渲染结果到
  `validation/evidence-smoke.json`。两端方法、if/else 和 onClick 都被保留。
- `scripts/verify-headroom-evidence.py` 通过参数指定现有外部 Headroom adapter、
  Python 和 tokenizer，读取上述结果进行离线兼容检查。

Headroom 实际检查使用 0.37.0 的原 lossless-v2 策略：HomeGraph 完整证据正文
逐字节保持一致；合成的重复构建日志通过无损往返校验，本地 tokenizer 计数
843 → 20。结果保存在 `validation/headroom-compatibility.json`。

这是实际压缩器的兼容验证，不代表官方 codingeval 会自动启用 Headroom。
Headroom 仍属于外部运行链路，本批没有恢复 codingeval 的定制代码，也没有将
Python 压缩器加入 HomeGraph 服务的依赖。

这些检查不访问模型服务，不读取 benchmark 答案，不产生真实推理准确率或时延
结论。下一轮真实对照应比较正确率、总时长、模型轮次、补查次数和输入/输出 token，
并保留工具原始输出及 Gap；预建索引时间仍单独记录。
