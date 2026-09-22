# 053：找对目标，区分源码证据与需求行为

基线：052 的 `fe81141`。本目录独立开发，未修改旧版 HomeGraph 或 codingeval。
本轮落实准确率分析中的 P0-A、P0-B；没有启动模型推理实验。
发布 develop 前按用户要求合并了远端 main `2ebe761`，包含 1.5.8 的运行时、索引状态及 JSON5 修复；合并后构建通过，304 项相关测试已验证通过，真实索引和 Headroom 检查通过；记录位于 `validation/main-merge/REPORT.md`。
准确率 Spec 编号更新为 [0049](./specs/0049-arkts-accuracy-contracts.md)，避免与 main 新增文档重号。

## 改了哪里

| 位置 | 改动 | 例子 |
| --- | --- | --- |
| `src/search/query-plan-provider.ts`、`request-contract.ts` | Planner 可输出页面、文案、对象类别、已有/待新增目标和行为要求；原文字段必须来自 query/taskContext，格式错误回退规则规划 | “账户设置”的“保存”保留两个独立目标，不只变成宽泛的 save 关键词；“继续提交”若是新文案，搜不到不是错误 |
| `src/search/query-plan.ts` | 原文文案不会因 planner 返回空数组而丢失；独立定位步骤保留原文提示，后续依赖步骤保留已找到节点的身份 | 找到页面后追到 Store，Store 没有按钮文字也不会因此丢失绑定 |
| `src/search/literal-evidence.ts` | 同一行的不同文案分别保留，每个文件/文案最多找三个出现位置 | 前面注释里提到“保存”，不会直接遮住后面的真实按钮；原有全局搜索预算仍有效 |
| `src/mcp/arkts-evidence-packs.ts`、`request-evidence.ts` | 在已读取、指纹一致的源码上核对目标，优先选择同文件共同出现的页面/控件目标；把需求检查摘要纳入整包预算 | 两个页面都有“保存”，同时含有“账户设置”的候选优先；只凭文件名或注释不确认目标 |
| `src/mcp/request-evidence.ts` | 对明确定位的 ArkUI 控件检查直接 `.enabled(...)` 修饰；区分观察到绑定、未观察到绑定和未知 | 灰色背景、替换图标、点击时提前 return 都不等于已证明控件的启用状态 |
| `src/mcp/tools.ts` | 接入原有 explore；保留精确 usages/modules/native 查询；资源文案继续走“资源值—key—源码引用”输出，资源证据优先于同文件普通文案 | 不增加必须调用的新工具；避免普通文案先占掉文件的输出名额，导致资源映射被省略 |
| `src/mcp/query-cache.ts` | 新字段/开关进入缓存标识；启用检查的 contract 请求不读写结果缓存 | 不把上次未找到目标的结果或旧绑定结论当作当前事实 |
| `src/mcp/server-instructions.ts` | 提醒核对页面与行为缺口，继续编码和验证 | 源码包完整、调用链连通都不代表需求已完成 |

## 模型能看到什么

在返回完整、当前 ArkTS 声明的 explore 中，正文新增 **Request evidence**，结构化内容在
`_meta.homegraphEvidencePacks.requestEvidence`。已有的源码/关系完整性字段保持兼容。

- 目标：`observed`、`ambiguous`、`not_observed`、`requested_not_observed`。它们只描述返回范围中的原文证据，不认证页面业务归属。
- 行为：`binding_observed`、`binding_not_observed`、`unknown`。
- `runtimeVerified` 固定为 `false`。即使有 `.enabled(this.ready)`，条件正确性、状态更新和运行效果仍未证明。

例如：

```ts
Button('保存')
  .backgroundColor(this.ready ? 'blue' : 'gray')
  .onClick(() => { if (!this.ready) return; this.save(); })
```

对这个已定位控件，返回“未观察到直接 enabled 绑定”，提示核对父级启用状态或补齐所需绑定。
改成 `.enabled(this.ready)` 后，只报告观察到了绑定，不报告“功能通过”。
父级禁用、封装组件和自定义修饰器可能影响实际状态，因此 `binding_not_observed` 也不是功能失败判定。

## 保守边界

