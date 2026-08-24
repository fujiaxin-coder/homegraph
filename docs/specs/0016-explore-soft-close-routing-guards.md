# 0016 — Explore soft-close：机制袋噪声、caller rewrite 与 compact Partial 护栏

| 字段 | 内容 |
| --- | --- |
| 编号 | 0016 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-08-24 |
| 范围 | `homegraph_explore` 的 light-mechanism / compact / caller-inventory 路由与停答信号；`query-utils` 问法族；相关 vitest / routing corpus；`CHANGELOG` `[Unreleased]` |
| 关联 | 0008（定位充分性）、0012（粗定位与 soft-close）；评测题面专词与外部 harness **不在**本 Spec |

---

## 1. 背景与目标

外部 A/B 上 `homegraph_explore` 调用率已高，但仍出现两类共性失败（非单题锚点）：

1. **假 Partial → Agent fan-out**：compact / light-mechanism 在证据已够时仍写 `**Partial locator**`，agent 继续 Read / Grep / `homegraph_callers`×N，分数掉或 token/墙钟变差。
2. **Agent 英文改写误路由**：
   - `xml parse` / `xml parser` 把 `parser` 当锚点，淹没 `xml`/`convertxml`；
   - `Type class definition methods` 丢掉「被外部调用」语义，走 compact 无 callers；
   - 单数 `method`（如 `Session method helper`）被误当成 caller survey，截断 full explore。
3. **模块/循环依赖问法**被 concept-skip（`是否存在`）短路，inventory 进不去。

**目标（形状驱动，不钉题号）：**

- 机制袋：动词/名词噪声（`parse`/`parser`）不得压过短 distinctive stem（如 `xml`，长度 ≥3）；Manager keep 须匹配 distinctive / domain path token。
- Light-mechanism：有 distinctive import 证据 + digests 时可 **soft-close**（即使无 `*Manager`）；import 列表按 path-prefix 轮转多样，避免单目录占满。
- Compact：UI surface / member focus / `$r`·下载 provenance 在证据够时 **不得** 降级 Partial 逼再读；digests 已含 load origin 时清掉 Partial 横幅。
- Caller survey：`Type` + 复数 `methods`（含 `class definition methods`）走 inventory；**不得**因单数 `method` 误杀符号袋。
- Module/cycle survey（如 `*constants` + 循环依赖）**不得** concept-skip。

---

## 2. 范围

### 2.1 纳入

| 块 | 落点 |
| --- | --- |
| 噪声与 stem | `GENERIC_VERB_ANCHOR_NOISE` 含 `parser`/`parsers`；`mechanismDomainPathTokens` ASCII stem ≥3 |
| 模块 skip 护栏 | `queryShouldDeferToBuiltinTools`：已识别 `queryAsModuleDependencySurvey` 时不走 concept-existence skip |
| Caller 问法 | `queryAsCallerOrMethodSurvey`：`Type` + `\bmethods\b`（复数）；单数 `method` 不触发 |
| Light soft-close | `tryLightMechanismExplore`：`importEvidenceClose`；Manager keep 需 distinctive/path；import bullet diversify + 加宽 |
| Compact Partial | 空 trail 不降级当 `componentSurface`/`uiCluster`/`memberFocus`；provenance 改 Coarse；digests 含 `$r`/download/PixelMap 时清 Partial |
| 测试 | `test/query-patterns.test.ts`；`test/explore-routing/corpus.ts`（xml EN bag、module-cycle leaf） |
| CHANGELOG | `[Unreleased]` 用户向说明 |

### 2.2 不纳入

- 评测 harness / 题面 overlays（`homegraph_eval`）。
- 改 explore 输出总预算档位或 session fuse 数值（仍属 0012）。
- 新增合成边或语言 extractor。

---

## 3. 行为与约束

1. `xml parser` / `XML parsing 解析 xml parser` 类袋：种子与 digests 须能落在 convert/xml 相关文件；**不得**仅因 `*Parser*Manager` 名留下无关 Manager；证据够 → Coarse/ANSWER，非假 Partial。
2. `Configuration class definition methods` → Caller inventory + ANSWER NOW；`Session method helper` → **不得**仅因含 `method` 走 caller inventory（须仍能出带行号的 Source / method 体，回归 `explore-output-budget`）。
3. UI Page/Dialog surface、`Type.member`、`$r` vs download：compact 在可见 digest 足以作答时写 Coarse/ANSWER，禁止「无 trail → Partial」逼 Read 风暴。
4. `*constants` + 谁依赖/循环依赖：**不得**返回 Skip HomeGraph（concept）；应走 inventory/explore。
5. 实现保持**问法族通用**；禁止按评测题号 / 产品专有路径硬编码种子。

---

## 4. 验收标准

- [x] `npm run build`
- [x] `npx vitest run test/query-patterns.test.ts test/explore-output-budget.test.ts`
- [x] routing corpus 含 xml EN bag / module-cycle 形状且本地相关用例通过（或整包 `explore-routing` 套件）
- [x] `CHANGELOG.md` `[Unreleased]` 有对应 Fixes 说明
- [x] 本 Spec 状态为「已完成」
- [x] 实现 commit footer 含 `Spec: docs/specs/0016-explore-soft-close-routing-guards.md`

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| soft-close 过宽导致假完整 | 仅在 distinctive import≥3 + digest，或既有 Manager soft-close 条件；corpus 钉 xml 袋 |
| `methods` 复数漏掉部分 EN rewrite | 保留既有 `callers` / `methods? … call` / 中文「哪些方法」路径 |

回滚：`git revert` 本 Spec 实现提交。

---

## 6. 实现状态

状态：**已完成**（2026-08-24）。

已落地 query-utils 问法护栏、light-mechanism soft-close/diversify、compact Partial 护栏，以及对应单测与 routing corpus 条目。
