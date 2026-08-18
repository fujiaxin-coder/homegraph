# 开发工作流

本文约定 HomeGraph 仓库的日常协作流程：**SDD（Spec-Driven Development）**、代码拉取、Commit 规范、PR 检查清单。  
本地构建与 CLI/MCP 用法见 [docs/local-dev-guide.md](./docs/local-dev-guide.md)；**发包 / 发行版**见 [docs/RELEASE.md](./docs/RELEASE.md)；文档目录见 [docs/README.md](./docs/README.md)；Agent 向架构约束见 [AGENTS.md](./AGENTS.md)。

---

## 1. SDD 开发流程

功能与非琐碎改动采用 **先 Spec、后实现**：先把需求写成可评审的规格，再开分支写代码。Spec 是范围、验收与评审的共同锚点。

### 1.1 总览

```text
同步 main → 编写/更新 Spec（docs/specs/）→ 评审确认 Spec
    → 开分支实现 → build + test → commit → PR（关联 Spec）→ 合入
```

**硬规则：未写入 `docs/specs/` 的 Spec，不开始实现**（纯笔误/typo、单行文案、已有 Spec 覆盖的微小跟随修复除外，见 §1.5）。

### 1.2 Spec 落盘位置与命名

| 项 | 约定 |
| --- | --- |
| 目录 | [`docs/specs/`](./docs/specs/) |
| 文件名 | `<四位编号>-<english-slug>.md` |
| 编号 | 从 **0001** 起，按目录内已有最大编号 **+1** 增序，不复用、不跳号抢占 |
| english-slug | 简短英文短语（kebab-case），与标题语义对应；仅用小写字母、数字与 `-`，不用空格与中文 |

示例：

- `docs/specs/0001-remove-unused-dirs-and-files.md`
- `docs/specs/0002-rename-claude-md-to-agents-md.md`

新建前先查看目录，取下一编号：

```bash
ls docs/specs/
# 若已有 0001-….md，则下一份为 0002-<english-slug>.md
```

### 1.3 Spec 应写清什么

建议至少包含：

1. **元信息**：编号、类型（需求/设计/变更）、状态（草案/已确认/已完成）、日期、范围  
2. **背景与目标**：要解决什么、成功长什么样  
3. **范围**：纳入 / 不纳入（非目标）  
4. **行为或约束**：判定标准、接口/兼容、错误与边界（按改动类型裁剪）  
5. **执行要求**（可选）：分步、风险、回滚  
6. **验收标准**：可勾选清单，PR 合入前应对齐  

参考现有样例：[0001-remove-unused-dirs-and-files.md](./docs/specs/0001-remove-unused-dirs-and-files.md)。

### 1.4 阶段约定

| 阶段 | 动作 | 产出 |
| --- | --- | --- |
| Spec | 在 `docs/specs/` 新增或修订 Spec；状态先标「草案」 | `NNNN-….md` |
| 对齐 | 与需求方/评审确认目标与验收；必要时改 Spec | 状态 →「已确认」 |
| 实现 | 从已确认 Spec 开分支编码；实现偏离时先改 Spec 再改代码 | 代码 + 测试 |
| 合入 | PR 描述关联 Spec 路径；对照验收清单勾选 | Spec 状态 →「已完成」（可同 PR 更新） |

同一需求若需拆「需求 Spec」与「设计/实现说明」，编号继续增序（如 `0001-…` 需求、`0002-…` 设计），并在文内互相链接。

### 1.5 何时可以不写新 Spec

以下可跳过新建 Spec（仍建议在 PR 说明原因）：

- 错别字、格式、断链等纯文档笔误  
- 测试/CI 的机械修复且行为不变  
- 已有 Spec 明确覆盖、且本 PR 仅为该 Spec 的直接实现或验收修补  

拿不准时：**先写 Spec**。

---

## 2. 代码拉取

### 2.1 首次克隆

```bash
git clone git@gitcode.com:ProgramAnalysis/homegraph.git
cd homegraph
npm ci
npm run build
```

Node 要求：`>=22`（与 `package.json` `engines` 一致；推荐 22.5+）。多 major 兼容性自测：

```bash
npm run test:node-matrix          # 默认 22 23 24 25（需本机 nvm）
./scripts/test-node-matrix.sh 22 25   # 子集
```

### 2.2 日常同步 `main`

开新分支或合入前，先把本地 `main` 对齐远端：

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
```

优先 `--ff-only`：若无法快进，先排查本地是否有未推送提交，再决定 rebase / 合并，避免无意产生多余 merge commit。

### 2.3 功能分支更新

在特性分支上跟上最新 `main`：

```bash
git fetch origin
git rebase origin/main
# 或（团队约定允许时）
# git merge origin/main
```

有冲突时：解决 → `git add` → `git rebase --continue`（rebase）或完成 merge commit（merge）。  
**不要**对已推送且他人基于其上的公共历史做 `rebase -i` / force-push，除非明确协调。

### 2.4 建议节奏

| 场景 | 做法 |
| --- | --- |
| 开始新需求 | 先写 Spec（§1）→ 从最新 `main` 拉出分支：`git checkout -b <type>/<short-desc>` |
| 开发中期 | 定期 `fetch` + `rebase`/`merge`，减小冲突面 |
| 提 PR 前 | 再同步一次 `main`，本地 `build` + 相关测试通过后再推 |

分支命名示例：`feat/mcp-diff-impact`、`fix/arkts-watchdog`、`docs/dev-workflow`、`chore/cleanup-unused`。

---

## 3. Commit 规范

采用 [Conventional Commits](https://www.conventionalcommits.org/) 风格，便于 CHANGELOG 归类与评审扫读。

### 3.1 格式

```text
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

