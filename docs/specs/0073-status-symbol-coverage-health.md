# 0073 — status 报告符号缺失的文件

| 字段 | 内容 |
| --- | --- |
| 编号 | 0073 |
| 类型 | 缺陷修复 |
| 状态 | 已完成 |
| 日期 | 2026-11-20 |
| 范围 | `src/db/queries.ts`（新增 `getFilesWithoutSymbols`）；`src/index.ts`（`getIndexHealth`）；`src/bin/homegraph.ts`（status 输出 + `--strict`）；测试 `test/index-health.test.ts`（新增）；CHANGELOG |
| 非本 Spec | 索引新鲜度检测（Spec 0071，已修，正交问题）；`index_state` 的 partial/failed 语义（不变）；sync 自动修复 `needsReindex` 组（后续跟进） |

---

## 1. 背景

`homegraph status` 只回答"索引是否跟上了磁盘"，不回答"索引里的内容是否有用"。一个文件**内容哈希完全正确、索引里也有它的行**，但**一个符号都没提取出来**时，status 仍报 `[OK] Index is up to date`，`index.state = complete`，`action = none`。

实测（`src/broken.ts` 内容为无法解析的文本）：

```
$ homegraph init .
*  Indexed 2 files
•  3 nodes, 1 edges        ← 3 = 2 个 file 节点 + 1 个 function；broken.ts 零符号

$ homegraph status
  file            2
  function        1        ← broken.ts 贡献 0 个符号，无任何提示
[OK] Index is up to date   ← 假报

$ homegraph status --json
  "state": "complete"      ← 明确标记为完整
  "action": "none"
```

用户无从得知 `broken.ts` 的符号全部丢失。

### 与前两个 Spec 的关系（三个正交问题）

| Spec | 回答的问题 | 判定依据 |
| --- | --- | --- |
| 0071 | 磁盘变了，索引跟上了吗？ | `indexed_at_commit` stamp + `git diff` + 内容哈希 |
| 0072 | 进度上报越界会崩吗？ | 计数与 total 同量纲 |
| **0073** | **索引里的行有用吗？** | **文件符号产出率** |

0071 的全套检查（stamp 一致、diff 为空、哈希相同）在 0073 场景下**全部通过**——内容确实没变，索引确实"最新"，但索引内容是空的。`sync` 也无法自愈：内容未变，sync 判定无变更，不会重新解析。

### 根因

`status` 的完整性判断只有 `index_state`（`complete`/`partial`/`failed`），而这个标记来自**索引运行时**的文件计数对账（`filesDiscovered` vs `filesIndexed + filesSkipped + filesErrored`）。一个"文件计入 indexed、但提取器产出零符号"的情况完全在它的雷达之外：文件确实被发现了、确实被"索引"了、也确实没报错。

## 2. 目标

- `homegraph status` 明确报告"已索引但符号缺失"的文件，并给出该跑什么命令。
- 区分两类根因：**可重试**（需要重新索引）与**解析失败**（内容本身有问题，重试无用）。
- `homegraph status --strict` 在上述任一情况或索引未完成时非零退出，供 CI / 脚本使用。
- 不误报：文件级语言（如 `yaml`/`json` 这类本来就不产符号的）、超限跳过的文件、生成的 ambient 声明文件不在此列。

## 3. 方案

### 3.1 新增查询：`getFilesWithoutSymbols`

`src/db/queries.ts`：

```ts
getFilesWithoutSymbols(): FileRecord[]
```

SQL 找出 `node_count` 只含 file 节点自身、或记录了解析错误的文件：

```sql
SELECT * FROM files
WHERE node_count <= 1 OR errors IS NOT NULL
ORDER BY path
```

**关键**：HomeGraph 每个被索引的文件都会存一个 `kind='file'` 的节点，所以 `node_count = 1` 表示"只有 file 节点，零符号"。这与 codegraph 的 `nodeCount === 0` 判定不同，因为两边的 file 节点记账方式不同（实测 `broken.ts` 的 `node_count` 是 1，正是那个 file 节点）。

### 3.2 健康检查：`getIndexHealth()`

`src/index.ts` 新增：

```ts
interface IndexHealth {
  /** 内容正确但符号缺失 —— 重新索引可能修复。 */
  needsReindex: string[];
  /** 解析失败 —— 内容本身有问题，重试无用。 */
  parseErrors: string[];
}

getIndexHealth(): IndexHealth
```

