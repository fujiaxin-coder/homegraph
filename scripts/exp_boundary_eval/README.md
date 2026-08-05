# 边界评测（exp_boundary_eval）

在 OpenHarmony **Photos** 仓库上，对比 Agent **不带 HomeGraph（baseline）** 与 **带 HomeGraph MCP（homegraph）** 的探索行为：档位切换、跨层穿透、幻觉/遗漏风险等。

跑完实验后脚本会**自动生成**各组分析报告和 A/B 对比报告（Markdown），路径会在控制台打印。

---

## 快速开始

```powershell
cd D:\code\homegraph
npm run build

cd D:\code\homegraph\scripts\exp_boundary_eval
# 一条命令：先 index/校验 → homegraph 组 → baseline 组 → 自动出报告
# 不要另开终端同时跑 node … index，会与 index 抢 .homegraph 锁
python run_all.py --both-arms --agent deveco --repo-path D:\code\homegraph\scripts\exp_boundary_eval\data\clone
```

**前置条件**

| 项 | 说明 |
|----|------|
| Python | 3.8+（Windows 建议用本机 Python，不要用 WSL 跑 DevEco） |
| Agent CLI | `deveco` / `claude` 等已在 PATH；DevEco 可用 `DEVECO_BIN` 指定路径 |
| git | 用于 clone / 重置测试仓库 |
| homegraph 组 | 在仓库根目录先执行 `npm run build` |

**DevEco 模型**：无需在本脚本里配置；使用 DevEco Studio / CLI 里已配好的默认模型即可。

---

## 目录与文件说明

```
scripts/exp_boundary_eval/
├── README.md              ← 本文件
├── run_all.py             ← 主入口：批量跑实验，跑完自动 analyze + 对比报告
├── run_one.py             ← 单个 one-shot 实验
├── run_session.py         ← 多轮会话实验（实验 5）
├── analyze.py             ← 分析脚本（也可单独对历史结果目录运行）
├── setup.py               ← 每次实验前：重置仓库、清 CLAUDE.md、生成 session
├── _utils.py              ← 公共工具：Agent 注册、输出解析、目录创建
│
├── data/                  ← 配置与共用 clone（clone/ 在 .gitignore）
│   ├── experiments.json   ← 实验定义：id、标题、prompt、max_turns
│   ├── agents.json        ← Agent CLI 定义：binary、flags、parser
│   └── clone/             ← A/B 共用 git clone（run_all --both-arms 自动维护）
│
├── output/                ← 实验产物与报告（gitignore）
│   ├── baseline/{agent}/{时间戳}/     ← 无 HomeGraph 组
│   │   ├── run_manifest.json
│   │   ├── analysis_report.md         ← 单组分析报告（跑完自动生成）
│   │   └── {实验ID}/
│   │       ├── prompt.txt             ← 发给 Agent 的 prompt
│   │       ├── stream_output.jsonl    ← Agent 原始 JSON 流
│   │       ├── raw_output.txt         ← 解析出的文本回复
│   │       └── results.json           ← 汇总指标（耗时、工具、Token…）
│   ├── homegraph/{agent}/{时间戳}/    ← 有 HomeGraph 组（结构同上）
│   └── compare/{agent}/{时间戳}/      ← A/B 对比报告（--both-arms 跑完自动生成）
│       ├── ab_compare_report.md
│       └── compare_manifest.json      ← 指向两组原始目录与报告
│
└── log/                   ← 运行日志与 state（gitignore）
    └── {组别}/{agent}/{时间戳}/
        ├── run.log
        ├── run_manifest.json
        └── {实验ID}/state.json
```

### 配置文件

**`data/experiments.json`** — 每个实验一条记录：

- `id`：如 `1-1`、`2`、`5`
- `type`：`oneshot`（默认）或 `session`（实验 5）
- `title` / `prompt`：任务描述
- `max_turns`：回合上限（DevEco 无此 flag 时脚本会忽略）

**`data/agents.json`** — 支持的 Agent：

- `deveco`、`claude`、`cursor`、`codex`、`opencode`、`generic`、`text`
- 字段 `binary`、`flags`、`parser`、`missing`（不支持的 CLI 参数）

---

## 常用命令

### A/B 完整评测（推荐）

```powershell
# 默认跑 1-1、1-2、1-3；自动 clone；跑完出 baseline 报告 + homegraph 报告 + 对比报告
python run_all.py --both-arms --agent deveco

# 使用本地已有 checkout（跳过 clone）
python run_all.py --both-arms --agent deveco --repo-path D:\path\to\applications_photos
```

### 只跑一组

```powershell
python run_all.py --agent deveco --arm baseline
python run_all.py --agent deveco --arm homegraph
```

### 跑全部 11 项实验

```powershell
python run_all.py --both-arms --agent deveco 1-1 1-2 1-3 2 3-1 3-2 3-3 4-1 4-2 4-3 5
```

### 单个实验（需先设仓库路径）

```powershell
$env:REPO_PATH = "D:\code\homegraph\scripts\exp_boundary_eval\data\clone"
python run_one.py 1-1 --agent deveco
python run_session.py 5 --agent deveco
```

### 手动分析（补跑或只看历史结果）

```powershell
python analyze.py output\baseline\deveco\20260627_110832
python analyze.py output\homegraph\deveco\20260627_111331
```

