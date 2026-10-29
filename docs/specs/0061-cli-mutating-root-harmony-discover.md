# 0061 — CLI init/index/sync：显式 path 字面量，无参上溯鸿蒙根

| 字段 | 内容 |
| --- | --- |
| 编号 | 0061 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-10-29 |
| 范围 | `init` / `index` / `sync` 的工程根解析；`src/directory.ts` 可测解析函数；相关单测与 CHANGELOG |
| 非本 Spec | MCP `--path` 地板（Spec 0028）；`status`/`query` 等读命令对祖先 `.homegraph` 的上溯；`index` 自动 init；非鸿蒙工程的多 marker 发现 |

---

## 1. 背景与目标

`homegraph index`（及共用的 `resolveProjectPath`）在目标目录**尚未**初始化时，会沿祖先链寻找任意已有 `.homegraph/homegraph.db` 并以其为根。在子仓（如 `scene_board_ext`）执行 `index` 时，若父仓（评测 harness / monorepo）已有索引，会静默去索引整棵父树：文件数暴涨、走全量 ArkAnalyzer Scene、OOM。

MCP 侧 Spec 0028 已禁止宿主声明根被祖先劫持；CLI 写操作仍沿用「便利上溯 `.homegraph`」。

**目标：**

1. **传了目录参数** → 只在该目录操作，**绝不**上溯。  
2. **未传参数** → 从 cwd 向上找最近的 `build-profile.json5` 作为鸿蒙工程根；找不到则用 cwd。  
3. `init` / `index` / `sync` **同一套**解析；禁止再因祖先 `.homegraph` 改根。

---

## 2. 范围

### 2.1 做

- 导出可单测的解析：`findNearestHarmonyProjectRoot`、`resolveCliMutatingProjectRoot`（建议落在 `src/directory.ts`）。
- `homegraph init|index|sync [path]` 均调用上述解析，替换写路径上对「祖先 `.homegraph`」的依赖。
- 单测覆盖：显式 path、无参上溯、无 profile 回退 cwd、父仓 `.homegraph` 不得劫持子鸿蒙根、显式传子目录不升根等。
- CHANGELOG `[Unreleased]` 用户向说明。

### 2.2 不做

- 不改 MCP `findNearestHomeGraphRoot` / Spec 0028 地板语义。  
- 不改 `status` / `query` / `context` 等读命令（可继续为查询便利上溯已有索引）。  
- 不在本 Spec 让 `index` 在未 init 时自动 `init`。  
- 不把 `oh-package.json5` / `package.json` 纳入无参发现（仅 `build-profile.json5`）。

---

## 3. 行为

| 场景 | 结果 |
| --- | --- |
| `homegraph index D:\proj\app`（或相对 path） | 工程根 = `resolve(path)`，即使用户 cwd 在别处、父目录有 `.homegraph` 或 `build-profile.json5` |
| `homegraph index`（无参），cwd 为鸿蒙根 | 工程根 = cwd |
| `homegraph index`，cwd 为鸿蒙根下子目录 | 工程根 = 最近祖先（或自身）含 `build-profile.json5` 的目录 |
| `homegraph index`，祖先链无 `build-profile.json5` | 工程根 = cwd（即使更上层有无关 `.homegraph`） |
| `homegraph init` / `sync` | 与 `index` 相同解析规则 |
| 显式 path 指向鸿蒙子目录 | **不**升到 `build-profile` 根（字面量优先） |

---

## 4. 验收

- [x] Spec 落盘；`resolveCliMutatingProjectRoot` / `findNearestHarmonyProjectRoot` 有单元测试且覆盖上表场景
- [x] `init` / `index` / `sync` 使用新解析；写操作不再因祖先 `.homegraph` 改根
- [x] 相关 vitest 通过
- [x] CHANGELOG `[Unreleased]` 有条目
