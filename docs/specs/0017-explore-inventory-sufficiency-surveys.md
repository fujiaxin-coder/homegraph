# 0017 — Explore inventory sufficiency：lifecycle / composition / UI-consequence 与 repeat-guard

| 字段 | 内容 |
| --- | --- |
| 编号 | 0017 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-08-25 |
| 范围 | `homegraph_explore` 问法族 inventory / soft-close；`explore-repeat-guard` 域词重叠拒答；相关 vitest / routing corpus；`CHANGELOG` `[Unreleased]` |
| 关联 | 0008（定位充分性）、0012（粗定位与 soft-close）、0016（Partial/ANSWER 护栏）；评测题面专词与外部 harness **不在**本 Spec |

---

## 1. 背景与目标

外部 A/B 上 explore 已能接到问法，但仍常见「证据不够完整 → 假 Partial / 假 ANSWER → Agent search·node·Grep 风暴」：

1. **SDK stub-only lifecycle**：生命周期 Type 只在索引 `.d.ts` 里时，compact 无实现体 → Partial → search/Grep。
2. **Container composition**：壳组件 + 多 Page 共享 `@LocalStorageLink` / ViewModel 注入时，走错成单 Type compact，缺同壳 Page 列表。
3. **Member UI-consequence**：`Type.member` 问「true/过期如何影响 UI」时只给 call site，不标注 UI 效果语义 → 再 Grep。
4. **Event→Manager / hover / Telephony / native GL**：类表或 import 噪声占满，缺 `.on`/`produceOn`、icon-hover 加权、Kit 扩展、CMake/GL digest soft-close。
5. **PascalCase search**：裸 Type `homegraph_search` 后 agent 固定 callers×N；应直接 caller inventory。
6. **Repeat guard**：closed ANSWER 后同域 paraphrase（theme/install/parse…）仍再 explore。

**目标（形状驱动，不钉题号）：** 上述问法在证据够时 **ANSWER NOW / soft-close**；证据不够时诚实 Partial；关闭后再探同域袋则 refuse。

---

## 2. 范围

### 2.1 纳入

| 块 | 落点 |
| --- | --- |
| SDK lifecycle stub | stub-heavy lifecycle Type → `.d.ts` enum + callback inventory + ANSWER NOW |
| Container composition | 共享壳组件的 Page 列表 + `@LocalStorageLink` / ViewModel 注入片段 |
| Member UI-consequence | filter/call site 旁注「如何影响 UI」 |
| Event dispatch | 导出 `*Event` 列表 + 索引内 `.on` / `produceOn` consumer wiring，再 ANSWER |
| Hover inventory | icon-hover 加权 `onHover` / `HoverAnimationUtil`；降权 control-center `HoverConstants` import 噪声 |
| Telephony usage | `Telephony` 袋扩展 `@kit.TelephonyKit` / `@hms.telephony.*` 调用点 |
| Native GL/thread | light-mechanism soft-close：CMake + `plugin_manager` / `egl_core` digests |
| Search redirect | 裸 PascalCase Type **search** → caller inventory（禁 search→node×N） |
| Repeat guard | closed ANSWER 后 domain stem 重叠（或 token overlap）拒 paraphrase 再探 |
| 测试 / CHANGELOG | `test/query-patterns.test.ts`；`test/explore-routing/corpus.ts`；`[Unreleased]` Fixes |

### 2.2 不纳入

- 新增 MCP 工具名（`usages`/`modules`/`native` 属 0015）。
- 改 explore 输出总预算档位或 session fuse 数值上限定义（仍属 0012；本 Spec 只收紧 closed 后域词拒答）。
- 评测 harness / 题面 overlays。

---

## 3. 行为与约束

1. Lifecycle Type 仅 stub：返回 state enum + 回调清单并 **ANSWER NOW**；不得因无 `.ets` 实现体假 Partial 逼 Grep。
2. Composition 问法：列出共享壳的 Page + 注入片段；不得只吐单个壳 Type 体。
3. UI-consequence member 问：call/filter 站点须带 UI 效果标注。
4. Event 分发：有 Event 类表时尚须扫 `.on`/`produceOn`；有 wiring 再 soft-close，避免「只列类名」假完整。
5. Icon-hover：优先 app-icon `onHover` 站点；降权无关 `HoverConstants` import。
6. `Telephony … usage` EN 袋：须覆盖 Kit / HMS telephony import 调用点，不只 `@ohos.telephony`。
7. Native render/thread：CMake + GL/plugin digests 够则 soft-close。
8. 裸 PascalCase **search**：改走 caller inventory；禁止默认 FTS→node 扇出。
9. Closed ANSWER 后再探：domain stem ≥2 或显著 token overlap 且非 tight follow-up → refuse。
10. 实现保持问法族通用；禁止按评测题号 / 产品专有路径硬编码种子。

---

## 4. 验收标准

- [x] `npm run build`
- [x] `npx vitest run test/query-patterns.test.ts`
- [x] routing corpus 含 telephony / inventory 相关形状且本地相关用例通过（或整包 `explore-routing`）
- [x] `CHANGELOG.md` `[Unreleased]` 有对应 Fixes 说明
- [x] 本 Spec 状态为「已完成」
- [x] 实现 / 验收修补 commit footer 含 `Spec: docs/specs/0017-explore-inventory-sufficiency-surveys.md`

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| lifecycle stub ANSWER 过宽掩盖缺实现 | 仅 stub-heavy + lifecycle 问法；corpus 钉形状 |
| Event wiring soft-close 过早 | 须有 `.on`/`produceOn` 证据或明确「未索引」指引 |
| repeat-guard 误杀合法紧 Type follow-up | `isTightExploreFollowUp` 豁免；Next-anchor 通道保留 |

回滚：`git revert` 本 Spec 相关实现提交（含已合入的 lifecycle/composition 基线与本验收修补）。

---

## 6. 实现状态

状态：**已完成**（2026-08-25）。

已落地 SDK lifecycle stub、container composition、member UI-consequence、Event `.on`/`produceOn`、hover/Telephony/native-GL soft-close、PascalCase search→caller、以及 closed 后 domain-stem repeat refuse；配套单测与 routing corpus；`CHANGELOG` `[Unreleased]` 已更新。
