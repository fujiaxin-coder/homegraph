# 0012 — Explore 粗定位契约、会话熔断与载荷修复


| 字段 | 内容 |
| --- | --- |
| 编号 | 0012 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-08-18 |
| 范围 | `homegraph_explore` 默认载荷与停答信号；会话 fuse；light-mechanism soft-close / Next-anchor 排序；`homegraph_callers`/`node` 护栏；Skip 问法；ArkTS commonEvent/taskpool 合成边；`server-instructions` / `AGENTS.md`；相关单测 |
| 关联 | 0008（Partial vs ANSWER NOW）；评测口径：explore = 粗定位，允许 **ONE 窄 Grep** 补静态缺口 |


---

## 1. 背景与目标

外部 A/B（DevEco / 大仓）上：`homegraph_explore` 调用率已高，但墙钟与 Token 仍偏高。常见失败模式：

1. 单次 explore **体量过大**（body-heavy dump）或 compact 在薄证据上 **假完整 ANSWER NOW**，agent 用 Grep/Read 风暴「验证」或换袋连打。
2. 跨 Type「如何驱动 / 状态变化」问句被 compact 锚到抽象基类。
3. Partial 之后 `homegraph_node` / callers ×N，抵消定位收益。
4. Qualified `Type.member` 查找 miss 时退成仓库里每一个同名 `member`（token bomb）。
5. 静态图缺口（字符串 event bus、`taskpool.execute`）没有边，explore-flow 连不上。

**产品契约：**

- **Explore = 粗定位**：`symbol → file:line` + 短 digest。静态图没有的信息允许 **ONE 窄 Grep**；不以「零 Grep」为成功标准。
- 证据够 → **Coarse locate / ANSWER**（可答 + 禁止风暴验证）；不够 → 诚实 **Partial**（单一 Next anchor）。
- 同一条回复 **不得** 同时出现 Partial 头 + ANSWER 尾。

**目标：**

- 默认 universal mid-lean 载荷（锚点表 + ≤2 条 spine digest），单调不随仓变大而收窄 per-file。
- 会话级 fuse：限制连打 explore / Partial 后深度工具。
- Domain Manager inventory 按问句打分选 Next / Primary / digest 文件；inventory+digest 够用时 **soft-close**。
- 形状驱动 Skip（布局字面量链、纯 C-API「实现哪个回调」），不钉评测题号。
- ArkTS：literal event 的 publish↔subscribe、`taskpool.execute`→named worker（需 **re-index**）。

---

## 2. 范围

### 2.1 纳入

| 块 | 落点 |
| --- | --- |
| 问法族 | `queryAsMechanismSurvey`：如何驱动/触发、多 Type + 状态机/布局交互；不得 compact 硬 ANSWER NOW |
| 默认载荷 | `getExploreOutputBudget`：中大仓 ~12K / ~3K per-file；Anchors 先于 digest；Relationships 默认关。`HOMEGRAPH_EXPLORE_FULL_SOURCE=1` 恢复旧 body-heavy |
| Compact | stub-only / 无 trail / 多 Type 无 flow → Partial |
| 会话 fuse | 每 project **≤2** 次 counted explore；Partial follow-up **必须含 Next anchor**（禁止换 Type / 同袋改写）；Partial 后 **拒绝 callers/callees**，`homegraph_node` **最多 1 次**；第二次 counted Partial 追加停机页脚 |
| Soft-close | light-mechanism：强 Manager inventory + ≥1 digest → `Coarse locate — ANSWER` **头尾同文案**；`inferExplorePartialMeta` 以 ANSWER/Coarse locate 为闭合（残留 Partial 字样不得把会话当 Partial） |
| Next/Primary | `scoreDomainRoleForQuery` + CJK→ASCII `mechanismDomainPathTokens`；digest 优先该 Type 所在文件。意图形状：订阅 → SubscribeManager（压 screenlock StateManager）；备份/恢复 → `*Extension`（压纯 EventManager） |
| Callers | `Type.member` 合格 miss **不得** `matchesSymbol(n, bareMember)`；多 def-group 只抽样 |
| Skip | 链式布局字面量（如 `.width('…')`）；无仓内文件锚点的纯 C/NAPI「需要实现哪个回调」目录 |
| 合成边 | `commonEventManager` 同 event 字面量 publish↔subscribe；`taskpool.execute(Task(fn)\|fn)` → named `fn`；`provenance:'heuristic'` |
| 指引 | `server-instructions.ts`（唯一对外源）；本仓 `AGENTS.md` 预算表与 fuse 对齐 |
| 测试 / 发布面 | 上表对应 vitest；CHANGELOG `[Unreleased]` |

### 2.2 不纳入

- 发明完整状态机动态边；评测仓题面 / 产品专有名词硬编码种子。
- 改 MCP deadline 数值（除非单测要求）。
- Named Type 命中 **仅 SDK `.d.ts` stub** 时自动抬 in-repo `SCB*` / 原生 Session 实现（A/B D59 类残留，见 §6）。
- 禁止 soft-close 之后一切 `homegraph_node`（证据不足；深度仍可能救场）。

---

## 3. 行为与约束

### 3.1 粗定位载荷

