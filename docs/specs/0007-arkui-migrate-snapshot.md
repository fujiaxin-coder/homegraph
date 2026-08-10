# 0007 — ArkUI 迁移语义快照（一次接口给 AI）


| 字段 | 内容 |
| --- | --- |
| 编号 | 0007 |
| 类型 | 需求 / 设计 |
| 状态 | 已完成 |
| 日期 | 2026-08-10 |
| 范围 | ArkTS 索引期补充迁移相关语义；MCP/库提供按 scope 的一次性快照查询；测试与文档 |
| 关联 | 现有 ViewTree / 状态装饰器抽取（`src/extraction/languages/arkts.ts`）；对照仓 `migration-graph`（`MigrationGraphBuilder`）；动态分发原则见 `docs/design/dynamic-dispatch-coverage-playbook.md`；MCP 工具形态约定见 `AGENTS.md`（success-shaped、不塞进 explore） |


---

## 1. 背景与目标

HomeGraph 已对 ArkUI 做**符号级定位**：`@Component`、方法/字段、字段上的状态装饰器、ViewTree 父子与 `@Prop`/`@Link` 传值、事件回调、方法级 RTA。对 AI「定位到组件/字段」已够用，**不需要**语句级 CFG 节点。

但迁移判断（对照 `migration-graph`）还需要一层**组件/状态语义**，而不是让 agent 用 `homegraph_explore` / `node` 自己拼：

| 语义层 | 为何需要 | HomeGraph 现状（约） |
| --- | --- | --- |
| 传值形态 | `$$`/`$x` vs `this.x` vs literal/callback 决定是否强制迁 | ViewTree 有 Prop/Link 边，**缺** `passageType` |
| key 通道 | `@Provide`/`@Consume`、`@StorageLink` + `AppStorage.*` 聚合 | 装饰器名或有；**缺** key / channel 边 |
| Observed | `@Observed`/`@ObservedV2` + `@Track`/`@Trace` 与 State 字段引用 | **基本未作为迁移视图暴露** |

**目标：**

1. 索引期把上述语义写成 **node metadata + 少量专用边/属性**（仍落在 HomeGraph SQLite，不另起一套 MigrationGraph DB）。
2. 查询期提供 **一个** MCP 工具（及对等库 API）：按 scope（组件名 / 文件 / 目录）一次返回结构化迁移快照 JSON。
3. Agent **不必**用 explore 拼迁移决策所需事实；`explore`/`node` 继续只做通用定位与调用流。

**成功标准：** 对纳入范围内的典型组件，一次调用即可回答「有哪些状态字段、装饰器与 key、父子传值形态、Observed 引用」；无语句图；未命中时 success-shaped guidance，不 `isError`。

---

## 2. 范围

### 2.1 纳入（做就做全）

- **索引期增强**（ArkTS / ViewTree 路径，复用 arkanalyzer，可参考 `migration-graph` 的 builder 语义，**不**依赖其运行时包）：
  - 组件：`@Component` / `@ComponentV2` / `@CustomDialog`、V1/V2、是否 `@Entry`/`@Reusable`（能静态拿到则写）
  - 状态字段：主装饰器 + 辅助装饰器（`@Watch`/`@Monitor`/`@Once`/`@Require` 等）+ 装饰器字面量 arg（如 `@Provide('theme')`）
  - DataPassage：父子状态传值的 `passageType`、`valueType`、`forcesMigration`（规则见 §3.2）
  - KeyChannel / StorageKey：Provide·Consume / Storage* / LocalStorage* 等同 key 聚合；能静态解析的 `AppStorage`/`LocalStorage` 等 API 字面量 key
  - Observed：`@Observed`/`@ObservedV2` 类及其 `@Track`/`@Trace` 属性；State 字段 → Observed 类的引用边
