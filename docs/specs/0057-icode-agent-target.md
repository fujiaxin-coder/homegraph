# 0057 — 安装器增加 iCode 目标


| 字段 | 内容 |
| --- | --- |
| 编号 | 0057 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-10-16 |
| 范围 | `homegraph install` / `uninstall` 的 agent 目标 |
| 关联 | ProgramAnalysis/homegraph `!24`（`ea1d0b2`，原 Spec 0017）。本仓已有别的 `0017` 规格，这里用 0057 |
| 非本 Spec | 索引、MCP 工具、Cursor / DevEco 的配置格式 |


---

## 1. 背景与目标

iCode 把每个 agent 写成一份 YAML，放在 `~/.chrys/agents/`（macOS / Linux）或 `%APPDATA%\chrys\agents\`（Windows）。MCP 服务器写在 `tools.mcp` 下面。没有项目级配置。

用户现在要手改这些 YAML 才能接上 HomeGraph。

**目标：** `homegraph install --target icode` 把 HomeGraph 的 MCP 条目写进已有 profile。能找到 iCode 安装目录时，再为内置 agent（Code / QA / Explore / General）写一份带同样条目的 shadow。找不到安装目录时仍改已有 profile，并在备注里给出可粘贴的 YAML，不报错。

---

## 2. 范围

### 2.1 做

- 新增 `src/installer/targets/icode.ts`，只支持 `global`。
- `TargetId` 增加 `icode`。登记在 `ALL_TARGETS` 末尾，已有目标的顺序不变。
- `install`：已有 profile 原位插入 `tools.mcp` 里的 `homegraph`，同级服务器和其它段落保留。
- 从已安装 runtime 的 `site-packages/chrys/service/profiles/agents/builtins/` 发现内置 agent。用户目录还没有同名文件时，写入完整内置内容再加上 HomeGraph 条目。
- `HOMEGRAPH_ICODE_NO_BUILTINS=1` 只改已有 profile，不建 shadow。
- `uninstall` 只删 HomeGraph 这一条。它是 `mcp` 里唯一一项时删掉整段 `mcp:`，`tools.builtins` 留下。
- 不写 instructions 文件。iCode 使用 MCP `initialize` 里的说明。
- 单测：shadow、找不到 runtime、同级 MCP、卸载、幂等、逃生舱、没有 profile。

### 2.2 不做

- 不改 Cursor、DevEco、Claude 等已有目标的写入内容。
- 不探测 `~/.chrys` / `%APPDATA%\chrys` 以外的配置目录（runtime 仍认 `PYAPP_INSTALL_DIR_ICODE`）。
- 不接 iCode 的 HTTP MCP，只写 stdio。

---

## 3. 行为

| 命令 | 结果 |
| --- | --- |
| `homegraph install --target icode`，已有 profile，能找到 runtime | 已有 profile 写入 MCP；内置 agent 得到 shadow |
| 同上，找不到 runtime | 已有 profile 仍写入；备注里有手工 YAML；不建 shadow |
| `HOMEGRAPH_ICODE_NO_BUILTINS=1` | 只改已有 profile |
| 没有 profile，但 chrys 目录在 | 不写文件，备注说明没有 profile |
| `homegraph uninstall --target icode` | 去掉 homegraph 条目；其它 MCP 和 `builtins` 还在 |
| `homegraph install --target cursor`（或 deveco） | 与这次改动之前相同 |

`homegraph install --target all`，以及 `-y` 的 `auto` 在检测到 iCode 已安装时，会把 iCode 算进要安装的目标。

---

## 4. 验收标准

- [x] Spec 落盘（本文件）
- [x] `npx vitest run test/installer-targets.test.ts` 通过，含 iCode 用例
- [x] CHANGELOG Unreleased

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| `--target all` 会改 iCode 的 profile | 只在用户指定 all，或 auto 检测到 iCode 时发生。单独安装 Cursor / DevEco 不写 chrys |
| shadow 覆盖同名内置 agent | 写入的是完整内置内容加一条 MCP。删掉该文件并重启 iCode 即恢复内置 |

回滚：从 `ALL_TARGETS` 和 `TargetId` 去掉 `icode`，并删除 `icode.ts`。
