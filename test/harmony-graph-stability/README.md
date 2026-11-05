# harmony-graph-stability

鸿蒙 ArkTS 图形状稳定性套件：以 **ArkAnalyzer（AA）全量 Scene** 为数据源，经人工审核固化为基线合同（contract），再由 Vitest 断言 HomeGraph 索引结果是否忠实落库。

本套件回答的问题不是「源码里肉眼能数出多少符号」，而是：

> 在固定 fixture、固定 `arkanalyzer` 版本下，AA 给出的 IR 是什么；HomeGraph 是否把约定范围内的 IR 稳定地持久化进图。

---

## 1. 目标与定位

| 项 | 说明 |
| --- | --- |
| 目的 | 锁定小型多模块鸿蒙工程上的图指纹，防止提取 / 适配 / ViewTree 合成等回归默默改变图形状 |
| 真值来源 | AA `Scene`（全量构建），**不是** HomeGraph 自索引结果，也不是手写「理想源码 λ」 |
| 比较对象 | 基线合同 `tests/contract.ts` ↔ HomeGraph 对 `project/` 的索引产物 |
| 非目标 | 不替代 Spec 0062–0064 这类语义回归（它们用独立小 fixture）；不覆盖超大仓的 `analyseByModule` 内存路径本身 |

大仓生产路径使用 `analyseByModule` 是为了控内存；本 fixture 体量小，采集基线时按 AA 单元测试惯例走 **全量** `buildSceneFromProjectDir` + `inferTypes`，避免模块化加载与全量 Scene 在 `%AM` 命名等细节上的差异被误当成「基线」。

---

## 2. 端到端流程

```
project/  (checked-in 鸿蒙多模块源)
    │
    ▼
aa-scene-inventory.js          # 仅调 AA：全量 Scene → 结构化清单
    │
    ▼
aa-scene-inventory.json        # 落盘；路径一律相对 fixture，便于人工审阅
    │
    ▼
【人工审核】核对 summary / details / reviewFlags
    │  确认无异常归因、无绝对路径、数字与源码直觉一致
    ▼
sync-contract-from-inventory.js
    │
    ▼
tests/contract.ts              # 测例唯一比对基线（CONTRACT）
    │
    ▼
vitest *.test.ts               # HomeGraph.indexAll(project 副本) ↔ CONTRACT
```

要点：

1. **采集与测试分离**：采集脚本只碰 AA；测例只碰 HomeGraph + 已审核合同。
2. **合同不是自动可信**：JSON 落盘后必须人工过一遍，再 sync 进 `contract.ts` 并提交。
3. **禁止软化断言**：基线变更应改合同数字并说明原因，禁止退回 `>= 1` 一类宽松条件。

---

## 3. 如何比较

### 3.1 基线侧（AA → 合同）

- 脚本对 `project/` 执行与 AA 仓库单测相同的构建方式：
  - `new SceneConfig()` → `buildFromProjectDir(project)`  
  - `new Scene()` → `buildSceneFromProjectDir(config)` → `inferTypes()`
- 遍历 `scene.getFiles()` / `getClasses()` / `getMethods(true)` / `getViewTree()` 等 IR，汇总指纹写入 JSON 的 `contract` 段。
- 路径一律为相对 `project/` 的 posix 路径（如 `mod_a/src/main/ets/PageA.ets`），**不得**写入本机绝对路径。

### 3.2 测例侧（HomeGraph → 合同）

- `helpers.indexStabilityProject()` 将 `project/` 拷到临时目录，调用 `HomeGraph.initSync` + `indexAll`。
- 各 `*.test.ts` 从 DB / API 取出节点边，与 `CONTRACT.fingerprints.*`（及将来的 totals）做**精确相等**比较。
- 当前 HomeGraph 对多模块工程仍可能走 `analyseByModule`；因此个别指纹（尤其 `%AM` **全名**）全量 Scene 与模块化路径可能不一致。合同中保留完整 `amKeys` 供 AA 审计；测例对匿名方法先钉死 **数量与涉及文件数**（见 `anonymous-nodes.test.ts` 注释）。ViewTree `via` 分桶、imports、用户继承等以合同精确值为准。

### 3.3 人工审核清单（每次刷新必做）