- **查询期**：
  - MCP 工具（建议名 `homegraph_arkui_migrate`）+ `HomeGraph` 库方法（如 `getArkUIMigrateSnapshot(scope)`）
  - 入参：`scope`（组件名 / 相对路径文件 / 目录前缀）；可选 `projectPath`
  - 出参：固定 schema 的 JSON（§3.3），面向 AI / 下游迁移逻辑，**不是** markdown explore 报告
  - 目录 scope：设组件数上限（实现定，工具描述写明），超限时 `notes` 提示收窄，仍 success
- 单测 fixture（合成 ets）+ CHANGELOG `[Unreleased]` 用户向一句；`server-instructions.ts` / local-dev-guide 必要指引

### 2.2 不纳入（不做）

- **不做**语句级 CFG / 基本块 / 语句节点。
- **不做** `hasDeepWrite` / `deepPaths`（AI 可读字段相关方法自行判断）。
- **不做** MixingViolation、specialCalls（`animateTo` 等）、自动 Rewrite / 迁移补丁。
- **不**把 MigrationGraph 整图 dump 进 MCP；**不**要求字节级复刻其全部边。
- **不**把该快照塞进 `homegraph_explore`。
- **不**改变通用 NodeKind/EdgeKind 枚举去「冒充」MigrationGraph；迁移语义走 **metadata / 专用 via / 快照组装层**。

---

## 3. 行为与约束

### 3.1 架构

```text
ArkTS 源码 ──► 现有符号 + ViewTree 抽取
                 │
                 ├─► 迁移语义增强（passageType / key / Observed / …）
                 │         ↓
                 │    SQLite nodes/edges (+ metadata)
                 │
                 └─► getArkUIMigrateSnapshot(scope)
                           ↓
                 homegraph_arkui_migrate（MCP）→ 一次 JSON
```

原则：**精确输出需要精确输入**——输入是 **scope**（组件/文件/目录），不是自然语言；输出一次给够，避免 agent 多跳拼装。

### 3.2 传值形态（`passageType`）

对齐 `migration-graph` 的 `PassageType`（实现可用同名字符串）：

| 值 | 含义（摘要） |
| --- | --- |
| `two_way_binding` | `$$` / `!!` / `$var` |
| `state_variable_ref` | `this.x` |
| `new_instance` | `new Foo(...)` |
| `callback` | 回调 / 方法引用 |
| `literal` | 字面量 |
| `function_call` | 一般调用 |
| `expression` | 其它表达式 |

派生字段（必算，单测钉死）：

- `valueType`: `simple` \| `builtin` \| `class` \| `unknown`
- `forcesMigration`：`two_way_binding` → true；`state_variable_ref` 且 `builtin`/`class` → true；其余 → false（与 migration-graph 一致）

边：可继续用现有 `references` + `metadata.synthesizedBy: 'viewtree'`（或 `'arkui-migrate'`），在 metadata 上挂上述字段；**不必**新增 EdgeKind。

### 3.3 快照 schema（查询出参）

一次调用返回（字段名可微调，语义须稳定；`schemaVersion: 1`）：

```ts
interface ArkUIMigrateSnapshot {
  schemaVersion: 1;
  scope: { query: string; resolved: 'component' | 'file' | 'directory' | 'none' };
  components: Array<{
    id: string;           // HomeGraph node id
    name: string;
    file: string;
    line: number;
    version?: 'V1' | 'V2';
    containerDecorator?: string;  // Component / ComponentV2 / CustomDialog
    isEntry?: boolean;
    isReusable?: boolean;
    stateVars: Array<{
      id: string;
      name: string;
      type?: string;
      decorator: string;          // State / Prop / Link / Local / Param / …
      auxDecorators?: Array<{ kind: string; arg?: string }>;
      decoratorArg?: string;      // Provide('theme') → theme
    }>;
  }>;
  dataPassages: Array<{
    from: string;                 // parent stateVar 或 component id
    to: string;                   // child stateVar id
    passageType: string;
    valueType: string;
    forcesMigration: boolean;
    parentExpression?: string;    // 短文本，非语句 IR
    file?: string;
    line?: number;
  }>;
  keyChannels: Array<{
    key: string;
    channel: string;              // ProvideConsume / AppStorage / LocalStorage / …
    participants: string[];       // stateVar / component ids
  }>;
  observedClasses: Array<{
    id: string;
    name: string;
    observationDecorator: 'Observed' | 'ObservedV2';
    properties: Array<{ name: string; type?: string; hasTrace?: boolean; traceDecorator?: string }>;
    referencedBy: string[];       // stateVar ids
  }>;
  notes?: string[];               // 超限、覆盖说明等
}
```

