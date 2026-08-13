# 0008 — Explore 定位充分性与停答信号


| 字段 | 内容 |
| --- | --- |
| 编号 | 0008 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-08-13 |
| 范围 | MCP `homegraph_explore` 问法族路由与返回形态；`server-instructions`；重复 explore 防护；相关单测。评测题面专词与评测仓库脚本不在本 Spec |
| 关联 | Agent 工具指引单一来源 `src/mcp/server-instructions.ts`；检索原则见 `AGENTS.md` / `docs/benchmarks/call-sequence-analysis.md` |


---

## 1. 背景与目标

HomeGraph 的核心价值是让 agent 用少量 `homegraph_*` 调用完成**结构定位**（`file:line` + 源码），从而少盲 Grep/Read。实测上：

- 中位探索步可以下降，但**假完整**（薄切片上打 ANSWER NOW）或**噪声清单**会把会话推进 Grep 风暴 / 连打 explore，墙钟与护栏一起变差。
- 中文 NL + 英文符号袋混写时，路由若把「多词定位袋」误判成 light-mechanism，会截断本应走的多词 corroboration / 全量 explore。
- initialize 文案过长 salience 低；应用短手册写清 query 习惯与停答规则，而不是长篇说教。

**目标：**

1. 按**问法族**（非单题专词）路由：数据来源、Event→handler、多 Type 依赖、资源/预览、NAPI、light-mechanism 等，返回够用的 locator 或诚实 Partial。
2. **诚实停答**：只有证据够（如 Event 有成员 + 可靠 handler）才 ANSWER NOW；否则 Partial，并约束「从列表挑一个锚点再探、禁止同袋改写连打」。
3. 重复 / 近义 explore 由服务端拒绝或导向更紧 query，避免空转。
4. 启动 instructions 短而可执行；不把评测过滤策略写进用户可见报告文案（评测侧另议）。

**成功标准（方向性）：** 结构类问题上 agent 更早定锚、更少盲搜；不因假 ANSWER NOW 或误路由 light-mechanism 而系统性 Grep 风暴。准确率为护栏，不钉具体题号刷分。

---

## 2. 范围

### 2.1 纳入

- `query-utils`：问法族分类与 light-mechanism / domain-bag 边界（如 `service`/`source` 等名词噪声不得单独触发 mechanism bag）。
- `tools` explore：上述族的库存 / Partial / ANSWER NOW 条件；Event survey 优先 `*Event` + enum members，弱命中不硬完成。
- `explore-repeat-guard`：同袋 / 近义重复 explore 防护。
- `server-instructions`：短 playbook（先 explore、query 写法、ANSWER NOW vs Partial、Skip 黑名单）。
- 对应单测；Windows 上易 EPERM 的 cleanup 型 e2e 可用 `runIf` 跳过（逻辑在 POSIX 覆盖）。

### 2.2 不纳入

- 不发明动态边；不钉评测题号 / scene_board 专有名词当硬编码种子。
- 不在本 Spec 要求改评测仓库报告文案或刷 without 脚本（可并行，非本仓库合入条件）。
- 不追求覆盖所有跨模块 / 纯数据流（nonce 类）缺口——那是图连通性下一阶段。

---

## 3. 行为与约束

### 3.1 路由原则

- 输入是符号袋 / 意图词；路由猜的是**问法族**，不是题面 ID。
- 多词定位袋（如 `item service`）走正常 explore / corroboration，**不得**仅因噪声词 `service` 掉进 light-mechanism Partial。
- 数据来源 / 资源预览 / Event survey 证据不足 → **Partial locator**，附可跟进的锚点。
- Event→Manager：有 enum 成员与可靠 handler 才可 ANSWER NOW；否则 Partial。

### 3.2 停答与跟进

- ANSWER NOW：禁止用 Grep 风暴「验证」已返回符号。
- Partial：只允许**一次**更紧 follow-up（列表中的 Manager / 文件 / member），禁止同袋改写连打。
- Busy/deadline：收紧 query 重试至多一次，然后作答。

### 3.3 Instructions

- 保持短：call-first、query 习惯、停答、Skip 黑名单。
- 不写百科式评测口径；不诱导 agent 改宿主工具策略以外的行为。

---

## 4. 验收标准

- [x] Event / 数据来源 / 多 Type 依赖 / light-mechanism Partial 等有单测或路由测覆盖。
- [x] `item service` 类多词袋不误入 domain-mechanism light path；corroboration 测可通过。
- [x] `server-instructions` 含 explore-first 与 ANSWER NOW / Partial 习惯；indexed initialize 测不过时。
- [x] 无题面专有 Manager/Event 名硬编码为产品种子。
- [x] Windows 仅跳过已知 EPERM cleanup 类用例，不跳过逻辑断言本体（POSIX 仍跑）。
- [x] CHANGELOG `[Unreleased]` 有用户可读说明（无内部路径堆砌）。

---

## 5. 回滚

回滚本 Spec 对应实现时，恢复 explore 路由与 instructions 至上一发布行为；repeat-guard 可一并回退。评测侧脚本不在本回滚范围。
