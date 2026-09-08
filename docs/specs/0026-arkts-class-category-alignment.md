# 0026 — ArkAnalyzer ClassCategory 对齐：非声明形态不入库


| 字段 | 内容 |
| --- | --- |
| 编号 | 0026 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-08 |
| 范围 | ArkTS 适配器补全 `ClassCategory`；`OBJECT` / `TYPE_LITERAL` / `UNION` 跳过入库；单测与 CHANGELOG |
| 关联 | [0025](./0025-arkts-synthetic-modules-language.md)（AA 映射脱节）；ohrouter `graph_class` 膨胀反馈 |


---

## 1. 背景与目标

ArkAnalyzer 用统一的 `ArkClass` + `ClassCategory` 建模声明与 IR 形状。HomeGraph 本地常量只覆盖 CLASS/STRUCT/INTERFACE/ENUM，其余（含 **OBJECT** 对象字面量、**TYPE_LITERAL** 类型字面量、**UNION**）掉进 `default → class`，再挂在 file 下，导致：

- `graph_class` 虚高（如 ohrouter 190 → 1260+）；  
- `<Object$anon@N>` 与真正的 owner（如 `STANDARD` / `const a`）无归属边；  
- 覆盖与按 kind 统计失真。

HomeGraph 是**声明/符号图**，不做 object-literal 字段级归属边；因此这些 IR 壳**没有入库必要**。

**目标：**

1. 适配器 `CLASS_CATEGORY` 与 AA 枚举对齐（含 TYPE_LITERAL / OBJECT / UNION）。  
2. `indexClass` 对上述三类 **整壳跳过**（含子字段），真·`CLASS`（含匿名 class expression）照常索引。  
3. 不扩 `NodeKind`、不建 owner↔字面量边（保持现有存储模型）。

---

## 2. 范围

### 2.1 做（本仓 HomeGraph）

- 补全 `CLASS_CATEGORY` 常量；`isNonDeclarationArkClassCategory` 判定。  
- `indexClass` 入口：default class 之后、建节点之前，对 TYPE_LITERAL / OBJECT / UNION `return`。  
- `classNodeKind` 显式处理 CLASS；非声明类不应再走到建节点。  
- 单测：object / type literal 不产生 `$anon`/`%AC`/`<…>` class；真 class + 字面量初值仍保留 class/property。  
- CHANGELOG `[Unreleased]` 用户向说明。

### 2.2 不做

- 为 OBJECT 建独立 kind 或挂到初始化目标下的字段边。  
- 字面量方法简写「跳过壳、抬方法」（可后续）。  
- 改 tree-sitter 路径或其他语言的 class 语义。  
- 旧库自动清理（需 re-index）。

---

## 3. 行为与约束

| 场景 | 行为 |
| --- | --- |
| `const a = { i: 1 }` / `static cfg = { … }` | 存 `a`/`cfg`；**不**存 OBJECT 壳及其 property |
| `type P = { x: number }` | 可存 `type_alias`；**不**存 TYPE_LITERAL 壳 |
| `class Foo {}` / 真匿名 `ClassCategory.CLASS` | 照常 `class` |
| C++ `UNION`（若将来经 AA） | 不落成 `class`；本阶段 skip |

**约束：** 跳过即不写入 nodes/contains；与「声明图不追字面量形状」一致。

---

## 4. 验收

- [x] Spec 落盘；实现与本文一致（代码与 Spec 同批收尾，DEVELOPMENT §1.4.1）。  
- [x] `CLASS_CATEGORY` 含 TYPE_LITERAL / OBJECT / UNION。  
- [x] OBJECT / TYPE_LITERAL 不产生匿名 class 节点（单测）。  
- [x] 真实 named class + 字面量字段初值仍索引 class/property。  
- [x] `test/languages/arkts/arkts-class-category.test.ts` 通过。  
- [x] CHANGELOG `[Unreleased]` 已写；提交 footer 关联本 Spec。

---

## 5. 状态

**已完成** — `isNonDeclarationArkClassCategory` + `indexClass` 跳过；测试见 `arkts-class-category.test.ts`。