- 默认：**Anchors**（`file:line` + 少量符号）+ ≤2 spine/top-hit **digest**（digest = 已 Read）。
- 更大档位的 `maxCharsPerFile` **不得小于** 更小档位（单调性）。
- 文案：digest 所示符号不要再 Read/Grep；残差未入图接线 → **ONE 窄 Grep**。
- **与 adaptive skeletonization 的关系：** `HOMEGRAPH_ADAPTIVE_EXPLORE`（默认开）只作用于**已渲染的 Source 节**（off-spine 多态兄弟签成 skeleton）。mid-lean 默认不渲染那些文件的 body，它们只出现在 Anchors。骨架化回归测须设 `HOMEGRAPH_EXPLORE_FULL_SOURCE=1`。

### 3.2 Partial vs Coarse locate / ANSWER

| 信号 | 何时 | Agent 应 |
| --- | --- | --- |
| **Partial locator** + **Next anchor** | 证据薄（stub-only、无 trail、inventory 不够） | 仅用该 Next 名再 explore **一次**，或 ONE 窄 Grep；禁止 callers/callees |
| **Coarse locate — ANSWER** / Mechanism complete | inventory + digest（soft-close）或 spine 已闭合 | 直接作答；禁止再 explore / 风暴验证 |
| **Skip HomeGraph** | §2.1 Skip 形状 | 停所有 `homegraph_*`，不重试 |

同一响应若 soft-close：先写 digest 再改写开头横幅，保证头尾同属 ANSWER 族。

### 3.3 会话 fuse

- Counted explore：有效载荷（约 ≥400 字符）计入；硬顶 2。
- Partial 后 follow-up query 须含 Next anchor 标识符；否则 success-shaped refuse。
- Partial 后 `homegraph_callers` / `callees` refuse；`homegraph_node` 计数 1 后 refuse（指向已返回 Anchors + ONE Grep）。
- Soft-close / ANSWER 的 `partial` meta 为 false，不触发 Partial→depth fuse。

### 3.4 Domain-role 排序（形状，非题号）

- 输入：inventory 中的 class/interface/component + 问句 + `mechanismDomainPathTokens`（如 通知→`notification`，订阅→`subscribe`）。
- 抬：query/domain token 重叠、`/manager/`、`SubscribeManager` / `Extension`（备份问句）。
- 压：`*Utils`/`*Constants`、弱 `*Subscriber`、订阅问句下的 `StateManager` + 未点名的 screenlock/keyguard 路径、备份问句下的纯 `EventManager`。

### 3.5 合成边

- 仅 literal event key / 具名 worker；fan-out cap；需目标仓 **re-index** 后 explore-flow 才看得见。
- 不替代 AA 已有 call 边；只补静态洞。

---

## 4. 验收标准

- [x] `Machine …如何驱动 Engine…` / 同类 → `queryAsMechanismSurvey` true，compact **不**硬 ANSWER NOW（`test/explore-mechanism-drive.test.ts`）。
- [x] Stub-only SceneSession 仍 Partial（既有测不回归）。
- [x] ≥500 档 `maxOutputChars` 中大仓 ~12K 量级；单调性 / call-budget 测更新（`test/explore-output-budget.test.ts`）。
- [x] Soft-close 页脚不含 `Partial locator`；矛盾头尾时 `inferExplorePartialMeta.partial === false`。
- [x] CJK「通知订阅」→ SubscribeManager 优于 screenlock StateManager；「备份恢复」→ BackupExtension 优于 BackupEventManager。
- [x] 会话：≤2 explore；Partial 后 Next-anchor 约束；callers 拒绝；≤1 node（`test/explore-repeat-guard.test.ts`）。
- [x] `MissingType.init` 不返回仓库内每一个 `init`（`test/symbol-lookup.test.ts`）。
- [x] commonEvent / taskpool 合成边有测（`test/arkui-common-event-taskpool.test.ts`）；Skip 布局链 / 纯 C-API 回调目录有路由测。
- [x] `server-instructions` 含粗定位、窄 Grep 合法、fuse / Partial Next 习惯。
- [x] CHANGELOG `[Unreleased]` 用户向说明；无评测题号当产品种子。
- [x] Adaptive skeletonization 测在 `HOMEGRAPH_EXPLORE_FULL_SOURCE=1` 下跑；默认 mid-lean 不把 off-spine 兄弟打成 Source 节（`test/adaptive-explore-sizing.test.ts`）。

---

## 5. 回滚

回滚本 Spec 对应 diff（explore 载荷与 fuse、soft-close、synthesizer、Skip、instructions）。恢复 0008 时代的 Partial/ANSWER 习惯与更大 output budget。合成边回滚后需 **re-index** 才从库中消失。

---

## 6. 已知残留（不阻塞本 Spec）

外部 A/B 上整体 WITH 可优于 WITHOUT；下列不在本交付验收内，避免半桥接：

- **Stub-first named Type**（如 `SceneSession` 只命中 `@ohos.*.d.ts`）：agent 易按 SDK 枚举作答，漏 in-repo 回调。应另开 Spec：stub 时抬实现文件，而不是在本 Spec 加产品路径黑名单。
- **泛化 `*Manager` 仍可能压过更贴意图的 SubscribeManager**（soft-close Primary 偶发偏）。排序已按形状加压，不保证所有 NL 问句一次命中。
- Soft-close 后 agent 仍可能忽略「勿 fan-out node」——服务端 **未** 对 ANSWER 后再禁 node（刻意，见 §2.2）。
