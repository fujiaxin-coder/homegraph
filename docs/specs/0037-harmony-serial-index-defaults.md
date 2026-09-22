# 0037 — 鸿蒙 modular 工程默认串行 index（方案 D）


| 字段 | 内容 |
| --- | --- |
| 编号 | 0037 |
| 类型 | 性能 / 产品行为 |
| 状态 | 已完成 |
| 日期 | 2026-09-18 |
| 范围 | Harmony `build-profile.json5` 工程的 parse worker 数、resolve 并行池、synthesis 并发默认值；env 覆盖；单测与 CHANGELOG |
| 关联 | Spec 0036（SceneBoard 劣化修复）；scene_board_ext 实测：默认并行 ~433s/~8.5GB PEAK，方案 D ~458s/~3.8GB |


---

## 1. 背景与目标

鸿蒙多模块仓墙钟几乎都在 ArkAnalyzer `analyseByModule`（原生、模块间串行）。Parsing / resolve worker 池对总时间帮助很小，却在 AA `releaseScene` 后与主进程残留 RSS 叠峰（SceneBoard：linking 冲到 ~8.5GB）。

实测（Spec 0036 之后、`CODEGRAPH_PARSE_WORKERS=1` + `HOMEGRAPH_SYNTH_CONCURRENCY=1` + `HOMEGRAPH_NO_PARALLEL_RESOLVE=1`）：

| 配置 | Wall | PEAK PRIV |
| --- | --- | --- |
| 默认并行 | ~433s | ~8.5GB |
| 方案 D 全串行 | ~458s（+~6%） | ~3.8GB |

**目标：** 检测到鸿蒙 modular 工程（根目录存在 `build-profile.json5`）时，**默认**采用方案 D，把峰值压到约 4GB 量级，墙钟仍 ≤10min 量级；小仓 / 非鸿蒙行为不变。不引入「文件数 ≥5000」阈值（规则更简单）。

---

## 2. 范围

### 2.1 做

- 导出 `preferHarmonySerialIndexing(rootDir)`：
  - 默认：存在 `build-profile.json5` → `true`
  - `HOMEGRAPH_HARMONY_SERIAL=0`/`false` → 关闭自动串行（恢复并行默认）
  - `HOMEGRAPH_HARMONY_SERIAL=1`/`true` → 强制串行（即使无 profile）
- `ExtractionOrchestrator`：自动串行且未设置 `CODEGRAPH_PARSE_WORKERS` 时，parse pool size = **1**
- `HomeGraph.resolveReferencesBatched`：自动串行时**不**传入 resolver `parallel` 选项（不启 `ResolverPool`；synthesis 随之在主线程、concurrency 自然为 1）
- 显式 env 仍优先：已设 `CODEGRAPH_PARSE_WORKERS` 时不改 pool size；`HOMEGRAPH_HARMONY_SERIAL=0` 时仍可走并行池
- 单测覆盖 prefer 判定；CHANGELOG `[Unreleased]` Improvements

### 2.2 不做

- 不默认开启 `HOMEGRAPH_ARKTS_ISOLATED`
- 不按扫描文件数分档
- 不改 MCP 协议 / 产品索引态文案（可选 stderr 一行诊断即可）

---

## 3. 行为与约束

| 工程 | 默认 |
| --- | --- |
| 有根 `build-profile.json5` | parse workers=1；无 resolve 并行池 |
| 无 profile（普通 TS 等） | 保持现有并行启发式 |
| `HOMEGRAPH_HARMONY_SERIAL=0` | 即使有 profile 也并行 |
| `CODEGRAPH_PARSE_WORKERS=N` 已设 | 尊重 N（自动串行不覆盖） |

**约束：** 串行路径不得跳过 resolve/synthesis 逻辑，只改变并发；索引语义与并行路径一致（允许边写入顺序等非语义差异）。

---

## 4. 验收标准

- [x] `preferHarmonySerialIndexing`：有/无 `build-profile.json5`、`HOMEGRAPH_HARMONY_SERIAL` 0/1 行为符合上表
- [x] 有 profile 且未设 `CODEGRAPH_PARSE_WORKERS` 时，index 路径使用 pool size 1（单测或可观测默认函数）
- [x] 有 profile 时 `resolveReferencesBatched` 不向 `resolveAndPersistBatched` 传入 parallel 池配置
- [x] CHANGELOG Unreleased 用户向说明；commit footer：`Spec: docs/specs/0037-harmony-serial-index-defaults.md`

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 极小鸿蒙仓略慢 | 绝对时间短；可用 `HOMEGRAPH_HARMONY_SERIAL=0` |
| 误伤「带 build-profile 的非鸿蒙」 | 罕见；同样可用 env 关闭 |

回滚：revert 本 Spec commit，或默认 `HOMEGRAPH_HARMONY_SERIAL=0`。

---

## 6. 非目标

- AA 子进程隔离默认化
- extract / resolve 分进程重启