对比报告仅在 `run_all.py --both-arms` 跑完时自动生成；也可在 Python 里调用 `analyze.compare_runs(baseline_dir, homegraph_dir, ...)`。

---

## 跑完后的报告

`run_all.py` 结束时控制台会打印类似：

```
==== 报告已生成 ====
  Baseline 报告:  ...\output\baseline\deveco\...\analysis_report.md
  HomeGraph 报告: ...\output\homegraph\deveco\...\analysis_report.md
  A/B 对比报告 :  ...\output\compare\deveco\...\ab_compare_report.md
```

| 报告 | 内容 |
|------|------|
| `analysis_report.md` | 单组：各实验表格、7 维度评分、档位/幻觉/跨层等解读 |
| `ab_compare_report.md` | 两组：墙钟耗时、工具调用、Token、逐实验对比、评分对比 |

**对比指标**（来自 `results.json` / stream 解析）：

| 指标 | 字段 |
|------|------|
| 单实验耗时 | `duration_s` |
| 工具调用 | `tool_calls` |
| Token | `input_tokens`、`output_tokens` |
| 读取/编辑文件 | `files_read`、`files_edited` |
| Grep/Glob | `tool_names` 中的 search 类工具 |

**内存**：当前未采集进程内存；对比报告中该列为「未采集」。需要时可自行加外部 profiling。

---

## 默认实验（1-1 / 1-2 / 1-3）

档位切换边界探测：信息缺口从小到大，观察 Agent 是否从「快速检索」升级到「深度探索」。

---

## 常见问题

### WSL 里 `deveco --version` 失败

DevEco Code **没有 Linux 版**。请在 **Windows** 或 **macOS** 上跑本评测。

```powershell
npm install -g @deveco/deveco-code
deveco --version
cd D:\code\homegraph\scripts\exp_boundary_eval
python run_all.py --both-arms --agent deveco
```

WSL 内路径仅作诊断，不能真正跑 DevEco：

```bash
export DEVECO_BIN=/mnt/c/Users/.../AppData/Roaming/npm/deveco
```

### homegraph 组 indexing 失败

在 homegraph 仓库根目录执行：

```powershell
cd D:\code\homegraph
npm run build
```

### Python 3.8 on Windows 编码错误

脚本已对 JSON 读写和终端输出做 UTF-8 处理；若仍乱码，可在 PowerShell 中先执行 `chcp 65001`。

---

## A/B 机制（真实对照）

两组差异由 `deveco_arm.py` 写入测试仓库的 `.deveco/deveco.jsonc`：

| 组别 | MCP | Agent Prompt | homegraph 工具 |
|------|-----|--------------|----------------|
| **baseline** | 无 | 仅用 grep/read | `deny` |
| **homegraph** | `homegraph serve mcp --path <repo>` | 优先 `homegraph_explore` | 启用 |

- 每次实验前 `setup.py` 会重置仓库并**重新写入**上述配置；`deveco run --dir <repo>` 读取项目级配置。
- homegraph 组的 `git clean` 保留 `.homegraph/` 索引，避免重复 `init -i`。
- 对比报告 **A/B 有效性** 一节检查：baseline 的 HomeGraph 工具调用应为 0，homegraph 组应 > 0。

---

## 与 HomeGraph 主仓库的关系

- **homegraph 组**索引策略（`deveco_arm.ensure_homegraph_index`）：
  - 无 `.homegraph/` → `homegraph init <repo>`（若仍不健康则继续 `homegraph index`）
  - 已初始化 → **`homegraph index` 全量重建**（不用 `sync`）
  - **`--both-arms`**：**一启动就先** index/校验 `.homegraph/`，再跑 **homegraph → baseline**（先看到 HG 是否生效）
  - 单独 `--arm homegraph`：组开头同样阻塞 index
  - 每个实验前的 `setup.py` **不再**重复 index
  - **不要**在跑 `run_all.py` 的同时另开终端 `node … index`（会并发写 `.homegraph`）

### 复用已有 `.homegraph/`（跳过 index）

**可以**：把整个 `.homegraph/` 目录复制到目标仓库根目录，只要：

1. **相同代码** — 同一 git commit（DB 里存的是相对路径 + 文件 content hash，不绑定绝对路径）
2. **索引完整** — 尤其 Photos 级仓库需含 ArkTS Scene（`homegraph status -j` 里 `struct`/`component` > 0、`languages` 含 `arkts`）
3. **HomeGraph 版本** — 最好用**同一套** `dist/bin/homegraph.js` 构建；若 extraction 版本落后，`status` 会标 `reindexRecommended`，脚本会拒绝 `--skip-index`

复制示例（Windows）：

```powershell
# 源：已在 Linux/Mac 上 index 成功的 checkout
Copy-Item -Recurse D:\backup\applications_photos\.homegraph D:\code\applications_photos\.homegraph

# 跑评测，不再 index
python run_all.py --both-arms --agent deveco --repo-path D:\code\applications_photos --skip-index
```

单独 homegraph 组同样支持：`python run_all.py --arm homegraph --skip-index --repo-path …`

若仓库相对索引有文件变更，脚本会 **warn** 但仍继续（MCP 可能对改过的文件不准）；严重不完整则 **abort** 并提示去掉 `--skip-index` 或 `homegraph sync`。
