# 0041 — 鸿蒙 `element/string.json` 轻量检索（FTS，不抽边）


| 字段 | 内容 |
| --- | --- |
| 编号 | 0041 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-21 |
| 范围 | 白名单索引；`arkts-entry` 抽 constant（无边）；explore Resource hits；instructions / 单测 / CHANGELOG |
| 关联 | Spec 0039（route 图边）；Spec 0040（工程地图，曾将资源 FTS 列为非目标）；codingeval 076：题面文案靠 Glob/`string.json` |


---

## 1. 背景与目标

题面常带中文文案或资源键（如「提交订单」、`share_description`）。真值落在 `resources/**/element/string.json`，**没有稳定调用边**，但模型需要先**落到文件/键**，再 Grep `$r('app.string.xxx')`。

现状：

- `literal-evidence` 仅在 query 带 `literalTexts` 时磁盘扫描，不进 FTS
- `string.json` 不在 `isSourceFile` 白名单 → search/explore 撞不到文案 → agent 认定「HG 没读资源」并 Glob/Read

**目标（轻量检索，不加假边）：**

1. 白名单入库 `**/resources/**/element/string.json`（先不做 color / media / rawfile）
2. 每条 `name`+`value` → `constant` 节点；**值进 `docstring` → `nodes_fts`**；**零** `references`/`calls`
3. explore 命中时文首 **Resource hits** 短表 + `$r('app.string.<key>')` Grep 指引

**例子：** 题面「把按钮改成『提交订单』」→ FTS 命中 `submit_order` / docstring「提交订单」→ Resource hits 指向 `…/element/string.json` → agent Grep `$r('app.string.submit_order')` 找控件。

---

## 2. 范围

### 2.1 做

- **`isHarmonyElementStringJson(path)`**  
  正则等价于：`(?:^|/)resources/(?:[^/]+/)*element/string.json`（大小写不敏感；`\` 先规范成 `/`）。  
  **否：** 根目录 `string.json`、`rawfile/foo.json`、`color.json`、`**/element/color.json`。
- **`isSourceFile` / `detectLanguage`**：命中则 indexable；语言 = `yaml`（文件级空抽 + framework extract，同 Spec 0039 profile）。
- **`arkts-entry`**
  - `detect`：工程内存在上述 path 亦可激活（与 module / route profile 并列）
  - `extract`：`jsonc-parser` 解析；收集形如 `{ name: string, value: string }` 且 `name` 匹配 `/^[A-Za-z_][\w]*$/` 的条目（兼容 `string: [...]` 包装与深层遍历，与现有 literal-evidence 同构）
  - 每条发射 **仅** `constant`（**不** push `references`）：
    - `id`: `harmony-string:<relPath>:<key>`（或含行号，防撞）
    - `name` = key；`qualifiedName` = `app.string.<key>`
    - `docstring` = value（长度 cap，建议 200）
    - `signature` = `$r('app.string.<key>')`（便于 digests / 指引）
    - `language` = `yaml`；`startLine`/`endLine` 尽量对准键出现行
  - 每文件条目 cap（建议 2000）；坏 JSON → 跳过整文件，不抛死
- **MCP explore**  
  当 query 含 `string.json`（大小写不敏感）**或** 根据 query 子串能匹配到上述 constant（name / docstring / qualifiedName）时，文首追加：

  ```text
  **Resource hits** (element/string.json — searchable literals, no graph edges)
  - `entry/.../element/string.json:12` — "提交订单" → `submit_order` · Grep `$r('app.string.submit_order')` in `.ets`
  ```

  幂等（已有 `**Resource hits**` 不再叠）；行数 cap（建议 8）。挂载点对齐 Spec 0039 Registration sources（`exploreResult` / `ensureExploreEmission`）。
- **文案同步**：`SERVER_INSTRUCTIONS` + explore 工具描述 — string.json **可检索、无图边**；color/media 仍 Grep/Read。Spec 0040 instructions 里「资源另案」改为指向本能力。
- 单测（fixture index + 可选 explore）+ CHANGELOG `[Unreleased]`；commit footer `Spec: docs/specs/0041-….md`

### 2.2 不做

- 不索引 color / media / rawfile / 任意 `.json`
- 不从 string → `.ets` 控件抽边
- 不改 `literal-evidence` 磁盘扫描语义（与索引 FTS 并存）
- 不改 `nodes_fts` schema / 全局 BM25 权重
- 不要求 `homegraph_search` 单独改工具描述（走同一批 constant + FTS 即可；explore 短表为验收主路径）

---

## 3. 行为与约束

| 输入 | 行为 |
| --- | --- |
| 标准 element/string.json 含 name+value | constant 入库；值在 docstring 可 FTS |
| name 非法 / 缺 value | 跳过该条 |
| JSON 坏 | 跳过该文件 |
| explore：query 含 string.json 或匹配到资源 constant | 文首 Resource hits |
| 非白名单 json | 仍不索引 |

**约束：** 禁止为本 Spec 新增任何边；Resource hits 只定位键值，不替代编辑时的 Read。

---

## 4. 验收标准

- [x] `isHarmonyElementStringJson` / `isSourceFile`：`…/resources/base/element/string.json` 为真；`rawfile/x.json`、根 `string.json`、`…/element/color.json` 为假；`detectLanguage` → `yaml`
- [x] fixture `indexAll`：存在 `constant`（如 `submit_order`），`docstring` 含「提交订单」，`qualifiedName` 含 `app.string.`；对该节点 `getOutgoingEdges` 为空（本 Spec 未抽边）
- [x] `searchNodes` 用文案或键能召回该 constant；explore（query 含文案或 `string.json`）正文含 `Resource hits` 与 `$r('app.string.`
- [x] `SERVER_INSTRUCTIONS` 不再写「string.json 完全不是 HG」；改为可检索、无图边
- [x] CHANGELOG Unreleased；Spec → 已完成；`commit -s` + `push origin main`

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 大仓条目爆炸 | 每文件 cap + 值长度 cap |
| 短中文 FTS 弱 | 完整短语进 docstring；literal-evidence 仍兜底 |
| constant 噪声进 digests | Resource hits 短表优先；kind=constant 本就偏轻 |
| agent 仍 Read 全文 | 短表够定位；改 JSON 仍可能 Read——可接受 |

回滚：去掉白名单 + extract 分支 + Resource hits 挂载 + instructions 复原。

---

## 6. 非目标

- color / media FTS（另 Spec）
- shortcuts_config / form_config / file-data mock 入库（配置族扩展，另 Spec）
- 改 explore 消歧 / SDK 降权（与本 Spec 正交）
