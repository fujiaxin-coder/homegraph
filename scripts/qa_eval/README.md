# QA Eval — 四段式 A/B 评测流水线

内置多轮 Agent + Judge + 统计 + 报告，对齐 CodeGenie / Trae 评测框架：**Agent 跑题 → Judge 打分 → 分数统计 → 效率统计 → A/B 对比**。

- **国内可用**：builtin Agent / Judge 走 OpenAI 兼容接口（DashScope Qwen 或智谱 GLM）
- **多 Agent 宿主**：builtin Python Agent、Claude Code CLI、DevEco Code CLI
- **不依赖** ragas / langchain
- **被测仓库**：运行时用 `--repo` / `-r` 指定，无默认路径

## 测试输入

**格式**：JSONL 或 Excel（`.xlsx`），一行/一行一条，UTF-8。

`run_pipeline.py` 的 `-d` / `--dataset` **直接支持 `.xlsx`**（读取 `query`、`reference_answer` 及分类列，无需手动转 JSONL）。

```json
{
  "id": "R01",
  "query": "...",
  "reference_answer": "...",
  "category_l1": "检索",
  "category_l2": "函数"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 题号，如 `R01` / `E03` / `D05` |
| `query` | 是 | 给 Agent 的问题 |
| `reference_answer` | 是 | 参考答案（Judge 对照） |
| `category_l1` | 建议 | 一级分类：`检索` / `解读` / `依赖`（仅报告分组） |
| `category_l2` | 可选 | 二级分类（仅报告分组） |
| `level0` / `level1` / `difficulty` / `language` | 可选 | 元数据，Judge 不读取 |

**默认测试集**：`scripts/qa_eval/data/test-set.jsonl`（完整集 20 条：检索 7 + 解读 7 + 依赖 6；可按需增删行）。

## 目录结构

```
scripts/qa_eval/
├── agent_runner.py         # Stage 1a：builtin 多轮 Agent（with / without）
├── external_agent.py       # Stage 1b：Claude Code / DevEco Code 外部 Agent
├── my_answer_accuracy.py   # Judge 指标（双 prompt 0–5 归一化）
├── eval_metrics.py         # Stage 2：对 JSONL 批量打分
├── stats_scores.py         # Stage 3：answer_accuracy_score 汇总
├── stats_efficiency.py     # Stage 4：解析 Agent 日志（首响应/轮次/耗时/Token/内存）
├── memory_monitor.py       # 进程树 RSS 采样（Linux /proc；Windows/macOS 用 psutil）
├── llm_config.py           # DashScope / 智谱 provider 预设
├── run_pipeline.py         # 编排 Stage 1–4 + A/B 报告
├── _test_deveco_probe.py   # DevEco 单题探测脚本（开发调试用）
├── requirements.txt
├── data/                   # 测试集 + 报告（报告不入库）
│   ├── test-set.jsonl      # 测试集（入库）
│   └── report-{host}.txt   # 完整 A/B 报告（gitignore，留在 data/）
└── log/                    # 流水线中间产物（整目录 gitignore）
    ├── result-with-{host}.jsonl
    ├── result-without-{host}.jsonl
    ├── result-*-{host}-scored.jsonl
    ├── agent-with-{host}.log
    ├── agent-without-{host}.log
    ├── eval_metrics.log    # Judge 运行日志（若有）
    └── traces/             # DevEco session 导出（仅 deveco-code 宿主）
        ├── with-deveco/
        │   └── R01-ses_*.json
        └── without-deveco/
            └── R01-ses_*.json
