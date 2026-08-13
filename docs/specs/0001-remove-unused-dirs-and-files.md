# 0001 — 删除未使用的目录和文件

| 字段 | 内容 |
| --- | --- |
| 编号 | 0001 |
| 类型 | 需求 |
| 状态 | 已完成 |
| 日期 | 2026-08-06 |
| 范围 | `homegraph` 仓库（不含 `node_modules/`、`dist/` 等生成物） |

---

## 1. 背景与目标

仓库在独立演进过程中积累了若干**当前产品路径不再依赖**的目录与文件（上游遗留、品牌资产、未接入构建/发布的内容、死代码旁路等）。本需求要求系统清理这些未使用项，降低维护噪声、缩小认知面，并避免误把废弃资产当成有效依赖。

**目标：**

1. 识别并删除未使用的目录与文件；
2. 同步清理对已删路径的引用（文档、脚本、CI、包配置等）；
3. 删除后仓库仍可正常构建、测试与发布。

---

## 2. 「未使用」判定标准

满足以下**任一**条件即可纳入删除候选；最终删除前须对照「不得删除」清单复核。

| 条件 | 说明 |
| --- | --- |
| 无运行时/构建引用 | 不被 `src/`、`package.json` scripts、`copy-assets`、CLI/MCP 入口引用 |
| 无测试引用 | 不被 `test/`、评测脚本、fixtures 依赖 |
| 无发布面引用 | 不进入 npm `files`、安装脚本、文档站构建产物 |
| 无文档/CI 必要引用 | README、站点、workflow 可去掉且不影响使用说明 |
| 产品边界外 | 已明确不在当前产品支持范围内的旁路资产（经确认后） |

**不得删除（硬约束）：**

- 仍被构建、测试、安装或 MCP/CLI 路径引用的文件；
- MIT 合规所需的版权与许可声明（如 `LICENSE` 中的原作者声明）；
- 仅「暂时不用」但有明确保留计划的归档（应移出主路径或标注，而非静默删错）。

---

## 3. 范围

### 3.1 纳入

- 仓库根及一级子目录下的源码、文档、静态资源、脚本、CI 配置等**版本库内**路径；
- 对已删路径的交叉引用清理（含注释中的过时路径指引，若会导致误导）。

### 3.2 不纳入（本需求不直接处理）

- `node_modules/`、`dist/`、本地 `.homegraph/` 等忽略/生成目录；
- 依赖包版本升级或功能裁剪（另开需求）；
- 语言/能力的大规模产品裁撤（若涉及，需单独 spec，并在本需求中仅删除已确认无引用的残留）。

---

## 4. 执行要求

1. **先盘点、后删除**：输出候选清单（路径 + 判定依据 + 引用检查结果），确认后再删。
2. **引用清零**：删除文件时同步改掉所有仍指向该路径的引用；禁止留下断链。
3. **最小变更**：只删未使用项及必要引用修复，不做无关重构。
4. **可验证**：删除后至少执行 `npm run build` 与相关测试（或说明为何某套测试不适用）。
5. **可追溯**：变更说明中列出已删路径摘要与验证结果。

---

## 5. 验收标准

- [x] 存在书面盘点结果（可附在 PR/提交说明或后续 spec 附录）；
- [x] 候选项均已按 §2 判定，无「不得删除」项被误删；
- [x] 仓库内对已删路径无残留必要引用（构建/测试/文档主路径无断链）；
- [x] `npm run build` 通过；约定回归测试通过；
- [x] 未引入与本需求无关的行为变更。

---

## 6. 非目标

- 不借机重写架构或更换技术栈；
- 不删除「仍被可选路径使用」但文档未写全的能力，除非先完成引用与产品确认；
- 不修改 git 历史以抹除已删文件。

---

## 7. 后续

盘点与产品确认已完成（状态「已确认」）。实现时按附录 A.1 删除并做引用清零；遥测链路按 A.2 / A.3 **保留**。

---

## 附录 A — 盘点结果（2026-08-06）

盘点方法：对照 §2 判定标准，检查 `package.json` scripts / `files`、`.github/workflows/*`、`src/`、`test/`、根 README 与主要文档交叉引用。生成物（`node_modules/`、`dist/`、`.homegraph/`）不纳入。

当前发布路径（`.github/workflows/release.yml`）为**单包 npm**（`files: ["dist","README.md"]`），不再构建/发布自包含 bundle；根 README 已改为中文产品说明，**不再引用** `assets/` 中的 waitlist / 语言图标。

### A.1 确认删除清单

