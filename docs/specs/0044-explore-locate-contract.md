# 0044 — Explore 定位合同（Located / Miss / 字面量首包 / 窄修复）


| 字段 | 内容 |
| --- | --- |
| 编号 | 0044 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-21 |
| 范围 | 缺陷 7 / 8 / 9 / 10.1 / 10.2；单测与 CHANGELOG |
| 关联 | 领导草案 in-repo locate；Spec 0041–0042（字面量 / 专名播种）；codingeval 073/086/030/017 等 |
| 非本 Spec | **10.3 动态/合成边**（搁置）；工作流 D；projectPath（0043） |


---

## 1. 背景与目标

0042 解决了 taskContext / 专名 / local / 噪声。仍常见：

| # | 现象 |
| --- | --- |
| 7 | 中文 UI 字面量命中的 `.ets`/`string.json` 没进首包；Logger/hilog/Toast 抢主链 |
| 8 | 锚点声明已在包内仍打 **Partial locator** → 模型再 Grep 同名 |
| 9 | 无精确锚点仍吐无关源码；同义词扩召回加重错页 |
| 10.1 | 文件名 ≠ 主声明（如 `PracticeDetailView.ets` 内 `SampleDetailView`）无提示 |
| 10.2 | explore 已定位的符号，后续 `node` 被 Partial 深度熔断截成空 |

**目标：** 首包可见真锚点；页眉 Located/Miss/Partial 诚实；窄提示与熔断豁免。不靠加边（10.3）。

---

## 2. 范围

### 2.1 做

#### 7 — 字面量首包 + 日志/弹窗降权

1. `literalEvidence` 命中的 `.ets` / `element/string.json` 路径 **强制保留并优先排序进首包**（不被 RWR 门控挤掉）。
2. query **未**点名 `Logger` / `hilog` / `Toast`（及常见 `logInfo` 等）时，这些符号/文件 **不得**作为唯一主链脊柱；有字面量命中时进一步降权。

#### 8 — Located vs Partial

3. 精确锚点的完整声明已在首包，且缺口仅为「运行时无法静态验证」→ 页眉 **`Located`**，文案明确 **禁止再 Grep 同名符号**。
4. 仅当缺静态关系或预算不足 → 保留 **Partial**；下一步推荐 `homegraph_node` / `homegraph_usages` / `homegraph_search`（非「再 Grep 同名」）。

#### 9 — Miss

5. **零精确锚点命中**（无仓内专名/文件精确根，且无字面量 witness）→ **Miss**：不输出声明源码；只列模糊候选路径；引导 `homegraph_search`。
6. Miss 路径关闭同义词式扩召回（如 CJK→ASCII `mechanismDomainPathTokens` 扩展种子），减少错页。

#### 10.1 / 10.2

7. 命中文件时若 basename（去扩展名）与主声明名规范化后不一致 → 短英文风险提示。
8. 上一轮 explore 的 `locatedNodes` 已含某符号时，对该符号的 `homegraph_node`（及 callers/callees）**不受**「Partial 后只能 1 次深度」熔断截空。

### 2.2 不做

- 10.3 索引期合成边 / synthesizer
- 放大 explore 字符预算
- 改 Spec 0043 projectPath 行为

---

## 3. 行为摘要

| 条件 | 行为 |
| --- | --- |
| 字面量命中文件 | 强制进首包并排序靠前 |
| 未点名 Logger/hilog/Toast | 不得独占主链 |
| 精确锚点声明已在包 + 仅运行时缺口 | **Located**；勿 Grep 同名 |
| 缺关系 / 预算 | **Partial**；下一步 node/usages/search |
| 零精确锚点且无字面量 | **Miss**；路径列表；关同义词扩召回 |
| basename ≠ 主声明 | 风险提示一行 |
| node 符号已在 locate 清单 | 深度熔断豁免 |

---

## 4. 验收标准

- [x] 字面量命中文件强制保留 / Logger 降权单测
- [x] Located / Miss / Partial 文案与分类单测
- [x] 文件名≠声明提示单测
- [x] 深度熔断对 located 符号豁免单测
- [x] CHANGELOG Unreleased；完成后勾选本表（commit 另发）

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| Located 过宽 → 模型过早停搜 | 仅在精确锚点 + 有声明体 + 非预算/缺边 Partial 时宣布 |
| Miss 过宽 → 丢掉仅有 FTS 的真题 | 有字面量或专名精确根则不算 Miss |
| 熔断豁免被滥用 | 仅匹配 `locatedNodes` 名/qualifiedName |

回滚：去掉 locate-contract 挂载与 fuse 豁免即可。

---

## 6. 非目标

- Spec 0042/0043 语义回退
- 动态边（10.3）
