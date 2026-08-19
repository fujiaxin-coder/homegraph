# 0014 — ArkUI migrate：`@Provide`/`@Consume` 隐式 key


| 字段 | 内容 |
| --- | --- |
| 编号 | 0014 |
| 类型 | 变更 / 缺陷修复 |
| 状态 | 已完成 |
| 日期 | 2026-08-19 |
| 范围 | `collectKeyChannels`（及必要的 key 解析辅助）；相关单测；CHANGELOG |
| 关联 | [0007](./0007-arkui-migrate-snapshot.md)（`keyChannels`）；对照 migration-graph ProvideConsume 隐式 key |


---

## 1. 背景与目标

ArkUI 允许 `@Provide` / `@Consume`（及 V2 `@Provider` / `@Consumer`）**不带字面量 arg**：此时**变量名即 key**。

例：`@Consume persistentId: number;` ≡ `@Consume('persistentId') persistentId: number;`

当前 `collectKeyChannels` 在 `!sv.decoratorArg` 时直接跳过，隐式形式不会进入 `keyChannels`，迁移分析会漏 ProvideConsume 耦合（如 scene_board 的 `RecordNoiseReductionCard.persistentId`）。

**目标：** 无显式 arg 时，对 Provide/Consume/Provider/Consumer 用 `sv.name` 作为 key；显式 arg 仍优先；Storage* 等仍要求字面量 key，不回退到变量名。

---

## 2. 范围

### 2.1 做

- 修正 `collectKeyChannels`：解析 key 时  
  `key = decoratorArg`，若为空且装饰器为 `Provide`|`Consume`|`Provider`|`Consumer` → `key = name`；仍为空则跳过。
- 可选：抽出纯函数（如 `resolveKeyChannelKey`）便于单测；`stateVars[].decoratorArg` 可在隐式情形填入 name（与 key 一致），便于快照自解释——**至少** `keyChannels` 必须正确。
- 单测：隐式 `@Consume foo` / `@Provide bar` 出现在 `keyChannels`；显式 `Provide@theme` 仍用字面量；无 arg 的 `StorageLink` 仍不进通道。
- CHANGELOG `[Unreleased]` Fixes 一句。

### 2.2 不做

- 不改索引期装饰器抽取规则（无 arg 时本来就没有 `Kind@arg` twin）。
- 不修「未在 `build-profile` 声明的模块未索引」（另案；与本 bug 无关）。
- 不改 MCP 工具名 / 快照 schema 字段集合。

---

## 3. 行为与约束

| 装饰器 | 有 `decoratorArg` | 无 arg |
| --- | --- | --- |
| Provide / Consume / Provider / Consumer | 用 arg | 用 **变量名** |
| Storage* / LocalStorage* 等 | 用 arg | **跳过**（不回退 name） |

同 key + 同 channel 的多参与者仍合并进同一 `keyChannels` 条目。

---

## 4. 验收

- [x] Spec 确认后实现。
- [x] 隐式 Provide/Consume 进入 `keyChannels`，key = 变量名。
- [x] 显式 arg 与 Storage* 行为不变。
- [x] 相关 vitest 通过；CHANGELOG 已写。
- [x] 提交关联本 Spec（合入后保持「已完成」）。

---

## 5. 状态

**已完成** — `resolveKeyChannelKey` + `collectKeyChannels` / stateVar `decoratorArg` 回填；测试见 `arkts-migrate-snapshot.test.ts`。
