# Python 检索调试演示

使用 `scripts/debug_homegraph.py` 驱动真实 HomeGraph MCP 服务，观察问题、Planner、检索结果之间的关系。需要 Python 3.10+、Node.js 22+、Git，以及已安装依赖并构建的 HomeGraph（`npm run build`）。Python 部分仅使用标准库。

## 演示题：ArkTs_Exp_218

给 Vulkan 超分示例增加 Spatial Upscale：菜单顺序为 no → spatial → fsr → temporal，调用 `XEG_SpatialUpscale`，默认锐化参数 0.2，检测设备能力，输入输出为 RGBA8。完整题目及步骤在 [spatial-upscale.json](../scripts/demos/spatial-upscale.json)。

这题横跨 ArkTS UI、NAPI 注册、C++ 渲染，既适合展示检索能力，也能展示新 API 尚未出现在原始代码中的情况。使用仓库 `HarmonyOS_Samples/xengine-samplecode-vulkan-temporal-upscale-demo-cpp`，固定原始提交 `ac62730ec1d150613f93842534a3f4cf4aff7bf1`。定向步骤的路径和符号来自原始源码，未使用标准答案补丁。

## 开始演示

在 HomeGraph 仓库根目录执行，将源码路径替换为本地对应 Git 仓库：

```bash
python3 scripts/debug_homegraph.py \
  --source-repo /path/to/xengine-samplecode-vulkan-temporal-upscale-demo-cpp \
  --mode rules --interactive
```

按 Enter 执行下一步，Ctrl+C 结束并保留已完成记录。默认输出到当前目录的 `.homegraph-debug/时间戳/`；可用 `--output /path/to/new-directory` 指定新目录，已有目录会被拒绝覆盖。脚本导出固定提交的独立副本，在副本建立索引，原仓库当前分支和未提交改动不参与演示。

```bash
# 查看所有步骤，不需要源码仓库或模型服务
python3 scripts/debug_homegraph.py --list-steps

# 只演示 UI → Native 及引用/调用方向；步骤仍按案例顺序执行
python3 scripts/debug_homegraph.py \
  --source-repo /path/to/xengine-samplecode-vulkan-temporal-upscale-demo-cpp \
  --only search,ui_source,native_body,usages,native_exports,callers,callees \
  --interactive --print-chars 2000

# 相同原始源码，分别运行规则 Planner 和真实模型 Planner
python3 scripts/debug_homegraph.py \
  --source-repo /path/to/xengine-samplecode-vulkan-temporal-upscale-demo-cpp \
  --mode both --planner-url http://127.0.0.1:8002/v1 \
  --planner-model qwen3-32b
```

LLM 模式需要显式提供兼容 Chat Completions 的服务地址。若服务在远程机器，通过现有 SSH 隧道转发后传本地端口即可；脚本不自动连接远程机器。认证从 `HOMEGRAPH_QUERY_PLANNER_API_KEY` 环境变量读取（可用 `--planner-key-env` 改名称），未设置时使用 `EMPTY`。记录请求体和响应体，不记录认证头。`rules` 不连接模型。

## 15 步怎么讲

| 步骤 | 观察内容 |
| --- | --- |
| project | 工程模块与文件规模；无需 Planner |
| path_first | 单文件且明确修改路径时的 Skip HomeGraph |
| plan | 完整原始题目进入 explore，观察规划资格、步骤、种子和回退原因 |
| literal | 菜单原文字面量检索与后续 native 线索 |
| repeat_guard | 同一任务的重复/预算限制；拒绝不等于任务完成 |
| search | 精确定位 `SetUpscaleMethod` |
| ui_source | `Index.ets` 中菜单及 `onSelect → setUpscaleMethod(index)` |
| native_body | C++ 回调的参数处理和渲染调用 |
| usages | ArkTS 调用点、C++ 注册/引用位置 |
| native_exports | `setUpscaleMethod` 导出名 → C++ 回调的注册证据 |
| callers / callees | 对照入向、出向调用，区分来源和去向 |
| modules | 模块依赖查询及可能的空结果 |
| new_api | 原始版本中不存在的新增 API，观察搜索无结果 |
| imports | 独立检查文件导入方向与规划路由 |

