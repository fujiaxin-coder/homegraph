# HomeGraph A/B 测评怎么做

索引：[docs/README.md](./README.md)。Spec 锚点：[0010](./specs/0010-external-ab-eval-harness.md)。

本文只说明**选哪套、去哪跑、报告看哪**。环境安装、参数全集、脚本逻辑以对应代码仓 README 为准，不在本仓重复维护。

---

## 选哪套

| 你要测什么 | 仓库 | 操作说明（必读） |
| --- | --- | --- |
| 代码问答：有 HomeGraph vs 无（准确率、耗时、token、工具步等） | [homegraph_eval](https://gitcode.com/fujiaxin/homegraph_eval) | [README](https://gitcode.com/fujiaxin/homegraph_eval/blob/master/README.md) |
| ArkTS UI 增量：不开 HG（`none`）vs 开 project 源（`project`） | [arkts_benchmark](https://gitcode.com/fujiaxin/arkts_benchmark) | [scripts/homegraph-ui-ab/README.md](https://gitcode.com/fujiaxin/arkts_benchmark/blob/master/scripts/homegraph-ui-ab/README.md) |
| 通用语言 / 动态分发 flow（Claude Code） | 本仓 | `scripts/agent-eval/`、[`.claude/skills/agent-eval`](../.claude/skills/agent-eval/SKILL.md) |

三套宿主、题集、指标不同，结论不要硬拼。

---

## 1. 代码问答 A/B（homegraph_eval）

1. Clone [homegraph_eval](https://gitcode.com/fujiaxin/homegraph_eval)。
2. 打开该仓 [README](https://gitcode.com/fujiaxin/homegraph_eval/blob/master/README.md)：装依赖、配 Judge Key、指定被测仓库与 HomeGraph（本仓 `dist` 或 npm）。
3. 按 README 跑 `run_pipeline.py ab ...`；中断后出报告、合并批次、重生成 HTML 等步骤也只跟那份 README。
4. 报告优先看 `result/report-*-homegraph-*.html`（版式说明见 README「HTML 报告长什么样」）。

---

## 2. UI 增量 A/B（arkts_benchmark）

1. Clone [arkts_benchmark](https://gitcode.com/fujiaxin/arkts_benchmark)。
2. 打开 [homegraph-ui-ab/README.md](https://gitcode.com/fujiaxin/arkts_benchmark/blob/master/scripts/homegraph-ui-ab/README.md)：准备 bun、DevEco、已 build 的 HomeGraph。
3. 在该仓**根目录**按 README 跑一键脚本（如 `run-full-ui-ab.ps1`）或文档中的其它入口。
4. 报告优先看 `artifacts_deveco/homegraph-ui-ab/report-homegraph-ab-latest.html`。

---

## 3. 仓内 agent-eval

本仓改动涉及通用检索 / 动态分发时，用 `scripts/agent-eval/`（见 skill 与 [dynamic-dispatch-coverage-playbook](./design/dynamic-dispatch-coverage-playbook.md)），与上面两套并行。

---

## 约定

- **怎么跑、参数、可比口径**：只改外部仓 README；本指南仅在换仓或换路径时更新链接。
- 写进 PR / 报告时注明：宿主、模型、HomeGraph 版本（local 路径或 npm 版本）、题集或 suite。
