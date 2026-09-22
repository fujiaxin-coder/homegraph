# 0039 — 鸿蒙 route_map / main_pages 抽边与配置出处可见


| 字段 | 内容 |
| --- | --- |
| 编号 | 0039 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-21 |
| 范围 | 索引白名单；`arkts-entry` 抽取与解析；边 metadata / explore 标注；单测与 CHANGELOG |
| 关联 | Spec 0038（路径提示）；codingeval 076：agent explore `route_map.json` 后因无命中自行 Glob/Read |


---

## 1. 背景与目标

鸿蒙 Navigation 注册表（`route_map.json` / `router_map.json`）与 `main_pages.json` **当前不进索引**。Agent 在 query 里点名这些文件时，explore 只能回一些 `.ets` 噪声，模型会认为 HG「没读配置」并再次 Read/Glob。

即使只静默抽边、正文只给 TS，agent 仍可能再读 JSON。需要：

1. **抽边**：配置 → 页面 / builder（策略可保真的白名单 schema）
2. **出处可见**：边与 explore 文案标明 wiring site（配置文件路径:行），避免二次 Read

**目标：** 白名单配置可索引；`route` 节点与 `references` 边连到页面/builder；`provenance: heuristic` + `synthesizedBy: arkts-route-map` + `registeredAt`；query 含配置文件名时回复前部有 Registration 摘要。

---

## 2. 范围

### 2.1 做

- `isSourceFile` / `detectLanguage`：白名单  
  `**/route_map.json`、`**/router_map.json`、`**/main_pages.json`（basename 精确；语言走现有 `yaml` 文件级路径，与 `module.json5` 相同）
- 扩展 `arkts-entry`：
  - 解析 `routerMap[]` 的 `name` / `pageSourceFile` / `buildFunction`（缺字段则跳过该条，不臆造）
  - 解析 `main_pages.json` 的 `src[]`（同现有 module pages）
  - `pageSourceFile` 相对 **Harmony 模块根**（profile 路径中 `/src/main/` 之前的前缀）解析为工程相对路径
  - 解析到页面 `@Entry`/组件或 `buildFunction` 同名函数/方法
- `createEdges`：源为 `route` 且来自上述配置（含已有 `module.json5`）时写入  
  `provenance: 'heuristic'`、`metadata.synthesizedBy: 'arkts-route-map'`、`registeredAt: '<configRel>:<line>'`
- MCP `synthEdgeNote`：识别 `arkts-route-map`，compact 文案含 `@registeredAt`
- explore：query 匹配 `route_map` / `router_map` / `main_pages`（大小写不敏感）时，在正文前追加 **Registration sources** 短表（配置路径 + `name → pageSourceFile` 或 pages 列表，有 cap）；表内路径为工程相对路径
- 单测（fixture index）：节点/边/registeredAt；可选 explore 摘要；CHANGELOG `[Unreleased]`

### 2.2 不做

- 不索引任意 `.json` / rawfile mock / `string.json` / `color.json`
- 不改 `homegraph_project` 骨架摘要（另案）
- 不把配置全文塞进 explore digest（短表 + 边出处即可）
- 不保证非标准字段名或非 `routerMap` 包装的私有格式

---

## 3. 行为与约束

| 输入 | 行为 |
| --- | --- |
| 标准 `routerMap` 条目含 `name`+`pageSourceFile` | `route` 节点（filePath=配置文件）；边 → 页面组件（能解析时） |
| 另有 `buildFunction` 且符号存在 | 可再边 → builder；或优先/兼解析 builder |
| `main_pages.json` `src` | 同 module.json5 pages → `@Entry` |
| schema 不符 / JSON 解析失败 | 跳过该文件或该条；不抛死 |
| explore query 含配置名 | 文首 Registration sources；其后照常 digests/flow |

**约束：** 边必须带 `registeredAt` 指向配置；partial 覆盖（有节点无边）允许；禁止半截错误边猜路径。

---

## 4. 验收标准

- [x] 白名单三文件可被 `isSourceFile` / 索引扫到；非白名单 `.json` 仍忽略
- [x] fixture：`route_map`/`router_map`/`main_pages` 产生 `route` 节点；能连到页面或 builder；边含 `arkts-route-map` + `registeredAt`
- [x] `synthEdgeNote` 对这类边给出含 `@…json:line` 的 compact
- [x] explore query 含 `route_map` 时正文含 `Registration sources`
- [x] CHANGELOG Unreleased；实现后 Spec 状态已完成（commit 由维护者另发）

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 多模块同名 route | 边带模块内 pageSourceFile；registeredAt 消歧 |
| 索引文件略增 | 仅 basename 白名单，模板仓量级可接受 |
| agent 仍 Read 全文 | 短表给 name/path；改注册仍可能 Read——可接受 |

回滚：revert 本 Spec 实现；或 `isSourceFile` 去掉白名单。

---

## 6. 非目标

- Spec 0038 路径提示（已完成）
- app/build-profile/oh-package 进 project 摘要
- 资源 string.json FTS
