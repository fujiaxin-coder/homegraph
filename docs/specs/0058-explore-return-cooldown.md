# 0058 — explore 返回后冷却，去掉连接内次数上限


| 字段 | 内容 |
| --- | --- |
| 编号 | 0058 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-10-19 |
| 范围 | `homegraph_explore` 的会话拒绝、工具描述、MCP initialize 说明、explore 尾注 |
| 关联 | Spec 0053 把对外次数写成 2，并与 `EXPLORE_CALL_BUDGET` 硬闸对齐。本 Spec 拿掉该硬闸 |
| 非本 Spec | 输出体积档位 `getExploreBudget`；Partial 之后的 depth 工具次数；相同查询的证据去重 |


---

## 1. 背景与目标

`decideExploreRepeat` 按 MCP 连接、按工程根目录累计，满 2 次就拒绝之后的 `homegraph_explore`，查询内容不同也拒绝。计数挂在 `MCPSession` 上，连接不断开就一直加。

IDE 打开后只建一条 MCP 连接，多个问题共用这条连接。用过两次之后，后面的问题也不能再调 explore。

**目标：** 去掉「一条连接最多 2 次」。上一次 `homegraph_explore` 的结果记下时间之后，10 秒内再调就拒绝；超过 10 秒可以再调，包括另一个问题。

---

## 2. 范围

### 2.1 做

- 删除按 `callCount` 拒绝的硬闸（`hard-cap`）。
- 在会话记录里记下该次结果即将返回的时间。下一次 explore 若距该时间不足 10 秒，返回成功形态的拒绝，原因是冷却。
- 10 秒从结果记入会话开始算，也就是这次调用已经产出返回之后。冷却内的拒绝不再记一次新的返回时间，时钟不顺延。
- 工具描述（已索引、`fileCount > 0`）、explore 尾注、MCP initialize 说明改为这 10 秒，不再写「最多 2 次」或 `≤2`。
- 第二次 Partial 的脚注改为等待 10 秒，不再写本连接的检索次数已经用完。
- 单测覆盖：冷却内拒绝、超过 10 秒放行、次数累计不再拒绝、相同完整查询在冷却之后仍按重复证据拒绝。

### 2.2 不做

- 不看 Read / Grep。HomeGraph 看不到宿主的其它工具，10 秒只用来挡住拿到结果后立刻再调。
- 不挡还在执行、尚未返回的并行 explore。
- 不改 `getExploreBudget` 的输出档位。
- 不改 Partial 之后 `homegraph_node` / callers / callees 的 1 次深度恢复。
- 冷却结束之后，与上一次完全相同、且证据完整的查询，仍按原有重复证据规则拒绝。

---

## 3. 行为

| 情况 | 结果 |
| --- | --- |
| 本连接还没有 explore 返回 | 执行 |
| 距上次 explore 返回不足 10 秒，查询不同 | 拒绝，说明等待 10 秒 |
| 距上次返回已满 10 秒，查询不同 | 执行 |
| 距上次返回已满 10 秒，查询与上次完整结果规范化后相同 | 仍按重复证据拒绝 |
| 上次结果不完整，冷却已过 | 允许再检索一次 |
| 本连接已经 explore 很多次，但距上次返回已满 10 秒 | 执行 |

`fileCount === 0` 的工具描述仍不附带这条次数/冷却后缀（Spec 0027）。

---

## 4. 验收标准

- [x] Spec 落盘（本文件）
- [x] `npx vitest run test/explore-repeat-guard.test.ts test/spec-0058-explore-return-cooldown.test.ts test/spec-0053-retrieval-hygiene.test.ts test/explore-zero-files-description.test.ts test/mcp-tool-annotations.test.ts test/evidence-recovery-wire.test.ts` 通过
- [x] CHANGELOG Unreleased

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 同一问题在 10 秒后用新符号再 explore，不再有次数上限 | 10 秒只防连打。相同完整查询在冷却后仍去重 |
| 很快的 Read 再 explore 仍会撞上 10 秒 | 时长写死为 10 秒，出问题再调 |

回滚：恢复 `callCount >= 2` 的 `hard-cap`，并把工具描述、initialize、尾注改回「最多 2 次」。