```

**Git 入库规则**

| 路径 | 是否提交 |
|------|----------|
| `scripts/qa_eval/*.py`、`README.md`、`requirements.txt` | 是 |
| `data/test-set.jsonl` | 是 |
| `data/report*.txt` | 否 |
| `log/` 下全部 | 否 |
| `__pycache__/` | 否 |

**与旧版路径对照**（若你手头是早期文档）：

| 旧路径 | 现路径 |
|--------|--------|
| `data/test.jsonl` | `data/test-set.jsonl` |
| `data/result-*.jsonl` | `log/result-*-{host}.jsonl` |
| `data/agent-*.log` | `log/agent-*-{host}.log` |
| `data/report.txt` | `data/report-{host}.txt` |

## 测试流程

```
test-set.jsonl
    ↓
Stage 1  agent_runner.py / external_agent.py（run_pipeline ab 内置）
         with    : homegraph MCP / HomegraphQuery + ReadFile
         without : grep/rg + read（无 homegraph）
         产出: log/result-*-{host}.jsonl + log/agent-*-{host}.log
         （deveco-code 额外产出 log/traces/{arm}-deveco/*.json）
    ↓
Stage 2  eval_metrics.py     → log/result-*-{host}-scored.jsonl
    ↓
Stage 3  stats_scores.py     → 准确率汇总（并入 report-{host}.txt）
Stage 4  stats_efficiency.py → 效率 + 内存汇总（终端 + report-{host}.txt）
    ↓
run_pipeline.py ab           → data/report-{host}.txt
```

**A/B 唯一变量**：Agent 是否可用 homegraph。两臂使用**同一 Agent 宿主、同一 max_turns（builtin）**；without **不是裸 LLM**，仍是多轮 grep/read Agent。

### Stage 1 工具对照

| 臂 | builtin 工具 | Claude / DevEco |
|----|--------------|-----------------|
| **with** | `HomegraphQuery`、`ReadFile` | MCP `homegraph_explore` / `homegraph_node` 等 + 内置 read/grep |
| **without** | `SearchText`(rg)、`FindFiles`、`ReadFile` | 仅内置 grep/read；DevEco 在 `.deveco/deveco.jsonc` 中 deny homegraph 工具 |

## 测试输出

### 核心指标（`report-{host}.txt` 末尾【A/B 汇总表】）

| 指标 | 含义 | A/B 怎么看 |
|------|------|------------|
| 准确率 均值 | Judge 的 `answer_accuracy_score`（0–1）全题平均 | Δ > 0 表示 with 答案质量更高 |
| 准确率 中位数 | 同上，中位数（抗极端值） | 与均值交叉验证 |
| Judge 成功/总数 | 成功打分数 / 总题数 | 应接近 100%；失败查 API/JSONL |
| 平均轮次 | 每题 LLM 工具循环次数（日志 `the N turn` 最大 N）再平均 | **越低越好**；with 理想上更低 |
| 平均耗时 (秒) | 每题从 `Evaluate N:` 到下一题开始的端到端时间再平均 | **越短越好** |
| 平均 Token (k) | 每题 `totalTokenCount` 累加再平均，单位 k | **越少越好** |
| 平均首响应 (秒) | 每题从 `Evaluate N:` 到第一次 LLM 返回再平均 | 参考项 |
| 平均峰值内存 (MB) | Agent + MCP 子进程树 RSS 峰值再平均 | **越低越好**；需 `psutil`（Windows/macOS）或 Linux `/proc` |
| 最大峰值内存 (MB) | 单题 RSS 峰值最大值 | 观察 OOM 风险 |

Δ 列均为 **with − without**。

### JSONL 产出字段（Stage 1）

每条在测试集字段基础上追加：

```json
{
  "output_answer": "---\nHomegraphQuery\n...\n---\n\n最终自然语言答案…",
  "agent_status": "success",
  "agent_error": null,
  "agent_backend": "deveco-code-with-homegraph",
  "agent_host": "deveco-code",
  "agent_model": "glm-4.5-flash",
  "agent_turns": 2,
  "agent_duration_ms": 73200,
  "agent_usage": { "total_tokens": 9249 },
  "agent_memory_mb": { "peak_rss_mb": 412.5, "avg_rss_mb": 380.2 },
  "ab_arm": "with-homegraph",
  "deveco_session_id": "ses_101dd0359ffeWUPIajCOuBEQtx",
  "agent_trace_file": "log/traces/with-deveco/R02-ses_101dd0359ffeWUPIajCOuBEQtx.json",
  "agent_tools_used": ["homegraph_homegraph_explore", "read"],
  "agent_used_homegraph": true,
  "agent_answer_source": "session_export"
}
```

| 字段 | 说明 |
|------|------|
| `output_answer` | 工具调用块（`---` 包裹）+ 最终答案；Judge 会剥工具块再打分 |
| `agent_status` | `success` / `error` |
| `agent_memory_mb` | 答题期间进程树 RSS（见「内存采样」） |
| `deveco_session_id` | DevEco 会话 ID（`deveco-code` 宿主） |
| `agent_trace_file` | 相对 `scripts/qa_eval/` 的 session 导出 JSON 路径 |
| `agent_used_homegraph` | with 臂是否实际调用了 homegraph MCP 工具 |

Judge 追加：`answer_accuracy_score`（0–1）、`evaluation_status`（`success` / `failed`）。

### Agent 日志格式（`agent-*-{host}.log`）

```
2026-06-23 09:25:21.052447 Evaluate 1:
2026-06-23 09:25:21.052571 the 1 turn
2026-06-23 09:25:22.321954 first token          ← 第一次 LLM API 返回
2026-06-23 09:25:22.321954 totalTokenCount = 349
2026-06-23 09:25:27.771606 the 2 turn
2026-06-23 09:25:28.861895 totalTokenCount = 947
2026-06-23 09:25:30.102441 sessionID = ses_...   ← DevEco 专有
2026-06-23 09:25:30.102441 tools = homegraph_homegraph_explore, read
2026-06-23 09:25:30.102441 session export → log/traces/with-deveco/R01-ses_....json
2026-06-23 09:25:30.102441 peakRssMb = 412.5
2026-06-23 09:25:30.102441 avgRssMb = 380.2
2026-06-23 09:25:30.102441 completed (73200ms)
```

## Agent 轨迹（Trace）

**适用宿主**：主要为 `deveco-code`（每题自动 `deveco export <session_id>`）。

| 查看方式 | 命令 / 路径 |
|----------|-------------|
| 导出 JSON | `log/traces/{with\|without}-deveco/<ID>-ses_<session>.json` |
| DevEco CLI | `deveco export <session_id>` 或 `deveco session list`（标题 `qa-eval-{arm}-{id}`） |
| 报告索引 | `report-{host}.txt` 中【Agent 轨迹 / DevEco Session】表 |

轨迹 JSON 含完整 `messages` / `parts`（用户问题、工具 input/output、assistant 文本、token 统计），用于人工复盘 Agent 是否按预期调用 `homegraph_explore`。

`claude-code` 宿主将 stream-json 解析进 `output_answer`，不单独落 trace 文件。

## 内存采样

- **实现**：`memory_monitor.py` 在 Agent 子进程存活期间每 0.25s 采样进程树 RSS（Linux `/proc`；Windows/macOS 用 `psutil`）。
- **写入**：JSONL `agent_memory_mb`；日志 `peakRssMb` / `avgRssMb`；报告「平均/最大峰值内存」。
- **平台**：Linux / WSL / **Windows 原生** 均有数据（需 `pip install psutil`）；未安装 psutil 且非 Linux 时显示 `N/A`。
- **采样范围**：builtin / 外部 CLI 的 **子进程树**（含 homegraph MCP 子进程）。

## Agent 宿主（`--agent-host`）

| 宿主 | 说明 | Agent 前置条件 | 报告文件 |
|------|------|----------------|----------|
| `builtin`（默认） | Python 内置多轮 Agent + 智谱/DashScope | `ZHIPU_API_KEY` 或 `DASHSCOPE_API_KEY` | `report-builtin.txt` |
| `claude-code` | Claude Code CLI（`claude -p` + MCP） | `claude login` 已登录 | `report-claude.txt` |
| `deveco-code` | DevEco Code / opencode CLI | `deveco` 在 PATH，DevEco provider 已配置 | `report-deveco.txt` |

**注意**：`--provider zhipu` 只影响 **builtin Agent** 和 **Judge**；`deveco-code` / `claude-code` 使用各自 CLI 的账号，不读 `ZHIPU_API_KEY`。

### DevEco Code 配置要点

```bash
deveco providers login    # 选 Zhipu AI，输入 API Key
# 凭证目录（Windows）: C:\Users\<你>\.config\deveco
```

- pipeline 会在被测仓库写入 `.deveco/deveco.jsonc`（with 臂挂 homegraph MCP + **工具选用 prompt** + deny `homegraph_files`；without 臂 deny 全部 homegraph 工具）。
- TUI 若提示 **DEVECO_HOME**，那是 DevEco **Studio** 安装路径（编译用）；**跑 qa_eval 可跳过**。
- 可选 `--deveco-model zhipuai/glm-4.5-flash`（格式 `provider/model`，用 `deveco models` 查看）。
- 可选 `--deveco-attach http://127.0.0.1:4096` 或 `QA_EVAL_DEVECO_ATTACH` 复用已运行的 `deveco serve`，减少冷启动。

Judge（Stage 2）三种宿主共用，仍需 `ZHIPU_API_KEY` 或 `DASHSCOPE_API_KEY`。

## 快速开始

```bash
pip install -r scripts/qa_eval/requirements.txt \
  -i https://pypi.tuna.tsinghua.edu.cn/simple

export DASHSCOPE_API_KEY="sk-xxxxxxxx"
# 或智谱（Key 格式 id.secret，不要加 sk- 前缀）：
# export ZHIPU_API_KEY="xxxxxxxx.yyyyyyyy"

cd /path/to/homegraph

python scripts/qa_eval/run_pipeline.py ab \
  -r /path/to/scene_board_ext \
  -d /path/to/dataSet10.xlsx \
  --agent-host deveco-code \
  --provider zhipu
```

无需手动转 JSONL、无需手动 `homegraph init`：pipeline 会自动读取 xlsx、构建本地 homegraph（若需要）、并对仓库建索引。

### 三种宿主示例

```bash
# ① builtin
export ZHIPU_API_KEY="your-id.your-secret"
python scripts/qa_eval/run_pipeline.py ab -r /path/to/repo --provider zhipu --agent-host builtin

# ② Claude Code（Agent 用 Claude 账号，Judge 仍用 ZHIPU_API_KEY）
claude login
python scripts/qa_eval/run_pipeline.py ab -r /path/to/repo --provider zhipu --agent-host claude-code

# ③ DevEco Code
deveco providers login
python scripts/qa_eval/run_pipeline.py ab -r /path/to/repo --provider zhipu --agent-host deveco-code
# python scripts/qa_eval/run_pipeline.py ab -r /path/to/repo --provider zhipu --agent-host deveco-code --deveco-model zhipuai/glm-4.5-flash

# ④ 三种依次跑（各写各的报告）
python scripts/qa_eval/run_pipeline.py hosts -r /path/to/repo --provider zhipu
```

产出示例（每种宿主一套，互不覆盖）：

| 宿主 | JSONL / 日志（`log/`） | 报告（`data/`） |
|------|------------------------|-----------------|
| builtin | `result-with-builtin.jsonl`、`agent-with-builtin.log` | `report-builtin.txt` |
| claude-code | `result-with-claude.jsonl`、`agent-with-claude.log` | `report-claude.txt` |
| deveco-code | `result-with-deveco.jsonl`、`agent-with-deveco.log`、`traces/` | `report-deveco.txt` |

只重打报告、不重跑 Agent/Judge（无需 `--repo`）：

```bash
python scripts/qa_eval/run_pipeline.py ab --no-agent --no-judge
# 保留上次 log 中间文件：
python scripts/qa_eval/run_pipeline.py ab -r /path/to/repo --keep-log
```

### `report-{host}.txt` 结构

```
################################################################################
#                         A/B 完整评测报告                                      #
################################################################################

【输入文件】
【WITH homegraph】效率明细          ← 逐题 + 汇总（首响应/轮次/耗时/Token/内存）
【WITHOUT homegraph】效率明细
【WITH / WITHOUT homegraph】准确率统计
按类别准确率                        ← category_l1 分组 with/without 均分与 Δ
逐题对比                            ← 得分、答案摘要；with 赢/平/输 计数
【Agent 轨迹 / DevEco Session】      ← deveco-code 专有（session_id + 轨迹路径）
【A/B 汇总表】                      ← 两臂核心指标并排 + Δ
```

## Stage 2 — Judge（`eval_metrics.py`）

```bash
python scripts/qa_eval/eval_metrics.py \
  -i scripts/qa_eval/log/result-with-builtin.jsonl \
  -o scripts/qa_eval/log/result-with-builtin-scored.jsonl \
  -w 2 --provider zhipu
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `-i` / `--input` | — | Agent 产出 JSONL |
| `-o` / `--output` | `*-scored.jsonl` | 打分结果 |
| `-w` / `--workers` | `1` | 并发线程数 |
| `-m` / `--model` | 随 provider | Judge 模型 |
| `--provider` | 自动检测 | `dashscope` / `zhipu` |

## Stage 3 / 4 — 统计脚本

```bash
python scripts/qa_eval/stats_scores.py \
  -i scripts/qa_eval/log/result-with-builtin-scored.jsonl

python scripts/qa_eval/stats_efficiency.py \
  -l scripts/qa_eval/log/agent-with-builtin.log
```

`stats_efficiency.py` 输出逐题首响应、轮次、总时间、总 Token、**峰值内存**；日志缺失时回退 JSONL `agent_usage`（无轮次/耗时/首响应）。

## `run_pipeline.py` 命令

### `ab` — A/B 全流程

```bash
python scripts/qa_eval/run_pipeline.py ab -r /path/to/your/repo [选项]
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `--repo`, `-r` | — | **被测仓库**（跑 Agent 时必填） |
| `--dataset`, `-d` | `data/test-set.jsonl` | 测试集（`.jsonl` 或 `.xlsx`） |
| `--with-jsonl` / `--without-jsonl` | `log/result-*.jsonl` | Agent 产出 |
| `--with-scored` / `--without-scored` | `log/result-*-scored.jsonl` | Judge 产出 |
| `--with-log` / `--without-log` | `log/agent-*.log` | Agent 日志 |
| `--report` | `data/report-{host}.txt` | 完整报告路径 |
| `--model`, `-m` | 随 provider | builtin Agent + Judge 模型 |
| `--provider` | 自动检测 | `dashscope` / `zhipu` |
| `--workers`, `-w` | `1` | Judge 并发 |
| `--max-turns` | `8` | builtin Agent 最多工具轮次 |
| `--agent-host` | `builtin` | `builtin` / `claude-code` / `deveco-code` / `all` |
| `--homegraph-bin` | 自动检测 | 优先本地 `dist/bin/homegraph.js` |
| `--deveco-model` | `zhipuai/glm-4.5-flash` | DevEco Agent 模型（仅 deveco-code） |
| `--deveco-attach` | `$QA_EVAL_DEVECO_ATTACH` | 复用 `deveco serve` 地址 |
| `--no-agent` | — | 跳过 Stage 1 |
| `--no-judge` | — | 跳过 Stage 2 |
| `--keep-log` | — | 跑 Agent 前**不清空** `log/` |

### `hosts` — 多宿主依次跑

等价于对 `builtin,claude-code,deveco-code` 各跑一遍 `ab`：

```bash
python scripts/qa_eval/run_pipeline.py hosts -r /path/to/repo --provider zhipu
python scripts/qa_eval/run_pipeline.py hosts -r /path/to/repo --agent-hosts claude-code,deveco-code
```

### `score` — 单路 Judge + 统计

```bash
python scripts/qa_eval/run_pipeline.py score \
  -i scripts/qa_eval/log/result-with-builtin.jsonl \
  -l scripts/qa_eval/log/agent-with-builtin.log
```

## 外部 Agent 产出（可选）

若用 CodeGenie / Trae 等外部系统产出**同格式** JSONL + 日志：

```bash
python scripts/qa_eval/run_pipeline.py ab --no-agent -r /path/to/repo
```

## 常见问题

| 现象 | 处理 |
|------|------|
| Claude 准确率全低 / `Not logged in` | `claude login` 后重跑；pipeline 首题会 fail-fast |
| `deveco-code` exit 1 / `Model not found` | 用 `deveco models` 里的 `zhipuai/...` 名，或 `--deveco-model zhipuai/glm-4.5-flash` |
| DevEco `ServeError` / 端口占用 | `netstat -ano \| findstr :4096` 后结束进程，或不加 `--deveco-attach` |
| DevEco 凭证损坏 | `deveco providers reset` 后重新 login |
| `401` / Judge 全失败 | 检查 Key；智谱用 `--provider zhipu`，Key 格式 `id.secret` |
| `Cannot find module 'arkanalyzer'` | 发布包 < 下一版时未打进 bundle；升级 homegraph，或源码路径 `npm install && npm run build` 后用 `node dist/bin/homegraph.js sync` |
| `rg not found on PATH` | 安装 ripgrep（without 臂 builtin 需要） |
| 日志解析 0 条任务 | 确认 log 含 `Evaluate N:` 行 |
| 内存全为 N/A | 执行 `pip install -r scripts/qa_eval/requirements.txt` 安装 `psutil`；Linux 无需 psutil |
| with 臂未用 homegraph | 看报告轨迹表 `HG` 列或 `agent_used_homegraph`；DevEco with 臂有专用 prompt |
| 分数偏低但答案看起来对 | 检查 `output_answer` 是否只剩工具块、无最终自然语言答案 |
| pip 慢 | 清华镜像（见快速开始） |

## 最小通路（仅 Judge 单条）

```bash
export DASHSCOPE_API_KEY="sk-xxx"
head -1 scripts/qa_eval/log/result-with-builtin.jsonl > /tmp/one.jsonl
python scripts/qa_eval/eval_metrics.py -i /tmp/one.jsonl -o /tmp/one-scored.jsonl
python scripts/qa_eval/stats_scores.py -i /tmp/one-scored.jsonl
```
