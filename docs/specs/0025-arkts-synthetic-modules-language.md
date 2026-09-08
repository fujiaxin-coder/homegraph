# 0025 — Harmony 模块外 Ark 源伪 PROJECT 模块与真实 language 标签


| 字段 | 内容 |
| --- | --- |
| 编号 | 0025 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-08 |
| 范围 | 鸿蒙 `analyseByModule` 伪 PROJECT；AA 进图 `language` 按后缀；脏模块映射；单测与 CHANGELOG |
| 关联 | [0011](./0011-arkts-relpath-normalizer.md)；ohrouter 类仓（`HMRouterPlugin` 在 `build-profile` 外） |


---

## 1. 背景与目标

鸿蒙多模块工程走 `Scene.analyseByModule` 时，只加载 `build-profile.json5` 的 PROJECT `srcPath`。同仓但不在模块内的 AA 可解析源（典型：`HMRouterPlugin/**/*.ts`）进不了 Scene。batch 提交后编排又对全部 `.ts` 跳过 tree-sitter，造成 **AA 与 tree-sitter 双漏**。另：适配器把 AA 索引文件一律标成 `language: arkts`，按 `typescript` 统计/筛选会误判。

**目标：**

1. **伪模块**：模块外 AA 源在依赖图冻结前注册为 synthetic PROJECT，仍走同一条 `analyseByModule`（不回退 tree-sitter）。  
2. **真实 language**：AA 进图按后缀写 `files`/`nodes.language`（`.ets`→`arkts`，`.ts`/`.d.ts`→`typescript`，`.js`→`javascript`）。  
3. **增量**：脏文件可映射到伪模块 `srcPath`，避免一律 full rebuild。

---

## 2. 范围

### 2.1 做（本仓 HomeGraph）

- 从 batch 扫描集中找出不在任何 build-profile `srcPath` 下的 AA 源（`.ets` / `.ts` / `.d.ts`）。  
- 按最近 `package.json` / `oh-package.json5`（否则首段目录）聚类；**禁止**把工程根注册成模块。  
- `prepareModules` 之后、`analyzeModuleDependencies` 之前 `registerModule`（名如 `synthetic:<basename>`）；无 oh-package 时依赖边为空（预期）。  
- `resolveDirtyHarmonyModules`：伪模块根可进 `mode: modules`。  
- `languageForArkAnalyzerPath`：persist / file 节点 / 符号节点用真实 language；`@dummyFile.ets` 仍为 `arkts`。  
- 单测 `arkts-synthetic-modules.test.ts`；CHANGELOG `[Unreleased]` 用户向说明。

### 2.2 不做

- 非鸿蒙仓默认改走 AA / 关掉 tree-sitter TS。  
- 鸿蒙模块内 `.js` 进 AA（可后续扩 `supportFileExts`）。  
- 修复 `ClassCategory.OBJECT` / `<Object$anon@N>` 假 class（另题）。  
- 为伪模块伪造 oh-package 或解析 npm 依赖边。  
- 旧库自动迁移（升级后需 re-index）。

---

## 3. 行为与约束

| 场景 | 行为 |
| --- | --- |
| 孤儿目录含 `package.json`（如 `HMRouterPlugin`） | 注册 `synthetic:<basename>` PROJECT；BODIES 回调并 persist |
| 仅仓根零散 `.ts`（如 `hvigorfile.ts`） | 不注册根模块；AA ignore 的仍忽略 |
| 伪模块无 oh-package | 无模块依赖边；npm 依赖 unresolved（可接受） |
| `.ets` / `.ts` 经 AA 进图 | `files`/`nodes.language` 分别为 `arkts` / `typescript` |
| 脏文件落在伪模块树下 | `resolveDirtyHarmonyModules` → `modules` + 该 `srcPath` |

**约束：** 伪模块与 HAP 之间几乎无跨模块 RTA 边；纯 Node API 类型推断偏弱——仍优于双漏。抽取器仍为 AA，仅标签与模块集合变化。

---

## 4. 验收

- [x] Spec 落盘；实现与本文一致（代码已先行，按 DEVELOPMENT §1.4.1 收尾）。  
- [x] 模块外 AA 源可注册为 synthetic PROJECT 并进入 `analyseByModule`。  
- [x] ohrouter：`HMRouterPlugin` 下 `.ts` 进图；日志可见 `synthetic:HMRouterPlugin`。  
- [x] `.ets`→`arkts`、插件 `.ts`→`typescript`（`files`/`nodes`）。  
- [x] 脏映射可指向伪模块 `srcPath`（单测覆盖）。  
- [x] `test/languages/arkts/arkts-synthetic-modules.test.ts` 通过。  
- [x] CHANGELOG `[Unreleased]` 已写；提交 footer 关联本 Spec。

---

## 5. 状态

**已完成** — `prepareArkModulesWithSynthetics` + `languageForArkAnalyzerPath` + 脏映射扩展；ohrouter 实仓验证；测试见 `test/languages/arkts/arkts-synthetic-modules.test.ts`。