约束：

- **体积**：按 scope 裁剪；目录超上限时 `notes` 提示收窄，仍 success。
- **定位**：实体带 `file`+`line`（或 HomeGraph id）；**不**附整文件源码（需要体再 `homegraph_node`）。
- **未索引 / 非 ArkTS scope**：success-shaped 或空快照 + `notes`，**禁止** `isError: true`。

### 3.4 MCP 工具约定

- 名称建议：`homegraph_arkui_migrate`（以实现与 `tools.ts` 注册为准）。
- 描述：明确「ArkUI 迁移/状态语义快照；一次返回；不要用 explore 拼」；**不要**写「再用 Read」。
- `server-instructions.ts`：迁移决策 PRIMARY 点名该工具；explore 仍为通用流/定位 PRIMARY。
- 工具始终出现在 `tools/list`；无数据时 success guidance。

### 3.5 确定性与精度

- 同一源码多次索引，快照语义字段稳定；不引入 LLM。
- **精度优于召回**：无法判定的 `passageType` 标 `expression` 或不发射该边；不确定的 key **不**假连。

---

## 4. 验收标准

- [x] 索引后字段节点可见状态装饰器（含常见 V1/V2）；Provide/Storage 等带字面量 arg 时快照可见 `decoratorArg` / key
- [x] DataPassage 带 `passageType` + `valueType` + `forcesMigration`；fixture 至少覆盖 `two_way_binding`、`state_variable_ref`、`literal`、`callback`（`state_variable_ref` / Prop·Link 已测；其余分类器单测覆盖）
- [x] 同 key 的 Provide/Consume（或 StorageLink 对）及可解析的 AppStorage 等字面量 key 在 `keyChannels` 中聚合
- [x] `@Observed`/`@ObservedV2` 进入 `observedClasses`；能静态证明时 `referencedBy` 非空
- [x] `homegraph_arkui_migrate` 对组件 / 文件 / 目录 scope **一次**返回符合 §3.3 的 JSON；无语句节点；无 `hasDeepWrite`
- [x] 未索引 / 空结果为 success-shaped，非 `isError`
- [x] **未**并入 explore Flow；`server-instructions` / 工具描述指向专用工具
- [x] CHANGELOG `[Unreleased]` 用户向说明；测试落在 `test/languages/arkts/`（或等价）

---

## 5. 风险

| 风险 | 应对 |
| --- | --- |
| 与 migration-graph 语义漂移 | 以本 Spec schema 为契约；PassageType / forcesMigration 规则写单测，不依赖其包 |
| 目录 scope 过大 | 上限 + `notes` 收窄 |
| agent 仍去 explore 拼 | 工具描述 + server-instructions；输出一次给够 |
| 半桥诱导 Read | 不确定则省略或 `notes`；禁止「请用 Read」 |

**一句话：** 定位用现有 HomeGraph；迁移用「索引语义 + 一个 scope 快照」；别补语句图，别让模型用 explore 拼。

---

## 6. 参考

- 对照实现：`D:\code\migration-graph\src\builder\MigrationGraphBuilder.ts` 及 `graph/types.ts`、`graph/nodes.ts`、`graph/edges.ts`
- HomeGraph 现网：`src/extraction/languages/arkts.ts`（ViewTree、`stateDecoratorKinds`）、`test/languages/arkts/arkts-viewtree*.ts`
- Agent 工具原则：`AGENTS.md`（adapt tool to agent；explore 不承载整页画像；success-shaped errors）
