# 0063 — arkui-child：`resolveChild` name miss 禁止 kind 全表回退

| 字段 | 内容 |
| --- | --- |
| 编号 | 0063 |
| 类型 | 修复 / 性能 |
| 状态 | 已完成 |
| 日期 | 2026-10-30 |
| 范围 | `arkuiChildComponentEdges` / `resolveChild`（`src/resolution/callback-synthesizer.ts`）；P1 回归测 `resolve-child-kind-fallback` |
| 非本 Spec | ViewTree 索引期 `child-component` 边；把 SDK `Column`/`Text` 等入库；旁路 `Map<name,Node[]>` 兜底（可选后续）；P2 孤儿 TS WASM（0062）；P3 ViewTree `%AM` `file_path` |

---

## 1. 背景与目标

Spec 0045 `arkui-child` 在解析完成后对 `.ets` 源码做 PascalCase 调用扫描，经 `getNodesByName` 解析到**仓内** `@Component` / `@Builder`。正则也会命中 ArkUI 框架调用（`Column()` / `Button()` / `Text()` 等）——这些本就不在项目图里，name miss 是常态。

旧实现 miss 时回退 `getNodesByKind('struct'|'component'|'function'|'method')` 再 filter：每个 miss × 每个 `build` 父节点全图物化，大仓上 `resolveChild` 可到分钟级 CPU。产品目标从未要求给系统组件连边（0045 测例要求 `via=Column` 边数为 0）；与「ambiguous drop」一致，miss 应直接放弃。

**目标：** `getNodesByName` 空 → 立即 `null`，禁止 kind 全表回退。

---

## 2. 范围

### 2.1 做

- 删除 `resolveChild` 中 `getNodesByKind` 回退块。
- 回归：mock 上下文中框架名 miss 时 `getNodesByKind` 调用次数为 0；仓内 `Child` 仍可经 name 索引连边（既有 0045 测例覆盖）。

### 2.2 不做

- 不预建旁路 name→target Map（若日后要兜「名字索引不一致」再开 Spec）。
- 不改 ViewTree / RTA 路径。
- 不维护框架组件黑名单（miss 即足够）。

---

## 3. 行为

| 场景 | 结果 |
| --- | --- |
| `getNodesByName(name)` 无 `isArkuiChildTarget` 命中 | `resolveChild` → `null`，**不**调用 `getNodesByKind` |
| 唯一仓内 `@Component`/`@Builder` 命中 | 与修复前相同，发出 `arkui-child` |
| 多名歧义 | 仍按同文件 / 同模块消歧；消歧失败 drop（不变） |
| `Column()` 等框架调用 | 不产生 `arkui-child` 边（与 0045 一致） |

---

## 4. 验收

- [x] Spec 落盘；`resolveChild` 无 kind 回退
- [x] `test/harmony-graph-stability/tests/resolve-child-kind-fallback.test.ts` 通过（非 skip）
- [x] 既有 Spec 0045 arkui-child 测例仍通过
- [x] CHANGELOG `[Unreleased]` 有条目
