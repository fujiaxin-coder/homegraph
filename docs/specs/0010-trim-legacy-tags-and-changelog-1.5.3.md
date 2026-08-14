# 0010 — 清理继承 CodeGraph 的旧 tag，并补全 CHANGELOG `[1.5.3]`


| 字段 | 内容 |
| --- | --- |
| 编号 | 0010 |
| 类型 | 变更（发布资产 / 文档） |
| 状态 | 已完成 |
| 日期 | 2026-08-14 |
| 范围 | Git tag（本地 + `origin`）；`CHANGELOG.md` 版本段结构。不改运行时代码、不 bump `package.json` |
| 关联 | 发包说明：[docs/RELEASE.md](../RELEASE.md)；CHANGELOG 写作约定：[AGENTS.md](../../AGENTS.md) Releases |


---

## 1. 背景与目标

本仓从上游 GitHub CodeGraph / HomeGraph 继承了大量历史 tag（`v0.7.x`–`v0.9.x`）。本项目只想在 GitCode 上维护 **自 `v1.4.1` 起** 的版本线，更旧的 tag 不应继续出现在本仓库的 tag 列表与发行版对比入口里。

同时，当前 `CHANGELOG.md` **缺少** `## [1.5.3] - …` 段：`1.5.3` 已发版（tag `v1.5.3` / npm `1.5.3`），但正文仍堆在 `[Unreleased]` 下（且与 `1.5.3` 之后的条目混在一起），导致：

- 发行版页与仓库 CHANGELOG 对不齐；
- `prepare-release.mjs` / 后续发版容易再次抽错段落。

**目标：**

1. 本仓库可见的版本 tag **最旧为 `v1.4.1`**；删除全部更旧的继承 tag（本地与远端）。
2. `CHANGELOG.md` 出现完整、可引用的 **`## [1.5.3] - 2026-08-11`** 段；`[Unreleased]` 只保留真正尚未发版的条目。

---

## 2. 范围

### 2.1 纳入

#### A. Tag 清理

| 动作 | 说明 |
| --- | --- |
| 保留 | `v1.4.1`、`v1.5.0`、`v1.5.1`、`v1.5.2`、`v1.5.3`（及之后按发版新增的 tag） |
| 删除 | 所有 **严格小于** `v1.4.1` 的版本 tag（当前仓库至少包括：`v0.7.6`–`v0.7.12`、`v0.8.0`、`v0.9.0`–`v0.9.9`） |
| 远端 | 对 `origin`（GitCode）执行 `git push origin --delete <tag>`（或等价批量删除）；删除后 `git ls-remote --tags origin` 中不再出现上述旧 tag |
| 本地 | `git tag -d <tag>`，避免开发机继续推回旧 tag |

**不删除提交历史**：只删 tag 引用，不 `filter-repo` / 不改写 commit。

**GitCode 发行版页**：若平台上仍挂着对应旧 Release，实现时一并在 Web UI 删除（或注明需维护者手动删），避免「tag 没了、发行版还在」。

#### B. CHANGELOG 补全 / 整理

| 动作 | 说明 |
| --- | --- |
| 新增段 | 在 `[Unreleased]` 与 `## [1.5.2]` 之间插入 `## [1.5.3] - 2026-08-11` |
| 正文来源 | 以已发布的 npm `@1.5.3` 包内 `CHANGELOG.md` 的 `[1.5.3]` 段为权威副本（或与 tag `v1.5.3` 检出内容交叉核对）；按仓库惯例保留 `### New Features` / `### Breaking Changes` / `### Fixes` |
| Unreleased | 仅保留 **1.5.3 发版之后** 的条目（例如 docs hub / addon / locator 等尚未进 1.5.3 的工作）；去掉重复的 `### New Features` 标题堆叠 |
| 链接引用 | 文末增加 `[1.5.3]: https://gitcode.com/ProgramAnalysis/homegraph/tags/v1.5.3`；不手写未发版版本的链接 |
| 更旧段 | **不**从 CHANGELOG 删除 `1.4.1` 及以后已有正文；**不**要求回填 CodeGraph `0.x` 发行说明（与「不维护旧 tag」一致：文档最旧版本说明停在本仓维护起点即可） |

### 2.2 不纳入

- 不 bump `package.json` / 不发新 npm 版。
- 不重写 `1.5.2` / `1.5.1` / `1.5.0` / `1.4.1` 已发布正文（除非发现明显错挂段落，再单开说明）。
- 不修复 GitCode「tag 对比显示 0 提交」的平台 bug（可在 RELEASE/本 Spec 备注：对比请用 `git log v1.5.2..v1.5.3`）。
- 不改 `scripts/prepare-release.mjs` 行为（本 Spec 只保证 CHANGELOG 结构再次符合「Unreleased → 已发版段」约定）。

---

## 3. 约束与风险

1. **删远端 tag 不可轻易恢复**：删除前列出完整名单，PR/实现记录中贴 `git tag -l` 前后对照；需要恢复时只能从其他镜像或本地备份重新 `git push origin <tag>`。
2. **克隆缓存**：其他开发者本地仍可能残留旧 tag；实现说明中写一句：`git fetch --prune --prune-tags origin`（或手动 `git tag -d`）。
3. **CHANGELOG 误搬**：把 post-1.5.3 条目误塞进 `[1.5.3]`、或把 1.5.3 条目留在 Unreleased，都会让下次 `prepare-release` 抽错笔记 — 验收必须以 npm `1.5.3` 段为对照清单勾选。

---

## 4. 验收标准

- [x] `git tag -l 'v*'`（本仓）按版本排序后，**最旧为 `v1.4.1`**；不存在任何 `v0.*` tag。
- [x] `git ls-remote --tags origin` 同样不再列出已删除的 `v0.*` tag；保留的 `v1.4.1`…`v1.5.3` 仍可解析到原提交。
- [x] `CHANGELOG.md` 含 `## [1.5.3] - 2026-08-11`，且该段 New Features / Breaking Changes / Fixes 与已发布 `1.5.3` 笔记实质一致（允许空白/标点归一）。
- [x] `[Unreleased]` 不再包含应属于 `1.5.3` 的条目；无重复空 `### New Features` 块。
- [x] 文末存在 `[1.5.3]: https://gitcode.com/ProgramAnalysis/homegraph/tags/v1.5.3` 链接引用。

---

## 5. 回滚

- Tag：从备份或其它仍持有旧 tag 的 clone 重新 `git push origin refs/tags/<tag>`。
- CHANGELOG：`git checkout -- CHANGELOG.md`（或还原本 Spec 实现 commit）。
