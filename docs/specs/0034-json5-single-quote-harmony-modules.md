# 0034 — build-profile.json5 单引号解析与脏模块映射


| 字段 | 内容 |
| --- | --- |
| 编号 | 0034 |
| 类型 | 缺陷修复 |
| 状态 | 已完成 |
| 日期 | 2026-09-15 |
| 范围 | `parseJson5Minimal`；`listHarmonyProjectModules` / project-map Harmony 发现；脏模块 `resolveDirtyHarmonyModules`；相关单测与 CHANGELOG |
| 关联 | Spec 0025（合成模块 / 增量脏映射）；真实 DevEco `build-profile.json5` 常用单引号与裸 key |


---

## 1. 背景与目标

真实 Harmony 工程的 `build-profile.json5` 常见写法包括：

- 裸 key（`modules:`、`name:`）
- **单引号字符串**（`'entry'`、`'2in1'`、`'phone'`）
- 注释与尾逗号

现有 `parseJson5Minimal` 只剥注释 / 尾逗号后直接 `JSON.parse`，**不认单引号**。解析失败时 `listHarmonyProjectModules` 返回 `[]`，增量路径 `resolveDirtyHarmonyModules` 永久落到：

```text
{ mode: 'full', reason: 'no PROJECT modules in build-profile.json5' }
```

无法按模块脏增量，只能全量 ArkTS batch。`project-map` 侧另有一套「只补裸 key、仍不认单引号」的 loose 解析，同一份 profile 两边行为也不一致。

**目标：**

1. 加强 `parseJson5Minimal`：在现有注释 / 尾逗号处理之上，支持 **裸 key** 与 **单引号字符串**（DevEco 常见子集），再 `JSON.parse`。
2. `listHarmonyProjectModules` 与 project-map Harmony 发现共用该解析，去掉重复的 loose 副本。
3. 含 `'2in1'` 等单引号的 `build-profile.json5` 能列出 modules，脏文件映射走 `mode: 'modules'`，不再误判 full。

---

## 2. 范围

### 2.1 做

- `src/extraction/languages/arkts.ts`：`parseJson5Minimal` 规范化（裸 key → 双引号 key；`'…'` → `"…"`，串内 `"` 转义）；保持对已合法 JSON / 仅注释尾逗号输入的兼容。
- `listHarmonyProjectModules` 继续调用加强后的解析器（无需二次路径）。
- `src/project-map/index.ts`：Harmony 模块发现改为直接 `listHarmonyProjectModules`，删除只补裸 key 的重复 loose 解析。
- 单测：`parseJson5Minimal`（单引号、`'2in1'`、裸 key）；`listHarmonyProjectModules` + `resolveDirtyHarmonyModules` 对真实风格 profile。
- `CHANGELOG.md` `[Unreleased]` Fixes 用户向说明。

### 2.2 不做

- 不引入完整 JSON5 依赖或完整 JSON5 语法（hex、多行字符串、尾随标识符等）。
- 不改 MCP 工具协议、schema、产品四态。
- 不改 `homegraph_project` 输出形态（另案）。
- 不在本 Spec 扩大「脏态 / stale」产品态设计。

---

## 3. 行为与约束

| 输入 | 期望 |
| --- | --- |
| 合法 JSON / 现有「注释 + 尾逗号」样例 | 行为与修复前一致 |
| 裸 key + 双引号值 | 可解析 |
| 裸 key + 单引号值（含 `'2in1'`） | 可解析；`listHarmonyProjectModules` 非空 |
| 上述 profile 下脏 `.ets` | `resolveDirtyHarmonyModules` → `mode: 'modules'`（非 `no PROJECT modules…`） |
| 真正损坏的 profile | 仍返回 `[]` / full 回退（不抛到调用方） |

**约束：** 解析失败仍静默空列表（与现网一致）；单引号转换须在双引号字符串外进行，避免误改已引用内容。

---

## 4. 验收标准

- [x] `parseJson5Minimal` 可解析含裸 key + `'2in1'` 的最小 build-profile 片段。
- [x] `listHarmonyProjectModules` 对同类夹具返回非空 modules。
- [x] `resolveDirtyHarmonyModules` 对同类夹具下脏 `.ets` 返回 `mode: 'modules'`，reason 不再是 `no PROJECT modules in build-profile.json5`。
- [x] project-map Harmony 发现与 `listHarmonyProjectModules` 同源；无独立 loose 解析副本。
- [x] 相关 vitest 通过；`CHANGELOG [Unreleased]` 已写（commit 待用户要求；footer：`Spec: docs/specs/0034-json5-single-quote-harmony-modules.md`）。

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 朴素注释剥离仍可能误伤字符串内 `//`（既有局限） | 不扩大范围；单测锁定 DevEco 常见子集 |
| 单引号转换边界（转义） | 扫描式转换 + 单测覆盖 `'` / `"` / `\'` |

回滚：恢复旧 `parseJson5Minimal` 与 project-map loose 副本（git revert）。

---

## 6. 非目标

- 完整 JSON5 合规。
- 产品索引态增加 `stale`。
- `homegraph_project` 两级详情改版。
