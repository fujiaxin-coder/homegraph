# 0038 — MCP 注明工程根绝对路径与相对路径拼接


| 字段 | 内容 |
| --- | --- |
| 编号 | 0038 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-21 |
| 范围 | MCP 成功工具回复中的工程根绝对路径提示；`server-instructions` 一句；单测与 CHANGELOG |
| 关联 | Spec 0035（status footer 挂载点）；codingeval 076 反馈：模型把相对路径错拼到 experiment/result 目录 |


---

## 1. 背景与目标

索引与工具正文里的 `filePath` 刻意保持 **工程根相对的 POSIX 路径**（跨机、稳定、可测）。部分 agent（尤其评测沙箱）会自行拼接绝对路径，把 `codingeval/result/...` 等实验目录或错误模块前缀拼进去，导致 `File not found`。

**目标：** 在已知 `projectRoot` 时，工具回复明确给出 **绝对工程根**，并写清如何与相对路径拼接 / 应原样交给 Read/Grep；**不**改库内路径存储，**不**把每条 hit 改成绝对路径。

---

## 2. 范围

### 2.1 做

- 导出短提示文案（如 `formatProjectRootPathHint(absRoot)`）与幂等检测（正文已含同一标记则不再追加）
- 在现有成功结果装饰路径（与 Spec 0035 `withProductStatusFooter` 同挂载点）**文首**追加 2 行以内提示：
  - `HomeGraph project root: \`<absolute>\``
  - 一句：相对路径相对该根；优先原样传给 Read/Grep；或 `<root>/<relative>`（`/`）；勿臆造 experiment/result 等前缀
- 绝对根使用宿主 `path.resolve(getProjectRoot())` 的平台原生形式（Windows 可为 `D:\...`）
- `server-instructions` 的 Query 段补一句与上一致的根路径指引（不替代正文提示）
- 单测 + CHANGELOG `[Unreleased]` Improvements；commit footer：`Spec: docs/specs/0038-….md`

### 2.2 不做

- 不把 DB / explore 正文中的相对路径批量改为绝对路径
- 不抽鸿蒙 `route_map.json` 等配置边（另案）
- 不改 status 五态语义与 `HomeGraph status=` 行格式
- 不要求 CLI 非 MCP 输出带该提示

---

## 3. 行为与约束

| 条件 | 行为 |
| --- | --- |
| 能解析到工程根且结果非 `isError` | 文首追加提示（若尚未含 `HomeGraph project root:`） |
| 纯 `HomeGraph status=…` 指引（0035） | **仍可**追加根路径提示（根已知时）；status 行逻辑不变 |
| 已含 `HomeGraph project root:` | 不重复追加 |
| 无法打开工程 / 无 root | 不追加，静默跳过 |

**约束：** 提示 ≤3 行、固定英文短句；不得显著拉长 explore 正文；相对路径语义不变。

---

## 4. 验收标准

- [x] `formatProjectRootPathHint` 含绝对根与拼接/原样使用说明；幂等检测通过
- [x] 经 `withProductStatusFooter` 的成功回复在已知 root 时文首带提示；已有标记不重复
- [x] `server-instructions` 含工程根 / 相对路径用法一句
- [x] 单测覆盖；CHANGELOG Unreleased；commit：`Spec: docs/specs/0038-mcp-project-root-path-hint.md`

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 每条工具多几十 token | 文案压到 2 行；幂等 |
| 弱模型仍乱拼 | 文首位置 + instructions 双通道；宿主 Read 强制相对根另案 |

回滚：revert 本 Spec 实现 commit，或装饰函数 no-op。

---

## 6. 非目标

- 鸿蒙 profile JSON 抽边（问题 1）
- 每条文件路径双写绝对路径