| 路径 | 判定依据 | 引用检查 | 删除时须同步清理 |
| --- | --- | --- | --- |
| `assets/`（整目录，含 `waitlist.svg`、`languages/*.svg`、`generate-language-tiles.py`、已跟踪的 `__pycache__/*.pyc`） | 无运行时/构建/测试/发布引用；README 无图片引用；`package.json` `files` 不含；属上游 README 品牌资产残留 | `src/` / `test/` / workflows / `package.json` 无引用；仅 `AGENTS.md` 示例与 `.gitignore` 提及 | 更新 `AGENTS.md` 中 `assets/waitlist.svg` 示例；删除 `.gitignore` 中已无意义的 `assets/generate-waitlist.py` / `assets/__pycache__/` 专条（保留通用 `**/__pycache__/`、`*.pyc`） |
| `site/`（整目录） | 产品文档站为上游品牌（`colbymchenry` / `@colbymchenry/homegraph`）；本仓 README / `docs/local-dev-guide.md` 不链接；不进 npm 包 | 仅 `.github/workflows/deploy-site.yml` 消费 | 一并删除 `deploy-site.yml` |
| `.github/workflows/deploy-site.yml` | 仅部署上述 `site/` 至 GitHub Pages；本 fork 无对应站点交付 | 无其它引用 | 随 `site/` 删除 |
| `docs/plans/`（`2026-04-24-framework-resolver-extract.md`） | 历史实现计划，已被 `docs/specs/` SDD 流程替代；无构建/测试/CI 引用 | 仓库内无指向该路径的必要引用 | 无 |
| `BUNDLING.md` | 描述已不存在的 `scripts/build-bundle.sh` / `scripts/pack-npm.sh`；与当前 `release.yml` 单包路径矛盾；属过时发布文档 | 无代码 import；`AGENTS.md` Releases 段仍有过时表述 | 修正 `AGENTS.md` Releases 段与 `src/extraction/wasm-runtime-flags.ts` 等对已删脚本/bundle 的提及 |
| `assets/__pycache__/generate-waitlist.cpython-313.pyc` | 误入版本库的 Python 缓存；`.gitignore` 已忽略同类路径但该文件已被 track | 无任何功能引用 | 随 `assets/` 删除即可 |
| `install.sh`、`install.ps1` | **产品已确认删除。** 独立安装脚本仅服务自包含 bundle；当前 release **不再产出** bundle，安装面以 `npm i -g homegraph` 为准 | `src/upgrade/`（`INSTALL_SH_URL`、bundle 升级分支）、`test/install-sh-prune.test.ts`、`test/upgrade.test.ts` / `remove-binary.test.ts` 中的 bundle 路径仍引用 | **必须**退役 bundle 安装/升级通道后再删文件：见下方「实现约束」 |

**`install.sh` / `install.ps1` 实现约束（不可只删文件）：**

1. 删除根目录 `install.sh`、`install.ps1`；
2. 调整 `src/upgrade/`：去掉对 `INSTALL_SH_URL` / 重跑 install 脚本的依赖；`kind: 'bundle'` 检测若仍保留，升级应改为明确报错并引导改用 npm（或同等清晰提示），不得再 curl 已删脚本；
3. 删除或改写 `test/install-sh-prune.test.ts`；同步收紧 `test/upgrade.test.ts`、`test/remove-binary.test.ts` 中仅服务于 install.sh 路径的用例；
4. 清理 `src/bin/homegraph.ts`、`src/upgrade/remove-binary.ts` 等注释/文案中对 standalone installer 的过时指引；
5. `CHANGELOG` 历史条目不必改写。

**规模约计：** `assets/` ~37 tracked files；`site/` ~32；`install.sh` + `install.ps1` + 相关代码/测试改动；其余为单文件/单 workflow。

### A.2 确认保留

| 路径 | 保留理由 |
| --- | --- |
| `src/**`、`test/**`（除上表须改写/删除的 install/bundle 相关测试外）、`scripts/agent-eval/**`、`scripts/add-lang/**`、`scripts/prepare-release.mjs`、`scripts/extract-release-notes.mjs` | 构建、测试、评测或 Release CI 直接使用 |
| `scripts/exp_boundary_eval/**`、`scripts/ohos-sdk-publish.mjs`、`scripts/mirror-to-github.js`、`scripts/local-install.sh`、`scripts/index-peak-mem.ps1` | 本 fork 评测 / OHOS / 镜像 / 本地安装工具；有文档或明确用途 |
| **遥测整条链路：** `telemetry-worker/`、`TELEMETRY.md`、`docs/design/telemetry.md`、`src/telemetry/**` | **产品已确认保留**（2026-08-06）。客户端仍在 CLI/installer/MCP 路径中；Worker 为可审计 ingest 源码 |
| `docs/benchmarks/**`、`docs/design/**`、`docs/grammars/**`、语言验证指南（现 `docs/guides/language-verification.md`，原 `docs/SEARCH_QUALITY_LOOP.md`）、`docs/local-dev-guide.md`、`docs/homegraph-principles.md` | 被 `AGENTS.md` / 设计 playbook / 语言补丁说明引用；属工程文档而非死资产 |
| `LICENSE`、`CHANGELOG.md`、`AGENTS.md`、`DEVELOPMENT.md`、`CLAUDE.md`（指向 AGENTS 的薄包装，见 0002） | 合规、发布说明或 Agent 向导 |

### A.3 产品确认结论（原待确认项）

| 项 | 结论 | 日期 |
| --- | --- | --- |
| `install.sh`、`install.ps1`（及 bundle 独立安装通道） | **删除**；实现时按 A.1 约束同步改 upgrade/测试 | 2026-08-06 |
| 遥测整条链路 | **保留**；本需求不改遥测行为 | 2026-08-06 |

### A.4 推荐实现顺序

1. **低风险文档/品牌资产：** `assets/`、`site/`、`deploy-site.yml`、`docs/plans/`、`BUNDLING.md` + 对应引用清理。
2. **bundle 安装退役：** 按 A.1「实现约束」改 `src/upgrade/` 与相关测试 → 再删 `install.sh` / `install.ps1`。
3. **验证：** `npm run build`、`npm test`。
4. **不在本需求范围：** 遥测关闭或改造。

### A.5 验收对照

- [x] 书面盘点结果已写入本附录；
- [x] 原待确认项已产品拍板（A.3）；
- [x] 删除实现已落地：A.1 路径删除 + bundle 升级退役 + 引用清零；`npm run build` 通过；相关回归（`upgrade` / `remove-binary` / `installer*` / `wasm-runtime-flags`）通过。全量 `npm test` 中 ArkTS 套件失败为环境侧（SDK/batch 无索引），与本清理无关。