- 本轮是有界静态检查，不是新的 ArkTS 编译器、全量数据流分析或运行测试。
- 目标匹配只认当前声明内的精确字符串/代码标识符；忽略注释、字符串化代码。页面和按钮先按同文件共同证据排序；行为确认要求页面目标与控件出现在同一条完整返回声明中。不能跨两个不相关声明借用页面身份。
- `ui` / `form` / `native` 只通过有限框架源码迹象核对。例如桌面卡片要求直接 `extends FormExtensionAbility`，普通可视 Card 名字不足以证明身份；别名或间接继承可能仍未知。
- 图标资源、翻译资源、仅有自然语言描述而无法绑定到具体控件、插值模板、无法完整解析的声明、多重同名控件、重复/常量 enabled 修饰均可能返回未知。资源间接引用保留原有检索结果，本轮没有为其新增行为验证结论。
- 其余 visibility/event/state/route/runtime 要求保留为待验证项。本轮不会自动判断生命周期、异步顺序或 Native 运行效果。
- 只检查实际返回且指纹有效的源码。预算不足整包省略，旧源码不产生正面行为证据。返回范围以外的需求不能由本检查排除。
- Planner 新字段可选，旧格式继续兼容；规则 fallback 的引号目标统一标为待确认的新/请求文字，不擅自判断其已经存在。规则 fallback 只识别少量启用/禁用行为词，不能覆盖全部需求。
- 通用定位阶段先核对目标；明确 flow / 有依赖节点时继续使用 052 的定向路径机制。精确 usages/modules/native 与资源引用保留各自既有逻辑。

## 开销与开关

保持已有 planner 触发条件，不增加模型请求次数。启用可选 LLM planner 时，输出上限由 900 调到 1500 token 以容纳结构字段；这不等于每次实际使用 1500 token。新增提示词、检查摘要和局部扫描会有开销，本轮不能据此宣称时延下降。

- `HOMEGRAPH_ACCURACY_TARGETS=0`：关闭目标检查与候选加权；默认开启。
- `HOMEGRAPH_ACCURACY_COVERAGE=0`：关闭行为证据摘要；默认开启。
- 依赖已有 `HOMEGRAPH_ARKTS_EVIDENCE_PACKS`。关闭证据包时不输出新增行为检查。
- 两项开关只用于拆分贡献；精确 052 对照请使用原 052 目录，因为原文保留、字面检索修复仍在 053 中。
- 不改变每题预建索引及其计时，不修改 codingeval 的 prompt、工具、预算或执行流程。

Headroom 使用现有外部 0.37.0 lossless-v2 adapter：HomeGraph 返回的源码、约束、缺口和行为摘要整体保护，重复构建日志仍可无损压缩。本仓没有安装新代理或自动更改实验机的 Headroom 配置。

## 验证与复现

```bash
npm ci
npm run build
node node_modules/vitest/vitest.mjs run test/request-*.test.ts test/query-plan*.test.ts test/literal-evidence.test.ts test/arkts-evidence-packs.test.ts test/evidence-rendering.test.ts test/evidence-recovery-wire.test.ts test/mcp-query-cache.test.ts test/server-instructions-path-first.test.ts test/arkts-query-paths.test.ts
node scripts/accuracy-contract-smoke.cjs
python -B scripts/verify-headroom-evidence.py \
  --adapter /path/to/headroom_adapter.py --python /path/to/headroom-python \
  --tokenizer /path/to/tokenizer.json --evidence validation/accuracy-smoke.json \
  --result-key binding --output validation/headroom-accuracy-compatibility.json
```

本机构建通过，15 个相关测试文件共 **245 项测试通过**，其中新增 40 项针对原文约束和行为证据的检查。记录见 `validation/build.log` 和 `validation/regression.log`。

合成 smoke 使用真实 ArkAnalyzer 建索引和真实 SQLite，planner 为固定响应夹具，不调用外部模型。
验证“仅外观 → 修改后旧索引 → 重建索引后有绑定”，中间 MCP 结果保存在 `validation/accuracy-smoke.json`。
Headroom 的 `validation/headroom-accuracy-compatibility.json` 验证完整结果逐字节不变；合成日志的压缩量不代表 benchmark token 收益。

开发测试、smoke 和运行时不读题号、隐藏测试、标准补丁或参考答案。准确率是否提升，需要后续对同一模型、同一题集的真实推理对照检验。
