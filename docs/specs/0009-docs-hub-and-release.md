# 0009 — 文档枢纽、发包说明与 docs 清洗


| 字段 | 内容 |
| --- | --- |
| 编号 | 0009 |
| 类型 | 文档 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-08-13 |
| 范围 | `docs/` 索引与清理；发包/发行版说明；与根目录 `DEVELOPMENT.md` / `AGENTS.md` 的交叉链接。不改运行时代码 |
| 关联 | 协作流程：[DEVELOPMENT.md](../../DEVELOPMENT.md)；Agent 架构约束：[AGENTS.md](../../AGENTS.md) |


---

## 1. 背景与目标

新人分不清「写 Spec / commit」「本地构建」「npm 发包」「GitCode 发行版 / 镜像」；`docs/` 下命名混乱（如 `SEARCH_QUALITY_LOOP.md` 实为语言验证指南）、已落地事故笔记与进行中设计混放，缺少入口索引。

**目标：**

1. 增加 **`docs/README.md`** 作为文档枢纽（读什么、过时放哪）。
2. 增加 **`docs/RELEASE.md`**：npm/GitHub Actions 发包 + GitCode 发行版 + 镜像失败排查；**不**重复抄写完整 SDD（链到 `DEVELOPMENT.md`）。
3. 清洗：重命名误导文件名、归档已结案设计笔记、修正过时交叉链接；**不**删除仍被 playbook / 脚本 / AGENTS 引用的基准与设计文。
4. 根文档（`DEVELOPMENT.md` / `AGENTS.md` / `README.md` / `local-dev-guide.md`）互相指向枢纽与发包页。

---

## 2. 范围

### 2.1 纳入

| 动作 | 说明 |
| --- | --- |
| 新增 | `docs/README.md`、`docs/RELEASE.md` |
| 重命名 | `SEARCH_QUALITY_LOOP.md` → `docs/guides/language-verification.md` |
| 归档 | `design/main-thread-stall-followup.md`、`design/agent-homegraph-adoption.md` → `docs/design/archive/`（文首标明历史） |
| 链接 | DEVELOPMENT / AGENTS Releases 段瘦身为指针；README / local-dev-guide 链枢纽 |
| CHANGELOG | `[Unreleased]` 一条 docs 说明 |

### 2.2 不纳入

- 不合并 `value-reference-edges.md` 与 playbook（故意：设计 vs 操作手册）。
- 不删除 `benchmarks/**`、`dynamic-dispatch-coverage-playbook.md`、`grammars/**`、`homegraph-principles.md`。
- 不改 npm 包内容清单、不 bump 版本、不触发发版。
- 不重写 `homegraph-principles.md` 正文（仅索引）。

---

## 3. 验收标准

- [x] `docs/README.md` 列出 Start here / Specs / Guides / Design / Archive / Benchmarks / Grammars；**不**硬编码「当前最新 Spec」编号。
- [x] `docs/RELEASE.md` 只写要发包干什么：npm=`homegraph` + Actions；GitCode 发行版不必从 GitHub 下载再上传；镜像失败排查极简。
- [x] `DEVELOPMENT.md` 链到 docs 枢纽与 RELEASE；SDD/commit 仍以 DEVELOPMENT 为唯一正文。
- [x] `AGENTS.md` Releases 指向 `docs/RELEASE.md`，避免双份长文漂移；包名与 npm 一致。
- [x] 误导文件名已改；归档文在 `design/archive/`；仓库内断链已修。
- [x] CHANGELOG `[Unreleased]` 有用户可读 docs 条目。

---

## 4. 回滚

还原本 Spec 新增/移动的 markdown 与链接即可；无代码行为回滚。