打开 `aa-scene-inventory.json`，至少核对：

| 检查项 | 期望 |
| --- | --- |
| `meta.arkanalyzer` | 与 `package.json` 依赖一致 |
| `meta` 无绝对路径 | 只有 `fixture: "project/"` 等相对信息 |
| `summary.etsFileNodes` | 与 fixture 中 `.ets` 文件数一致（当前 25 = 5×5） |
| `summary.imports` / `extends` / `implements` | 与源码 import / 用户继承 / 接口实现一致；`extends` 为**用户 IR**（Worker→Base），不含 SDK `CustomComponent` |
| `summary.extendsAllInScene` | 可大于 `extends`（含 Page/Child→CustomComponent），仅作 Scene 对照，不直接进合同 |
| `summary.viewtreeByVia` | 对照 Page/Child 源码：`state-binding`、`child-component`、`onClick` 等；对「源码无 onClick 却出现在 Text 上」等 AA 归因保持知情 |
| `details.anonymousMethods` | 行号齐全；`reviewFlags` 为空或已解释 |
| `details.heritage` / `viewtreeLinks` | 抽查若干条与源码、类名一致 |

审核通过后再执行 sync；未审核的 JSON **不要**当合同提交。

---

## 4. 基线数据包含什么

### 4.1 `aa-scene-inventory.json` 结构

| 段 | 内容 |
| --- | --- |
| `meta` | AA 版本、fixture、构建方式、采集时间 |
| `summary` | 给人看的汇总数字（含 `extendsAllInScene`、`scene.files/classes/methods`、`reviewFlagCount`） |
| `contract` | 拟写入 `CONTRACT.fingerprints` 的字段（测例比对用） |
| `reviewFlags` | 采集期告警（如缺行号、ViewTree 无 root） |
| `details` | 明细：`etsFiles`、`imports[]`、`heritage[]`、`anonymousMethods[]`、`viewtreeLinks[]`、`contains`/`containsHg`、`calls`/`callsProject`、`amByFile` 等 |

### 4.2 `tests/contract.ts`（`CONTRACT`）

| 层级 | 字段 | 含义 | 来源 |
| --- | --- | --- | --- |
| meta | `arkanalyzer` / `fixture` / `filled.*` | 钉版本；标明哪些段已审核生效 | sync 自 inventory |
| scene | `files` / `classes` / `methods` / `*AllInScene` | AA 全量 Scene 规模（含合成 IR） | AA raw |
| fingerprints | `etsFileNodes` / `imports` / `extends` / `implements` / `amKeys*` / `viewtreeByVia` | 稳定指纹（测例精确比对） | AA（heritage 已滤 SDK） |
| expected | `nodesByKind` / `edgesByKind` / `containsTotal` / `callEdgeCount*` | **HG-comparable** 落库期望 | AA 映射后（见下） |
| calls gold | `tests/calls-gold.ts` → `CALLS_MUST` / `CALLS_MUST_NOT` | **源码可证** 边三元组（L1 质量） | 人工维护；**不被** sync 覆盖 |

**`expected` 映射口径（相对 raw AA）：**

| 项 | 规则 |
| --- | --- |
| `nodesByKind` / contains 基线 | 排除 `%AC`；再加 DummyMain `file→class`(+1) 与额外 callable contains（`hgModelOffsets`） |
| `calls` | 全量 RTA(project caller) − 无图节点 SDK（`callsUnresolvedDrop`）；全量见 `callEdgeCountAll` |
| file/class/callable | 工程口径 + DummyMain：`*WithDummyMain` |

`filled.* === false` 或字段为 `null` 时，对应测例应保持 `describe.skip`，禁止用宽松阈值顶替。

---

## 5. 目录与文件职责

