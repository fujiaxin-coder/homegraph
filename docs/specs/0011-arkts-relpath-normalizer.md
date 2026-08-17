# 0011 — ArkTS 相对路径：一次规范根 + 热路径裁剪


| 字段 | 内容 |
| --- | --- |
| 编号 | 0011 |
| 类型 | 变更 / 性能 |
| 状态 | 已完成 |
| 日期 | 2026-08-17 |
| 范围 | `src/extraction/languages/arkts.ts` 中 ArkAnalyzer 绝对路径 → 项目相对路径；单测；CHANGELOG |
| 关联 | 回归源 `bdd13a2`（每次 `normalizeRelPath` 双 `realpathSync`）；macOS `/var`↔`/private/var` 与 symlink 根正确性 |


---

## 1. 背景与目标

`bdd13a2` 为修复 macOS 上 `mkdtemp`/`rootDir` 未解析（`/var/...`）与 ArkAnalyzer 已 `realpath`（`/private/var/...`）时 `path.relative` 逃出项目、batch 空结果，在 **每次** `normalizeRelPath` 对 root 与 file 调用 `fs.realpathSync`。

该函数在 ArkTS 模块索引热路径上被极高频调用（scan / indexFile / call edge / import / ViewTree 等）。大仓（如 `scene_board`）上表现为每个模块 Storing 明显变慢；Windows 无 `/var` 问题也全量付 syscall 税。

**目标：**

1. **正确性：** 任意工程在 symlink / macOS `/var`↔`/private/var` / junction 导致「根与文件绝对路径形态不一致」时，相对路径仍正确；不得空 batch、不得因路径错位漏文件。
2. **性能：** 热路径回到接近 `bdd13a2` 之前（字符串运算）；不得对每个调用做双 `realpath`。

**成功标准：** 现有 ArkTS / mkdtemp 相关测试通过；新增 normalizer 单测覆盖「未解析根 + 已解析文件」与快路径无 per-file `realpath`；大仓体感 Storing 回到变慢前量级。

---

## 2. 范围

### 2.1 做

- 在 ArkTS batch / `ArkTSAdapter` 入口对 `rootDir` **`realpath` 一次**，作为规范根。
- `normalizeRelPath`（或等价 API）：
  - **快路径：** 绝对路径（统一分隔符后）以规范根为前缀 → 字符串裁剪出相对路径；**不** `realpath` 文件。
  - **慢路径：** 前缀对不上 → 对该绝对路径 `realpath` 一次，再裁剪 / `path.relative`；同一 batch 内对原始 abs 字符串 **缓存** 结果。
- 所有 adapter 热路径与 `analyseByModule` 回调共用同一 normalizer（同一缓存）。
- 单测 + CHANGELOG `[Unreleased]` Fixes 一句。

### 2.2 不做

- 不写死 `/var`→`/private/var` 字符串映射。
- 不改变 ArkAnalyzer Scene 的 `buildSceneConfig(rootDir)` 入参语义（仍可用调用方原始 root；仅相对路径归一只走规范根）。
- 不借此改 ViewTree / NAPI / migrate 语义。

---

## 3. 行为与约束

```text
rootDir ──realpath once──► canonicalRoot
Ark abs path ──► prefix(canonicalRoot)? ──yes──► slice（快路径）
                         └──no──► realpath(abs) → slice/relative + cache
```

- 规范根与快/慢路径结果必须与「双 realpath + relative」在 macOS 临时目录场景下一致（相对路径落入 `scanned`）。
- Windows：大小写不敏感前缀匹配；分隔符 `/` 与 `\` 等价。
- 虚拟路径（如 `@dummyFile`）仍走现有 `resolveArkanalyzerVirtualPath`，不进入本 normalizer。

---

## 4. 验收

- [x] Spec 落地实现于 `arkts.ts`（导出可测的 normalizer 工厂亦可）。
- [x] 单测：未解析根 + realpath 文件 → 正确 rel；darwin 上 `/var` abs 慢路径；重复 normalize 稳定。
- [x] 相关 vitest 通过。
- [x] CHANGELOG `[Unreleased]` / Fixes 用户向说明。

---

## 5. 状态

**已完成**（实现：`createArkRelPathNormalizer` + `ArkTSAdapter` 共用；测试：`test/languages/arkts/arkts-relpath-normalizer.test.ts`）。
