# 054：一次取齐页面、类型和行为证据

基线为 053 develop `b9e65d3`，在独立目录合并 main `aff8236` 后实现。codingeval 与原 053 均未修改；没有启动真实模型推理或发布包。

这轮主要改的是检索、MCP 返回组织和证据检查代码。模型继续使用现有 `homegraph_explore`，没有新增必须调用的工具，也没有增加模型请求。

## 补强了什么

| 修改位置 | 新行为 | 对应的使用场景 |
|---|---|---|
| `src/graph/evidence-paths.ts`、`src/mcp/tools.ts` | 结构路径接纳有出处的 ArkUI 子组件、Builder、命名导航和 route_map 关系；把同一声明的 struct/component 身份归一化，并保留 build 的声明归属 | 从页面追到实际显示标签的子组件，减少凭文件名判断修改范围 |
| `src/mcp/implementation-context.ts` | 从已验证声明收集实际使用的 import、类型关系和渲染关系；精确相对路径与导出入口可补足缺失的类型导入边；展示共享组件的直接使用方，不继续遍历其无关兄弟组件 | 页面取到后，附上回调涉及的类型和复用组件 |
| `src/mcp/arkts-evidence-packs.ts` | 导入声明、类型、导出入口成组预算；根据当前 oh-package 的 file: 依赖找到包的 main/Index，再检查实际导出；附上相关模块配置与 build-profile 快照 | 区分“仓库里有这个类型”和“当前模块从哪里导入它” |
| `src/db/queries.ts`、上下文收集与渲染 | 对已使用的 SDK import 精确读取已挂载 API 数据库的模块，补入相关方法和直接参数类型字段；显示数据库版本 | 少分几次查询方法签名、参数对象和字段 |
| `src/mcp/request-evidence.ts` | 完整返回源码中的控件摘要：图标/文案、直接 enabled 表达式、onClick、局部状态写入；不依赖模型先给控件起对名字 | 即使需求里的“撤销”未能直接映射到图标资源，也能显示该 Image 有没有直接启用条件 |
| `src/mcp/evidence-audit.ts` | 可选记录源码包正文、输入、源码范围和缺口，便于下一轮区分工具信息不足与模型误用 | 补足之前只有模型描述、没有原始源码包正文的分析缺口 |
| `src/mcp/query-cache.ts`、`tools.ts` | 开关进入缓存标识；含实现上下文的结果重新生成并核对源码与配置；未新增上下文的查询仍可复用原有合格缓存 | 文件、模块配置改变后不沿用旧依赖结论 |

## 模型实际能看到什么

假设一个商品页面通过 `ProductBadge` 展示商品，使用 `Product` 类型，并根据 ready 状态显示不同图标。一次正常 explore 可以同时包含：

- 页面到 ProductBadge 的静态关系、完整声明和关系发生的位置。
- 页面中的 import、Product 的字段，以及经过的实际导出入口。
- 当前模块 oh-package 的依赖声明；有该文件时附 build-profile 版本配置。
- 图标代码里的资源名、onClick 和 enabled 情况，以及当前声明中可观察到的状态写入。
- 尚未提供、失效、无法解析或因预算省略的证据。

源码、配置和 SDK 签名明确区分。源码及相关组要么完整进入预算，要么作为缺口返回；SDK 签名不会记为“本地文件已经读过”。控件解析在一次返回内缓存，避免预算选择时反复解析相同声明。

## 能力边界

- 页面关系是有界静态连接。它不能证明某个分支必然执行、页面一定可达，也不能列尽所有共享使用方。
- 导入边缺失时，只解析精确相对路径或当前包声明的项目内 file: 依赖；不按全仓同名匹配。目录有多种可能入口、导出冲突、循环超过范围、源码指纹变化时保留缺口。无显式导出证据的相对模块不直接确认公开类型。
- SDK 仅使用已经挂载的 API 数据库，按精确模块名查找。未建立模块对应关系的 Kit、缺失的 Native 头文件、大型或含歧义的模块仍需补查。没有新增在线文档抓取或自动 SDK 安装。
- 定位阶段仍优先本地代码；已绑定本地 import 的 SDK 依赖可随包显示。将图源设为 `project` 或 `none` 时不查询 SDK 数据库。数据库版本与当前工程/设备版本是否兼容仍需检查。
- SDK 类型展开有范围限制，继承/间接类型、创建顺序、权限、所有运行约束不一定齐全。较长文档注释会明确标为摘录。不能把这份签名信息当成全部 API 契约。
- 图标资源名原样显示，不把英文资源名翻译成需求目标。父级 enabled、自定义修饰器、复杂模板、异步顺序和跨对象数据流仍未验证；局部状态赋值也不是行为正确性的证明。
- 外部检查器的模块解析、文档截断和设备环境不在本轮修改范围。

## 开关和记录

默认开启：

```text
HOMEGRAPH_ARKTS_IMPLEMENTATION_CONTEXT=1
HOMEGRAPH_ARKTS_CONTROL_EVIDENCE=1
```

两项均设为 `0` 可以在合并 main 的同一基线上关闭本批上下文/控件改进，便于消融比较。原有 `HOMEGRAPH_ARKTS_EVIDENCE_PACKS`、`HOMEGRAPH_ACCURACY_*` 和 Headroom 配置继续有效。

可选源码包记录，默认关闭：

```text
HOMEGRAPH_ARKTS_EVIDENCE_LOG=1
```

记录写入被检索项目的 `.homegraph/evidence-packs.jsonl`，约 16 MiB 上限，达到上限停止写入，MCP 元数据报告 `limit`；移动旧日志后可继续记录。日志不是答案缓存。该开关启用时 explore 不使用结果缓存，以保留实际生成记录。

记录阶段为 `arkts_pack_before_host_wrapping`：包含源码包输入和完整包结果，不代表所有 MCP 工具，也不代表宿主/Headroom 最终收到的完整消息。外部包装、压缩和实际模型消费情况仍须结合宿主已有记录。日志失败不会阻断查询。

## 验证与下一轮实验

验证摘要见 [054-REPORT](../validation/054-REPORT.md)，本地原始日志保存在 `validation/054/`。

```bash
npm ci
npm run build
node scripts/implementation-context-smoke.cjs
node scripts/accuracy-contract-smoke.cjs validation/054/accuracy-smoke.json
```

合成工程通过真实 ArkAnalyzer/SQLite 和正常 MCP 边界，检查类型、模块、渲染路径、图标与记录。既有准确率 smoke 检查变更后的证据失效；Headroom 0.37.0 检查整个 explore 正文逐字节保留。以上不是 codingeval 真实推理结果。

main 此次还更新了 ArkAnalyzer、资源配置、页面关系和 daemon 行为，因此后续 A/B 应比较同一份合并代码下本批开关开启/关闭，并保持模型、Headroom、工具预算、索引计时及日志设置相同。优先比较配对准确率、模型轮次、工具调用及返工，实际收益尚未确认。
