# 0059 — ArkTS 跨文件 import / 继承边不得静默丢弃

| 字段 | 内容 |
| --- | --- |
| 编号 | 0059 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-10-21 |
| 范围 | `src/extraction/languages/arkts.ts` 跨文件 `imports` / `extends` / `implements` 落库；ArkUI 内置装饰器不再模糊同名匹配；seedMaps 已索引文件跳过重扫 |
| 非本 Spec | yaml 缺 file 节点；ArkTS `instantiates`/`exports`/`returns` 语义补齐；ohpm bare 名解析增强 |

---

## 1. 背景与目标

`applications_photos` 全量索引：约 1.98 万 ArkTS `import` 节点，**`import → file` 边为 0**；`extends`/`implements` 的 `cross_file` 也为 0。后果是跨文件图桥断裂，explore 易 `no_path_in_scope`。

根因：

1. `indexImports` / `indexClass` 把跨文件边塞进本文件 `result.edges`，`persistFileResult` 要求两端都在本文件节点集合里，边被滤掉。
2. 目标尚未进 `nodeIds` 时既不建边也不写 `unresolvedReferences`（静默）。
3. 同仓库里 calls / viewtree 已正确走 `crossFileEdges`，批次结束再 `insertEdges`。

**目标：** 跨文件 import / 继承边与 calls 同路径落库；解析不到时留下 unresolved，禁止静默丢。

---

## 2. 范围

### 2.1 做

- 抽取 `addMaybeCrossFileEdge`：同文件 → `result.edges`，否则 → `crossFileEdges`（emit 时**不**要求 `nodeIds.has(target)`）。
- `indexImports`：有 declaring file 则走上述路径；无 declaring file 但有 module 路径 → `unresolvedReferences`。
- `indexClass` 的 `extends` / `implements`：同样走 `addMaybeCrossFileEdge`；无目标 id 时推 unresolved。
- ArkUI 内置装饰器名（State、Prop、Link、Builder、Component…）不再作为 `decorates` unresolved 交给 name-matcher（避免连到无关同名 enum/class）。
- `seedMapsFromOtherLoadedFiles`：若 `file:<rel>` 已在 `nodeIds`，跳过全量 `indexScannedFile`（依赖 `bindLiveMapsFromResident` 重绑）。

### 2.2 不做

- 不改 `persistFileResult` 的同文件 FK 过滤（其它语言路径依赖它）。
- 不强制 SDK `@kit.*` / `@ohos.*`（点号 API）造 file 边。
- 不在本 Spec 修 yaml file 节点缺口。

---

## 3. 行为

| 场景 | 结果 |
| --- | --- |
| `import { X } from './Y'` 且 Y 在工程内 | `import` 节点 → `file:Y` 的 `imports` 边入库 |
| `import … from '@ohos/library'`（ohpm 工作区，exportInfo 指向工程文件） | 同上 |
| 跨文件 `class A extends B` 且 B 已有节点 | `extends` 边入库（可跨文件） |
| 基类/接口当时解析不到节点 | `unresolvedReferences`（extends/implements），不静默 |
| `@State` / `@Link` 等内置装饰器 | 不产生指向无关同名符号的 `decorates` 边 |

---

## 4. 验收

- [x] 多文件相对 import：索引后存在 `import`→`file:…` 的 `imports` 边
- [x] 跨文件 `extends`：存在跨 `file_path` 的 `extends` 边
- [x] 相关 vitest 通过 (`test/languages/arkts/arkts-cross-file-edges.test.ts`)
- [x] （手工）`applications_photos` 重索引后 ArkTS `import→file` 14154（修复前 0）；跨文件 extends/implements 472（修复前 0）
- [x] CHANGELOG `[Unreleased]` 有条目
