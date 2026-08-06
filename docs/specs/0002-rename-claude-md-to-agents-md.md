# 0002 — 将仓库根目录 CLAUDE.md 更名为 AGENTS.md

| 字段 | 内容 |
| --- | --- |
| 编号 | 0002 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-08-06 |
| 范围 | 仓库根目录 Agent 向导文件及其交叉引用（不含 installer 对各 Agent 指令文件的路径约定） |

---

## 1. 背景与目标

仓库根目录的 `CLAUDE.md` 承载本仓库的 Agent 向架构约束与开发约定。现改为更通用的 `AGENTS.md`，与 Codex / opencode 等对 `AGENTS.md` 的惯例对齐，避免文件名绑定单一 Agent。

**目标：**

1. 根目录 `CLAUDE.md` 更名为 `AGENTS.md`；
2. 更新指向该文件的文档/脚本/注释链接；
3. 不改动 `homegraph install` 写入各 Agent 指令文件（如 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`）的产品行为。

---

## 2. 范围

### 2.1 纳入

- `git mv CLAUDE.md AGENTS.md`（内容主体保留，标题与开篇说明改为面向多 Agent）；
- 指向**本仓库根**该文件的引用：`DEVELOPMENT.md`、`.gitignore` 注释、`docs/design/*`、评测脚本注释、`scripts/exp_boundary_eval` 中清空该文件的逻辑等。

### 2.2 不纳入

- Installer / MCP / 站点文档中对「各 Agent 自己的 instructions 文件名」（`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`）的描述；
- `CHANGELOG.md` 历史条目；
- ~~为 Claude Code 单独保留的 stub / symlink（纯更名，不保留根目录 `CLAUDE.md`）。~~ → 已改为保留短 stub，见 §3。

---

## 3. 行为与约束

- 更名后权威内容在 `AGENTS.md`；根目录保留短 `CLAUDE.md` stub，仅指向 `AGENTS.md`（供 Claude Code 默认加载）；
- `scripts/exp_boundary_eval/setup.py` 实验前清空的文件改为 `AGENTS.md`（若仍存在 `CLAUDE.md` 可一并清空，兼容旧状态）；
- 文内提到 installer 写入目标路径时，仍可使用 `CLAUDE.md` / `AGENTS.md` 等产品术语，无需改成「本仓库文件」。

---

## 4. 验收标准

- [x] 根目录存在 `AGENTS.md`（权威）与短 `CLAUDE.md` stub（指向 AGENTS.md）
- [x] `DEVELOPMENT.md` 等链接指向 `AGENTS.md` 且有效
- [x] `scripts/exp_boundary_eval` 清空逻辑针对 `AGENTS.md`
- [x] 未改动 installer 对 Claude 目标路径（`~/.claude/CLAUDE.md` 等）的实现
