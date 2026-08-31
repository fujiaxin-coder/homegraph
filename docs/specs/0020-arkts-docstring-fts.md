# 0020 — ArkTS docstring 写入 `nodes` / `nodes_fts`


| 字段 | 内容 |
| --- | --- |
| 编号 | 0020 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-08-31 |
| 范围 | ArkTS Scene 注释开关；从 ArkAnalyzer metadata 填 `Node.docstring`；相关单测；CHANGELOG |
| 关联 | [0019](./0019-arkui-component-id.md)（同批 ArkTS 索引补全）；tree-sitter `getPrecedingDocstring`（其他语言对照） |


---

## 1. 背景与目标

其他语言在抽取声明时用 `getPrecedingDocstring` 写入 `nodes.docstring`，SQLite 触发器同步进 `nodes_fts`，供全文按注释/文档召回。

ArkTS 走 ArkAnalyzer：`makeNode` **从不写** `docstring`，FTS 该列恒空。ArkAnalyzer 已有 `LEADING_COMMENTS` / `JSDOC` metadata，但 Scene 目前只开了 `enableMethodBodyBuild`，注释开关关闭时 metadata 为空。

**目标：** 打开必要 Scene 开关，索引期把声明上方注释/JSDoc 写入 `docstring`，与其他语言一样进入 `nodes_fts`。

---

## 2. 范围

### 2.1 做

- `buildSceneConfig`：`enableLeadingComments: true`、`enableJSDoc: true`（不开 trailing，与「声明上方」对齐）。
- 从 Ark 模型 `getMetadata` 取 leading comments（优先）或 JSDoc description，剥注释标记后写入节点 `docstring`；覆盖 class / component / method / field / namespace / local / type_alias 等已有 `makeNode` 路径（有 `getMetadata` 的模型）。
- 单测：`.ets` 声明上方 `/** … */` 或 `// …` 后，对应节点 `docstring` 含正文。
- CHANGELOG `[Unreleased]` 用户向一句。

### 2.2 不做

- 不改 `nodes_fts` schema / 权重 / 查询算法。
- 不单独为 import 强求 docstring（若模型无 metadata 则空）。
- 不做表达式/非字面量文档；不解析结构化 `@param` 进独立列（正文进 docstring 即可）。
- 不强制重索引旧库（升级后需 re-index 才有值）。

---

## 3. 行为与约束

| 场景 | 行为 |
| --- | --- |
| 声明上方有 leading comment | `docstring` = 去标记后的正文（多段 `\n` 拼接） |
| 仅有 JSDoc、leading 空 | 用 JSDoc `description`（多块则拼接） |
| 无注释 | `docstring` 缺省 |
| 与其它语言 | 语义对齐「声明紧邻上方注释」，不保证字节级相同 |

---

## 4. 验收

- [x] Spec 确认后实现。
- [x] Scene 打开 leading + JSDoc；符号节点可带非空 `docstring`。
- [x] 相关 vitest 通过；CHANGELOG `[Unreleased]` 已写。
- [x] 提交关联本 Spec（合入后状态 →「已完成」）。

---

## 5. 状态

**已完成** — `enableLeadingComments` + `enableJSDoc`；`docstringFromArkModel` 写入 class/component/method/field 等；测试见 `arkts-docstring.test.ts`；CHANGELOG `[Unreleased]` 已记。