- `type`：必填（见下表）
- `scope`：可选，模块名（如 `mcp`、`arkts`、`installer`、`db`）
- `subject`：祈使句、现在时；英文或中文均可，同一 PR 内保持一致；**不加**句末句号
- 首行建议 ≤ 72 字符
- **SDD 实现类 commit** 须在 footer 用固定格式关联 Spec（见 §3.3）

### 3.2 Type 一览

| type | 用途 |
| --- | --- |
| `feat` | 新功能（用户/Agent 可感知） |
| `fix` | Bug 修复 |
| `docs` | 仅文档（含本工作流、站点文案、`docs/specs/`） |
| `refactor` | 重构，无行为变化意图 |
| `perf` | 性能优化 |
| `test` | 仅测试 |
| `chore` | 构建、依赖、杂项（不含发布 bump） |
| `ci` | CI / workflow |
| `release` | 版本与发布相关（如 lock 同步）；日常功能勿用 |

### 3.3 Spec 关联（commit footer）

按 SDD 落地的实现 / 验收修补类 commit，**必须**在 message footer 用下列固定行关联 Spec（与 Conventional Commits trailer 同形：`Token: value`）：

```text
Spec: docs/specs/<NNNN>-<english-slug>.md
```

规则：

| 项 | 约定 |
| --- | --- |
| 关键字 | 固定为 `Spec:`（大小写敏感；后面一个空格） |
| 路径 | 相对仓库根目录；与磁盘文件一致，含四位编号与 slug |
| 多 Spec | 每行一条 `Spec:`；勿写成逗号拼接 |
| 空行 | footer 与 subject（或 body）之间空一行 |
| 何时必填 | 实现已确认 Spec、或该 Spec 的直接验收修补 |
| 何时可省略 | §1.5 豁免项；以及**仅新增/修订 Spec 文档本身**的 `docs:` commit（可选仍写 `Spec:` 自指） |

完整示例：

```text
feat(mcp): prefer homegraph serve mcp, keep serve --mcp compatible

Spec: docs/specs/0003-prefer-serve-mcp-subcommand.md
```

多 Spec：

```text
fix(arkts): pause watchdog during Scene build to avoid false unresponsive

Spec: docs/specs/0004-arkts-scene-watchdog.md
Spec: docs/specs/0005-arkts-build-lifecycle.md
```

仅落盘 Spec（可省略 footer）：

```text
docs: add spec for prefer serve mcp subcommand
```

### 3.4 示例（无 Spec / 豁免）

```text
docs: add SDD workflow and spec naming under docs/specs

chore: remove unused assets after inventory
```

### 3.5 注意

- **一条 commit 一件事**；大改动拆成可读的小步。Spec 可单独先提交（`docs: …`），再提交实现（实现 commit 带 `Spec:`）。
- 改 MCP 工具行为或 Agent 指引时，同步 `src/mcp/server-instructions.ts`（唯一对外指引源）。
- 改 `src/installer/`（尤其 `targets/`）须带对应测试，并在 `CHANGELOG.md` 的 `[Unreleased]` 记一笔。
- **不要**本地 `npm publish` / 打 release tag / 强推 `main`；发布走 Actions → Release（见 AGENTS.md）。
- 密钥、token、本机路径、大型二进制勿进提交。
---

## 4. PR 检查清单

提 PR 前自检；描述里勾选适用项。

### 4.1 变更说明

- [ ] 标题清晰，对应主要 type（如 `feat: …` / `fix: …`）
- [ ] 正文写清：**改了什么、为什么、如何验证**
- [ ] **关联 Spec**：PR 描述写路径；实现类 commit footer 用 `Spec: docs/specs/NNNN-….md`（§3.3；豁免见 §1.5，须在 PR 中注明）
- [ ] 破坏性变更、迁移步骤、兼容策略已写明（如有）

### 4.2 代码与质量

- [ ] 实现与已确认 Spec 一致；偏离已先更新 Spec
- [ ] 仅包含本需求相关改动，无无关重构/格式化大扫荡
- [ ] `npm run build` 通过
- [ ] 相关测试通过：`npm test` 或针对性 `npx vitest run <file>`
- [ ] 新增/变更公共行为有测试覆盖（installer / MCP 契约尤甚）
- [ ] 未引入未使用的文件、调试残留、`console` 噪声

### 4.3 文档与发布面

- [ ] Spec 验收项已勾选或说明剩余项
- [ ] 用户可感知变更已写入 `CHANGELOG.md` → `## [Unreleased]`
- [ ] MCP 指引变更已改 `src/mcp/server-instructions.ts`
- [ ] README / 站点 / `docs/` 中过时描述已更新（若触及）
- [ ] 未误改 `package.json` version（除非本 PR 就是发版准备）

### 4.4 拉取与分支卫生

- [ ] 已基于较新的 `origin/main`（rebase 或 merge 完成）
- [ ] 无未解决冲突；CI 所需文件（lockfile 等）一致
- [ ] 未包含 `node_modules/`、`dist/`、本地 `.homegraph/` 等不应入库内容

### 4.5 评审友好

- [ ] 大 PR 已拆分或按文件/逻辑在描述中分段说明
- [ ] 高风险路径（extraction、resolution、MCP、sqlite adapter）标出关注点
- [ ] 明确 **不在本 PR 范围** 的事项，避免评审误解

---

## 5. 推荐最小闭环

```text
fetch/pull main
  → 编写 Spec 到 docs/specs/NNNN-<english-slug>.md（先确认）
  → 开分支 → 按 Spec 实现 → build + test
  → commit（规范 type；实现类带 Spec: footer）→ push → 开 PR（关联 Spec + 清单自检）→ 评审合入
```

合入后删除已合并的本地/远端特性分支，保持仓库分支列表干净。
