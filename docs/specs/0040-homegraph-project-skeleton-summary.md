# 0040 — `homegraph_project` 鸿蒙工程骨架摘要


| 字段 | 内容 |
| --- | --- |
| 编号 | 0040 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-21 |
| 范围 | `homegraph_project` 输出骨架摘要；工具描述与 `server-instructions` 同步「给什么/不给什么」；单测与 CHANGELOG |
| 关联 | Spec 0039（route_map 图边）；Spec 0021（project map 基线） |


---

## 1. 背景与目标

Agent 需要「有哪些模块、路由表文件在哪」时，应走 **工程地图**，而不是把 `build-profile.json5` / `app.json5` / `oh-package.json5` 抽成 call 边。现有 `homegraph_project` 只列模块名与文件列表，模型仍常 Glob 多个 `route_map.json`。

**目标：**

1. 在 `homegraph_project` 中增加只读骨架摘要（不改图边语义）。
2. 同步 MCP 工具描述与 initialize instructions：**project = 地图/指针；explore = 符号/路由边；资源 JSON 全文检索另案**。

---

## 2. 范围

### 2.1 做

- 渲染 `homegraph_project` 时（不必改 DB schema）：
  - 若存在 `app.json5` / `AppScope/app.json5`：一行 `bundle: <bundleName|name>`（解析失败则省略）
  - 若模块来自 Harmony `build-profile`（`kind=harmony`）：页眉注明 `modules from build-profile.json5`；说明为 skeleton，非 call 边
  - 每个模块：在文件列表前，列出该模块根下发现的 Spec 0039 白名单 profile 相对路径（`route_map.json` / `router_map.json` / `main_pages.json`），形如 `route profile: \`…\``；可选一行 `oh-package: <name>`（模块根 `oh-package.json5`）
  - profile 扫描：模块根下有限深度 walk，跳过 `oh_modules`/`build`/`.git` 等；每模块 profile 条数 cap（如 8）
- 更新 `homegraph_project` 的 tools/list 描述与 `server-instructions`：明确给什么 / 不给什么（见 §3）
- 单测：Harmony fixture 下 project 输出含 bundle、route profile 路径；描述字符串断言；CHANGELOG

### 2.2 不做

- 不把骨架文件抽成 `calls`/`references` 边（边仍由 0039 负责）
- 不索引 `string.json` / `color.json` 全文检索（轻量检索另案）
- 不改 project_modules 表结构；不默认展开 profile JSON 全文

---

## 3. 行为与「给什么 / 不给什么」（须写入 instructions）

| 工具 | 给 | 不给 |
| --- | --- | --- |
| `homegraph_project` | 模块边界、文件清单、鸿蒙 bundle 名、每模块 route profile **路径**、oh-package 名 | 符号体、call 图、route_map **全文**、资源 string 键值 |
| `homegraph_explore` / node / callers… | 符号、关系；含 0039 时 route 边与 Registration sources | 工程骨架总览（优先用 project） |
| 普通 Read/Grep/Glob | 任意文件原文 | —（HG 未覆盖时仍用这些） |

**约束：** 摘要失败（缺文件/解析失败）不得让整个 `homegraph_project` 失败；静默省略该行。

---

## 4. 验收标准

- [x] Harmony fixture：`homegraph_project` 含 `bundle:`（若 app.json5 有）与至少一条 `route profile:`
- [x] 非鸿蒙小仓行为不回归（仍有 Project map + 文件）
- [x] tools 描述与 `SERVER_INSTRUCTIONS` 含 project vs explore 分工句
- [x] CHANGELOG Unreleased；Spec 状态已完成（commit 另发）

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 大模块 walk 慢 | 深度/目录预算 + skip 集；仅 basename 白名单 |
| 文案变长 | profile cap；文件列表原有 FILE_CAP 不变 |

回滚：去掉摘要渲染与描述句。

---

## 6. 非目标

- Spec 0039 边语义变更
- 资源 JSON FTS（C 层）