```
test/harmony-graph-stability/
├── README.md
├── aa-scene-inventory.js / .json
├── sync-contract-from-inventory.js
├── export-graph.mjs + viewer/
├── project/                          # 多模块 fixture（桶 A–E 锚点）
└── tests/
    ├── contract.ts                   # 形状/规模基线（sync 生成）
    ├── calls-gold.ts                 # 按桶拆分的 callsMust / MustNot
    ├── calls-match.ts                # 边键匹配（file+name，允许 %AM*$name）
    ├── helpers.ts
    ├── buckets/                      # ★ L1 必收场景桶（主入口）
    │   ├── A-cross-module-static.test.ts
    │   ├── B-non-rta-helper.test.ts
    │   ├── C-fanout-must-not.test.ts
    │   ├── D-same-module-clear.test.ts
    │   ├── E-lifecycle-rta.test.ts
    │   └── F-shape-contract.test.ts  # import/heritage/指纹/规模
    ├── hygiene/
    │   └── double-index-stable.test.ts
    └── specs/                        # 语义 Spec，不占用合同 totals
        ├── 0062-ets-typescript-parser-fallback.test.ts
        ├── 0063-resolve-child-kind-fallback.test.ts
        └── 0064-viewtree-am-declaring-file.test.ts
```

| 路径 | 职责 |
| --- | --- |
| `tests/buckets/A–E-*.test.ts` | calls 金标边：must / must-not，禁止 `>= 1` |
| `tests/buckets/G-hg-heuristic.test.ts` | HG 启发式 calls（仅 pin fixture 里真实存在的正确合成边） |
| `tests/buckets/F-shape-contract.test.ts` | import / heritage / viewtree / %AM / 规模指纹 |
| `tests/calls-gold.ts` | 金标边清单（手维；sync 不覆盖） |
| `tests/contract.ts` | AA 形状合同（sync 生成） |
| `tests/specs/0062–0064` | 单点语义回归 |

---

## 6. 如何跑测试

在仓库根目录：

```bash
# 整套稳定性（含 skip 项）
npx vitest run test/harmony-graph-stability --pool=forks

# 单文件
npx vitest run test/harmony-graph-stability/tests/viewtree-edges.test.ts --pool=forks
```

说明：

- ArkTS 索引较重，单测超时上限多为 180s；建议 `--pool=forks`，避免 worker 共享状态。
- 测例会复制 `project/` 到系统临时目录，不在仓库内留下 `.homegraph/`。

---

## 7. 何时刷新基线

出现以下情况之一时，应重新采集并审核，而不是改测例去「迁就」旧数字：

1. **`arkanalyzer` 版本变更**（升级 / 降级 / 换源）。
2. **`project/` 源码或模块布局变更**（增删 `.ets`、改 ViewTree、改继承 / import）。
3. **稳定性测例失败**，且已确认是 AA IR 或预期落库语义变化，而非 HomeGraph 回归缺陷。
4. **采集脚本统计口径变更**（例如 heritage 过滤规则、ViewTree `via` 归因规则调整）。

若失败原因是 HomeGraph 适配器 / 合成逻辑缺陷：应修产品代码，**不要**为了绿测而改低合同。

---

## 8. 如何刷新基线

```bash
# 1. 全量 Scene 采集 → JSON
node test/harmony-graph-stability/aa-scene-inventory.js

# 可选：指定输出路径
node test/harmony-graph-stability/aa-scene-inventory.js --out test/harmony-graph-stability/aa-scene-inventory.json

# 2. 人工审核 aa-scene-inventory.json（见 §3.3）

# 3. 写入合同
node test/harmony-graph-stability/sync-contract-from-inventory.js

# 4. 跑套件确认
npx vitest run test/harmony-graph-stability --pool=forks
```

提交时建议同时包含：`aa-scene-inventory.json`、`tests/contract.ts`，以及如有的脚本 / README / fixture 变更。CHANGELOG 中说明 AA 版本或 fixture 变更原因。

环境变量：若本机配置了 `OHOS_SDK_HOME` 且目录存在，采集脚本会把它加入 `SceneConfig` SDK 列表（与 AA 单测可挂 SDK 的做法一致）；路径仍只相对 fixture 写入 JSON。

---

## 9. 场景桶 ↔ 测例对照

