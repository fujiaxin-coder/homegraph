# 0017 — iCode 安装目标（installer target）

| 字段 | 内容 |
| --- | --- |
| 编号 | 0017 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-10-08 |
| 范围 | `src/installer/targets/`（新增 `icode.ts`；`types.ts`、`registry.ts`）；`src/bin/homegraph.ts` 帮助文案；`test/installer-targets.test.ts`；`CHANGELOG` `[Unreleased]` |
| 关联 | 多智能体安装器 target 抽象（`AGENTS.md`「加一个 agent = 一个文件 + registry 一行」）；iCode 侧 profile / `tools.mcp` 契约（iCode 仓库 `docs/en/reference/agent-profile.md`）。**不改** MCP runtime、`src/installer/index.ts` 调用契约、`server-instructions.ts` |

---

## 1. 背景与目标

`homegraph install` 已支持 Claude Code / Cursor / Codex / opencode / DevEco / CodeBuddy / Hermes / Gemini / Antigravity / Kiro，但**不含 iCode**，iCode 用户需手工编辑 agent profile 的 YAML 才能接入 HomeGraph。

iCode 的 agent 配置形态（本 Spec 的事实前提）：

- 每个 agent 是一个 YAML 文件，置于 `~/.chrys/agents/`（macOS/Linux）或 `%APPDATA%\chrys\agents\`（Windows）；
- MCP server 列在 `tools.mcp`，每项必填 `name` + `transport`；`transport: stdio` 时用 `command`/`args`/`env`；
- **无项目级配置**，只有全局；
- 内置 agent 为 `Code`/`QA`/`Explore`/`General`，随安装包分发，源自 `.../site-packages/chrys/service/profiles/agents/builtins/`；
- 用户目录里同名的 profile 会**整体覆盖**内置（不合并）；
- iCode 加载 profile 时会规范化重写（补 `id`、去注释/默认值），且**启动时加载、改动需重启生效**；
- `expose_instructions` 默认 `true` —— MCP `initialize` 指令会被注入系统提示。

**目标：** 新增 `icode` target，使 `homegraph install --target icode` 一键把 homegraph MCP server 接入 iCode；复用既有 `AgentTarget` 抽象，不改动其它 target、MCP runtime 与安装器编排的同步契约。

---

## 2. 范围

### 2.1 纳入

| 块 | 落点 |
| --- | --- |
| 新增 target | `src/installer/targets/icode.ts` |
| 类型 / 注册 | `types.ts` 的 `TargetId` 增 `'icode'`；`registry.ts` 登记 `icodeTarget`（`ALL_TARGETS` 首位） |
| CLI 文案 | `src/bin/homegraph.ts` install / uninstall 描述补全 agent 列表 |
| 测试 | `test/installer-targets.test.ts`：7 个 iCode 用例 + 契约 / sweep 适配 |
| CHANGELOG | `[Unreleased]` 新增 `### New Features` 条目 |

### 2.2 不纳入（非目标）

- 不改 `src/installer/index.ts` 的 target 调用契约与 `src/bin/uninstall.ts` 的 preuninstall sweep（保持**同步**；iCode 非交互行为为「处理全部 profile」，无需逐 profile 弹窗）。
- 不扩展 `~/.chrys` / `%APPDATA%` 之外的路径探测。
- 不覆盖 iCode 的 HTTP MCP 形态（仅 stdio）。
- 不新增 / 变更 `src/mcp/*`（不改 `src/mcp/server-instructions.ts`）。
- copilot 系 target 不在本 Spec。

---

## 3. 行为与约束

1. **位置**：仅 `global`（`supportsLocation('local') === false`）；安装目录 = `<configDir>/agents`，`configDir` 在 Windows 为 `%APPDATA%\chrys`，其它平台为 `~/.chrys`。
2. **注入内容**：在 `tools.mcp` 下写入
   ```yaml
   - name: homegraph
     transport: stdio
     command: homegraph
     args:
       - serve
       - mcp
     enabled: true
   ```
3. **只改已存在的用户 profile**：`install()` 遍历所有 `~/.chrys/agents/*.yaml|yml` 原位编辑；保留 sibling MCP server 与其它全部段落。四种编辑情形：缺 `tools` → 追加整段；有 `tools` 无 `mcp` → 追加 `mcp:`；有 `mcp` → 追加本项；已存在 → `unchanged`（幂等，字节相等）。
4. **内置 shadow**：当 `discoverBuiltins()` 命中 runtime 时，为无同名用户 profile 的内置 agent 写 `<name>.yaml`，内容为内置**完整** YAML + 注入项（因同名会整体覆盖）。runtime 找不到 → **降级**：仍改已有 profile，`notes` 输出手动指引 + 可直接粘贴的注入片段，**不抛错**。`HOMEGRAPH_ICODE_NO_BUILTINS=1` 时只改用户 profile、不建 shadow。
5. **uninstall**：从所有用户 profile 移除本项；该 `mcp` 仅剩本项时删整段 `mcp:`，否则只删本项；不含本项 → `kept`。仅删 install 写入的内容，不改内置 runtime 文件。
6. **不写 instructions 文件**：依赖 iCode 默认 `expose_instructions: true` 注入 MCP `initialize` 指令（与 #529/#704 单一信息源策略一致）。
7. **不跳过「装 CLI 到 PATH」**：MCP 命令是 `homegraph`（Node 包），iCode 不打包它。
8. 保持 `AgentTarget` 接口**同步**；`printConfig` 纯输出、不触盘；`describePaths` 返回待写 profile 路径。

---

## 4. 验收标准

- [x] `npm run build`
- [x] `npx vitest run test/installer-targets.test.ts test/installer.test.ts`（200 passed，含 7 个新增 iCode 用例）
- [x] `tsc --noEmit` 对 `src/installer/**` 零错误
- [x] 契约覆盖：install 写文件 / 幂等 / 保留 sibling / uninstall 往返 / printConfig 只读；内置 shadow 创建、runtime 缺失降级、`HOMEGRAPH_ICODE_NO_BUILTINS` 开关
- [x] `CHANGELOG.md` `[Unreleased]` 有对应 New Features 说明
- [x] 本 Spec 状态为「已完成」
- [x] 实现 commit footer 含 `Spec: docs/specs/0017-icode-agent-target.md`

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 自动创建 shadow 会整体覆盖内置，且 iCode 升级后内置改进不回流 | shadow 拷贝**完整**内置内容；`notes` 说明「删除该文件并重启即恢复内置」；提供 `HOMEGRAPH_ICODE_NO_BUILTINS=1` 关闭 |
| runtime 路径探测随 PyApp 布局变化而失效 | 探测失败**降级为手动指引**，不报错；支持 `PYAPP_INSTALL_DIR_ICODE` 覆盖 |
| iCode 规范化重写文件破坏注入 | 行级 upsert 幂等；契约测试断言二次 install 全 `unchanged` |
| 用户 profile YAML 缩进风格不一 | `childRange` 将 `  - name:` 视为列表项（非同级键）；沿用参考实现的行级匹配 |

回滚：`git revert` 本 Spec 实现提交（新增文件 + 两行注册，无数据迁移）。

---

## 6. 实现状态

状态：**已完成**（2026-10-08）。

已落地 `icode` target、`TargetId` / registry 登记、CLI 文案、7 个单测与 CHANGELOG 条目；MCP runtime 与 `server-instructions.ts` 未改动。