这是可复现的工具调用脚本，不是自主编码 Agent。`task` 会话执行原始问题及恢复/重复探针；`guided` 会话使用预先从源码取得的锚点展示工具；`imports` 再单独开会话。专用工具的证据输出也会记入检索历史，因此将 imports 独立出来，避免其被前面的诊断耗尽预算。分组是为了比较工具，不应把这些步骤合计成一个 Agent 会话的检索效果。

## 从记录定位问题

| 文件 | 用途 |
| --- | --- |
| `report.md`、`summary.json` | 每步工具、耗时、Planner 来源、调用次数、覆盖状态和回退原因 |
| `steps/*/input.json` | 实际工具参数和该步骤的目的 |
| `steps/*/result.json`、`result.md` | 原始元数据和完整源码证据；控制台截断不影响落盘 |
| `sessions/*/mcp.jsonl`、`server.stderr.log` | 完整 MCP 收发消息、进程错误输出 |
| `planner/*/request.json` | 实际送给 Planner 的 prompt、模型参数 |
| `planner/*/response.body`、`response.json` | 收到的原始响应；无响应时不会伪造这些文件 |
| `planner/*/raw-plan.json` | 响应 content 能解析为 JSON 时保存的模型提案，尚未经过 HomeGraph 校验 |
| `planner/*/meta.json` | HTTP 状态、转发耗时和网络异常类型 |
| `manifest.json`、`case.json` | 原始提交、构建路径、模型配置及完整案例 |
| `source-sha256.json`、`build-sha256.json`、`source-integrity.json` | 原始源码与构建指纹、导出源码完整性检查 |
| `index.*`、`repo/` | 索引日志和可再次检查的独立工程 |

先看 `model_requests`：0 可能是规则模式、无需模型、Skip 或重复保护，不是模型调用失败。再看 `fallback`：`planning_timeout` 表示规划超时后使用规则。若已有 raw-plan，应再对照工具返回的 `homegraphQueryPlan`，确认提案是否通过校验、哪些种子实际用于搜索。最后逐项检查源码位置和 `uncovered`；HTTP 200、合法 JSON、非空文本都不能证明证据充分。

当前脚本设置规划预算 10 秒、工具共享预算 15 秒。记录器等待上游连接/响应头与响应体的超时各有上限，因此可能在工具已回退后才记下上游超时；不要把本地记录器的 502 当作远程服务返回的 502。

## 本次实跑观察（2026-09-07）

- 最终规则演示完成 15 步，导出源码完整性检查通过。菜单源码、NAPI 注册、引用和 C++ 回调可读。
- `callers` 返回 ArkTS 的 `build` 与选择回调；`callees` 返回 `GetInstance`、`SetMode`。这证明该索引返回了这些关系，仍需结合源码判断具体语义。
- `modules` 的 `entry` 查询为空；当前旧模块查询只识别特定模块命名。独立 imports 在规则模式也未取得证据，不能把它计作成功的依赖检索。
- `XEG_SpatialUpscale` 在原始索引中搜索无结果；这是新增 API，不足以说明需求无法实现。
- 另一次完整 rules/真实 Qwen 对照中，两次模型请求均未在预算内返回，工具记录 `planning_timeout` 并规则回退；记录器随后保存 `TimeoutError`。这轮没有成功的模型 plan，不能据此评价模型规划质量或归因于模型生成内容。
- 菜单采用直接字符串，本题没有验证“资源值 → 资源键”链路；也不覆盖 SDK 编译、设备效果、内存泄漏或最终补丁正确性。

脚本测试：`python3 -m unittest discover -s test/python -v`。覆盖独立导出、非法归档、MCP 分帧/EOF/超时清理、Planner 正常 JSON/非法内容/连接失败及认证不落盘。