| 桶 | 测什么 | 测例要点 | 金标 |
| --- | --- | --- | --- |
| **A** 跨模块 static | 逐边 must + 跳级 must-not + 端点节点存在 | `A-*.test.ts` | `BUCKET_A_MUST` / `_MUST_NOT` |
| **B** 非 RTA helper | 逐边 must + `hiddenHelper` 入边来源 + 出度上界 | `B-*.test.ts` | `BUCKET_B_MUST` |
| **C** 扇出负例 | 符号存在 + 逐边 must-not + 入边/出度护栏 | `C-*.test.ts` | `BUCKET_C_MUST_NOT` |
| **D** 同模块清晰 | 逐边 must（同模块）+ 灌跨界 must-not + 出度上界 | `D-*.test.ts` | `BUCKET_D_MUST` / `_MUST_NOT` |
| **E** lifecycle RTA | 五模块 lifecycle 逐边 + Page/Child 节点 + 同模块约束 | `E-*.test.ts` | `BUCKET_E_MUST` |
| **F** 形状合同 | fingerprints / edgesByKind / nodesByKind / import 抽查 | `F-*.test.ts` | `CONTRACT.*` |
| **G** HG heuristic | 仅 pin 索引中真实存在的正确合成边（interface-impl / arkui-state） | `G-*.test.ts` | `BUCKET_G_MUST` |

各桶 `beforeAll` 只索引一次（`openStabilityIndex`），`it` 按边/断言展开；禁止 `>= 1` 软过。

| 卫生 | 两次索引一致 | `hygiene/double-index-stable.test.ts` | — |
| Spec | 0062 / 0063 / 0064 | `specs/0062–0064-*.test.ts` | 独立 fixture |

---

## 10. 约定与禁忌

1. **真值在 AA，合同在审核之后**：禁止用「先跑 HomeGraph 再回填合同」代替 AA 采集。
2. **小仓全量 Scene**：基线采集禁止改用 `analyseByModule`（那是大仓内存策略，不是本套件的真值路径）。
3. **无绝对路径**：JSON / 合同中的文件路径必须相对 `project/`。
4. **不软化金样**：数字变了就显式升合同并写清原因。
5. **语义 Spec 与合同分离**：declaring file、kind-scan、WASM preload 等用独立测例，避免污染图规模指纹。
6. **改 fixture 即改基线**：只改 `project/` 而不刷新 inventory/contract，必然导致红测。

---

## 11. L1 calls 金标（`calls-gold.ts`）

边键：`(caller_file, caller_name|start?, callee_file, callee_name|start?, dispatch?)`。
匹配时允许 `%AM*$name` 匿名包装与源码名对齐；**不以** `%AM` id / MethodSignature 字符串做主键。

改调用点：先改对应 `BUCKET_*`，再视情况刷新 inventory/contract。只跑一桶：

```bash
npx vitest run test/harmony-graph-stability/tests/buckets/A-cross-module-static.test.ts --pool=forks
npx vitest run test/harmony-graph-stability/tests/buckets/G-hg-heuristic.test.ts --pool=forks
```

桶 **G** 只断言「本工程索引里已经出现、且源码可证」的 HG 启发式边（如 `interface-impl`、`arkui-state`）；图中不存在的合成边不要写进 must。

## 12. 图可视化（`viewer/`）

```bash
node test/harmony-graph-stability/export-graph.mjs   # → viewer/graph-data.json + graph-data.js
# 可直接双击打开 viewer/index.html（内嵌 graph-data.js，不依赖本地服务器）
# 或：npx --yes serve test/harmony-graph-stability/viewer
```

布局约定：

- **分层框**：模块 → 文件 → 类/结构体/接口；成员落在对应框内（由 `contains` 边推导）。
- **节点去重**：同一 `(file, kind, name, startLine)` 只保留一个；递归调用表现为自环边。
- **形状 / 边色**：见侧栏图例；默认不画 `contains`（已用框表达）。
- **搜索**：内部蓝、直接相邻橙，其余变淡；并自动缩放到命中区域。

## 13. 相关文档

- AA 用法参考：本机 / 上游 `arkanalyzer` 仓库中 `tests/unit/ViewTree.test.ts`、`Anonymous.test.ts` 等（`SceneConfig.buildFromProjectDir` + `buildSceneFromProjectDir` + `inferTypes`）。
- 产品侧适配：`src/extraction/languages/arkts.ts`（Scene → 节点边；生产默认 `analyseByModule`）。
- 语义 Spec：`docs/specs/0062-*.md`、`0063-*.md`、`0064-*.md`。

