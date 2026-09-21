# 0042 — 仓内定位优先 + Harmony 资源路牌


| 字段 | 内容 |
| --- | --- |
| 编号 | 0042 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-21 |
| 范围 | A：taskContext 退 FTS / 专名播种 / `sourceScope=local`；C.2：滤 `@dummyFile`/`%AM*`；B：`homegraph_project` 资源路径清单（有界扫盘）；单测与 CHANGELOG |
| 关联 | 领导草案 `0034-in-repo-locate-before-grep` 工作流 A + B + C.2（**不含** D 双模式/宿主、不含 Located/Miss 页眉）；Spec 0039–0041 |
| 非本 Spec | projectPath 防呆；字面量压 Logger；Partial→Located；codingeval/opencode D |


---

## 1. 背景与目标

explore 已调用，但仍 glob/grep，常见根因：

**A / C（检索与噪声）**

1. `taskContext` 整段进词法检索 → `TextInput` / `target` 压过真锚点  
2. 无后缀 `PracticeDetailView` 不播种  
3. 业务题未强制 `sourceScope=local` → SDK stub 当根  
4. `@dummyFile` / `%AM*` 泄漏到 trail / used-by  

**B（工程地图缺口）**

5. `rawfile` / `media` / 盘上未入图模块（如 `EntryCard/`）不在 project 输出 → 模型 Glob 资源树  

**目标：** 仓内精确锚点必须赢；噪声不进可见文本；project 用**路径白名单**给出资源路牌（不解析、不建边）。不改 D（bash-first / 宿主拼名）。

---

## 2. 范围

### 2.1 做

#### A — 检索（已实现主体，本文件为合同）

1. **`taskContext` 退出词法检索** — `canonicalQuery`/`retrievalQuery` = query；taskContext 可合并 quoted `literalTexts`；不得进 FTS。  
2. **无后缀专名播种** — query 内 PascalCase/CamelCase ≥8 + `Foo.ets`；黑名单通用词；精确文件 stem / 符号名强制进 explore roots。  
3. **业务题默认 `sourceScope=local`** — 专名/中文/`queryAsCodeChangeOrientation`；显式 `@kit`/`.d.ts`/SDK 不强制；explore 始终可传 `retrievalHints.sourceScope`。  
4. **MCP 可见噪声过滤** — trail / used-by / evidence packs 去掉 `@dummy*` 与 `/^%AM\d+/`。

#### B — `homegraph_project` 资源清单（本轮补齐）

5. **有界文件系统扫描**（follow ignore / skip `oh_modules`/`build`/`.git`/…；目录预算 + 总路径 cap，例如 dirs≤4000、每类路径 cap）：

| 路径规则 | 清单类 | 输出 |
| --- | --- | --- |
| `…/resources/…/element/string.json` | string.json | 路径（可含 locale 段） |
| `…/resources/…/rawfile/**`（文件） | rawfile | 路径列表 |
| `…/resources/…/(base/)?media/**`（目录） | media | **目录** + 扩展名计数（不枚举每个 png） |
| 盘上有 `oh-package.json5` 或 `module.json5`，且 project map **0** 个已索引源文件落在其下 | On disk, not in graph | 目录 + reason |

**不做进清单：** 任意不匹配上述规则的 `.json`；`route_map`/`main_pages`（0040 每模块 `route profile:` 已给，本节**不重复**）。  
**不做：** 解析 JSON 正文、建边、读媒体二进制、写入 graph.db（可仅内存扫；缓存可选，v1 可不落盘）。

6. **`homegraph_project` 渲染** — 在模块/文件列表之后追加（有则写）：

```markdown
### HarmonyOS resources
- string.json (N): `path`, …
- rawfile (N): `path`, … (+M more)
- media: `dir` (svg=12, png=3)

### On disk, not in graph
- `feature/EntryCard/` (oh-package.json5 present; 0 indexed source files)
```

`includeFiles=false` 时**仍输出**资源段。扫描失败/超预算 → 写 `inventory truncated` 或省略该类，**不得**让整个 project 失败。

7. 工具描述 / `SERVER_INSTRUCTIONS` 补一句：project 可列 Harmony 资源**路径**与未入图模块目录；不是全文、不是 call 边。

### 2.2 不做

- 产品 vs codingeval 双模式、opencode 双前缀、宿主 prompt（D）  
- Located / Miss / Partial 页眉合同  
- 字面量压 Logger  
- projectPath 串台防呆  
- color.json FTS、任意 mock 抽边  

---

## 3. 行为摘要

| 输入 | 行为 |
| --- | --- |
| query + 含 TextInput 的 taskContext | FTS 不含 taskContext |
| query 含 `PracticeDetailView` | 强制仓内精确根 |
| 改页/中文/专名 | sourceScope=local |
| trail 含 @dummy / %AM | 对外省略 |
| Harmony 仓 `homegraph_project` | 资源路牌 + 未入图目录（有界） |

---

## 4. 验收标准

### A / C

- [x] taskContext 不进 canonicalQuery；quoted literal 可合并  
- [x] 专名播种 / local 默认 / 噪声过滤单测（`test/in-repo-locate-0042.test.ts`）  

### B

- [x] fixture：`resources/.../element/string.json` + `rawfile/*.json` + `media/*` 出现在 project 的 HarmonyOS resources 段  
- [x] fixture：孤立目录仅有 `oh-package.json5`、无索引源文件 → `On disk, not in graph`  
- [x] `includeFiles=false` 仍有资源段；非白名单 json 不出现  
- [x] route profile 仍由 0040 行输出；资源段不重复堆 route_map  
- [x] CHANGELOG Unreleased 覆盖 B；本 Spec 勾选后状态已完成（commit 另发）

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 大仓扫盘慢 | 深度/目录预算 + 每类 cap；超时 truncated |
| 与 0040 route 行重复 | 资源段不列 route_map |
| local / 专名过强 | SDK 显式覆盖；黑名单 |

回滚：去掉资源扫描与渲染段；A/C 回滚同前。

---

## 6. 非目标

- Spec 0039–0041 边/FTS 语义变更（仅交叉文案）  
- 领导 Spec §6 Located / §7 D  
