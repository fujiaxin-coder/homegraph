# 0045 — ArkUI 父→子组件边 + 具名导航字面量→route


| 字段 | 内容 |
| --- | --- |
| 编号 | 0045 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-21 |
| 范围 | 索引期 synthesizer：`arkui-child`、`arkui-named-nav`；单测与 CHANGELOG |
| 关联 | Spec 0044（10.3 搁置项中的低风险补边）；0039 route_map；既有 `arkui-route`（pushUrl） |
| 非本 Spec | `@Watch` 全链、非字面量 url/组件名、兄弟页硬连、加大 explore digest |


---

## 1. 背景与目标

explore 已能定位页/字面量，但仍常见 **父页→子组件**、**具名 Navigation** 在图上断链（080/101/113 类接线题）。现有合成：`arkui-route`（`pushUrl` 字面量）、`arkts-route-map`、`arkui-state` / emitter 等，**缺**：

1. `build()` / `@Builder` 内对另一 `@Component` / `@Builder` 的调用  
2. `pushPathByName('…')` / `pushNamedRoute({ name: '…' })` 等**字面量** → 已索引 `route` 节点  

**目标：** 在 `index`/`resolve` 写入 `provenance: heuristic` 边，explore 可读库内边；**歧义丢弃**，半截桥不做。

---

## 2. 范围

### 2.1 做

#### A — `arkui-child`（父→子）

1. 扫描 `.ets` 中父节点：`method` 名为 `build`，或带 `@Builder` / `@LocalBuilder` 的 function/method。  
2. 在父体源码中匹配 PascalCase 调用 `\bName\s*\(`。  
3. 解析 `Name` → 唯一目标：带 `@Component` / `@ComponentV2` / `@Entry` 的 `struct`/`component`，或带 `@Builder`/`@LocalBuilder` 的 function/method。  
4. 多候选：优先同文件 → 同模块目录；仍 >1 则**不建边**。  
5. 边：`calls`，`synthesizedBy: arkui-child`，`via: <ChildName>`，`registeredAt: parentFile:line`。  
6. 每父节点子边上限对齐 JSX 通道（约 30）。

#### B — `arkui-named-nav`（具名导航字面量→route）

7. 匹配字面量：`pushPathByName('x')` / `replacePathByName('x')` / `pushNamedRoute({ name: 'x' })`（及 `obj.` 前缀形式）。  
8. 目标：索引中 `kind=route` 且 `name === x`；多候选同模块优先，否则丢弃。  
9. 边：`calls`（或 `references` 若更贴语义；v1 用 `calls` 以便 explore 脊柱），`synthesizedBy: arkui-named-nav`，`event: <name>`。  
10. **不做**变量名路由、非字面量。

### 2.2 不做

- 系统组件白名单穷举（靠「必须解析到仓内 Component/Builder」过滤 `Column`/`Text`）  
- `@Watch` / 动态 `this[compName]`  
- 查询时现建边  

---

## 3. 行为摘要

| 输入 | 行为 |
| --- | --- |
| `build() { ShoppingCart() }` 且仓内有 `@Component struct ShoppingCart` | `build` → ShoppingCart（`arkui-child`） |
| 同名两组件跨模块且无法消歧 | 不建边 |
| `pushPathByName('DemoPage')` 且 route_map 有 `DemoPage` | 调用点 → route（`arkui-named-nav`） |
| `pushPathByName(nameVar)` | 忽略 |

---

## 4. 验收标准

- [x] fixture：父 `build` 调用子 `@Component` → 存在 `arkui-child` 边  
- [x] fixture：`Column()` 等无仓内 Component 目标 → 无边  
- [x] fixture：`pushPathByName` 字面量 + route_map → `arkui-named-nav` 边  
- [x] 重名歧义不建边（单测）  
- [x] CHANGELOG Unreleased；完成后勾选（commit 另发）  

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 误链系统组件 | 必须解析到仓内 Component/Builder |
| 边爆炸 | 每父上限 + 歧义丢弃 |
| 与静态 `calls` 重复 | merge 去重（既有 synthesizer 路径） |

回滚：从 `SYNTH_PASSES` 去掉两 pass 即可。

---

## 6. 非目标

- Spec 0044 检索合同变更  
- 补全全部 Navigation API 表面  