对 `getFilesWithoutSymbols()` 的每个文件分类：

1. `isFileLevelOnlyLanguage(file.language)` → 跳过（该语言本来就不产符号，空是正常的）
2. `errors` 含 `code === 'parse_error'` 或 `code === 'grammar_load_failed'` → `parseErrors`
3. `nodeCount <= 1` 且 `errors` 为空 → `needsReindex`（行被抹掉但没记错误）
4. `nodeCount <= 1` 且有非 parse_error 错误 → `needsReindex`

**误报防护（实现阶段补入）**：`noSymbols` 为真时还要排除两类"天生无符号"的文件，否则报告会在任何现代 TS 仓库上天天误报：

- **re-export barrel**（`export * from './x'` / `export { A } from './a'` / `export type { T } from './t'`）—— 它的职责就是转发别处声明的名字，自身没有声明。用 `isReExportOnlyFile()` 从源码判定；任何 `const`/`let`/`function`/`class`/`interface`/`type X =`/`enum`/`namespace` 声明都使文件失去豁免（保守优先：宁可报，不可漏）。
- **压缩的单行数据载荷**（≤2 行且 >4096 字符，如 `window.DATA = {...}`）—— 它不是代码，没有声明可提取，用户也无从修改。

`needsReindex` 与 `parseErrors` 互斥，一个文件只进一组。

### 3.3 status 输出

`src/bin/homegraph.ts` 的 status，在 `Index is up to date` / `Pending Changes` 判定**之前**插入健康检查：

```
Index Health:
  2 files are missing their symbols — run "homegraph sync" to re-index them: src/a.ts, src/b.ts
  1 file could not be parsed, so its symbols are missing: src/c.ts — "homegraph files --json" shows the errors
```

- 健康问题存在时，**不再打印** `[OK] Index is up to date`；改为打印 `[!] Index is up to date, but N files yielded no symbols`，避免"up to date"和实际损坏并列造成的误导。
- 文本措辞参照 codegraph 的 `describeFilesMissingSymbols`，用 `samplePaths` 只列前 3 个 + `(+N more)`。
- `--json` 增加 `indexHealth: { needsReindex: string[], parseErrors: string[] }`。

### 3.4 `--strict`

`homegraph status --strict`：出现以下任一情况时退出码 1（否则 0）：

- `index.state` 不是 `complete`
- `needsReindex.length > 0`
- `parseErrors.length > 0`
- `pendingChanges` 总数 > 0

非 strict 模式行为不变（始终 0，除非命令本身失败）。

## 4. 行为矩阵

| 场景 | 改动前 | 改动后 |
| --- | --- | --- |
| 所有文件正常产出符号 | `[OK] Index is up to date` | 不变 |
| 某文件解析失败、零符号 | `[OK] Index is up to date`（**假**） | 打印 `Index Health`，指出该文件，`--strict` 退出 1 |
| 某文件行被抹掉、零符号、无错误 | `[OK]`（假） | 归入 `needsReindex`，提示跑 sync |
| 文件级语言（yaml/json）零符号 | 不提示 | 不变（`isFileLevelOnlyLanguage` 跳过） |
| 全部文件零符号 | `[OK]`（假） | 报告全部，`--strict` 退出 1 |
| 索引 stale（extraction 版本旧） | 提示 re-index | 不变 |
| 索引有 pending changes | `Pending Changes` | 不变（健康检查独立并行） |

## 5. 验收

- [x] Spec 落盘
- [x] `src/db/queries.ts`：`getFilesWithoutSymbols()`
- [x] `src/index.ts`：`getIndexHealth()` + `IndexHealth` 类型导出
- [x] `src/bin/homegraph.ts`：status 打印 `Index Health`；有问题时不打印裸 `[OK]`；`--json` 带 `indexHealth`；`--strict` 非零退出
- [x] 单元测试 `test/index-health.test.ts`（16 passed，含 barrel/压缩数据误报防护与负向对照）：解析失败归 `parseErrors`；行被抹掉归 `needsReindex`；文件级语言跳过；全正常时两组皆空；`--strict` 退出码
- [x] `npm run build` 通过
- [x] `npx vitest run test/index-health.test.ts` 全绿
- [x] 手工验证（零符号仓库被检出且 `--strict` 退出 1；HomeGraph 自身 1000+ 文件仓库零误报）：零符号文件在 status 中被指出，`--strict` 退出 1
- [x] CHANGELOG.md `[Unreleased]` Fixes 条目
