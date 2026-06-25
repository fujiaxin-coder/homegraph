# QA Eval — 四段式 A/B 评测流水线

内置多轮 Agent + Judge + 统计 + 报告，对齐 CodeGenie / Trae 评测框架：**Agent 跑题 → Judge 打分 → 分数统计 → 效率统计 → A/B 对比**。

- **国内可用**：Agent / Judge 均走 OpenAI 兼容接口，支持 **DashScope Qwen** 或 **智谱 GLM**
- **不依赖** Claude / ragas / langchain
- **被测仓库**：运行时用 `--repo` / `-r` 指定，无默认路径
## 目录

```
scripts/qa_eval/
├── agent_runner.py         # Stage 1：内置多轮 Agent（with / without 两路）
├── my_answer_accuracy.py   # Judge 指标（双 prompt 0–5 归一化）
├── eval_metrics.py         # Stage 2：对 JSONL 批量打分
├── stats_scores.py         # Stage 3：answer_accuracy_score 汇总
├── stats_efficiency.py     # Stage 4：解析 Agent 日志（首响应/轮次/耗时/Token/内存）
├── memory_monitor.py       # 进程树 RSS 采样（Linux /proc）
├── external_agent.py       # Claude Code / DevEco Code 外部 Agent 跑题
├── run_pipeline.py         # 编排 Stage 1–4 + A/B 报告
├── requirements.txt
├── data/                   # 仅测试集 + 报告（可入库）
│   ├── test-set.jsonl
│   └── report-{host}.txt
└── log/                    # 流水线中间产物（不入库）
    ├── result-with-{host}.jsonl
    ├── result-without-{host}.jsonl
    ├── result-*-{host}-scored.jsonl
    ├── agent-with-{host}.log
    ├── agent-without-{host}.log
    └── eval_metrics.log
```

**Git 入库规则**

| 路径 | 是否提交 |
|------|----------|
| `scripts/qa_eval/*.py`、`README.md`、`requirements.txt` | 是 |
| `data/test-set.jsonl` | 是（测试集） |
| `data/report*.txt` | 否（报告，留在 data/ 但不入库） |
| `log/` 下全部 | 否 |
| `__pycache__/` | 否 |

## 整体流程

```
test-set.jsonl
    ↓
Stage 1  agent_runner.py（run_pipeline ab 内置）
         with    : HomegraphQuery + ReadFile
         without : SearchText(rg) + FindFiles + ReadFile
         产出: log/result-*-{host}.jsonl + log/agent-*-{host}.log
    ↓
Stage 2  eval_metrics.py     → log/result-*-{host}-scored.jsonl
    ↓
Stage 3  stats_scores.py     → 准确率汇总（并入 report-{host}.txt）
Stage 4  stats_efficiency.py → 效率汇总（终端 + report-{host}.txt）
    ↓
run_pipeline.py ab           → data/report-{host}.txt
```

**A/B 唯一变量**：Agent 是否可用 homegraph。两臂使用**同一模型、同一 max_turns**；without **不是裸 LLM**，仍是多轮 grep/read Agent。

## 快速开始

```bash
pip install -r scripts/qa_eval/requirements.txt \
  -i https://pypi.tuna.tsinghua.edu.cn/simple

export DASHSCOPE_API_KEY="sk-xxxxxxxx"
# 或使用智谱（Key 格式 id.secret，不要加 sk- 前缀）：
# export ZHIPU_API_KEY="xxxxxxxx.yyyyyyyy"

cd /path/to/homegraph && npm run build
node dist/bin/homegraph.js sync /path/to/your/repo

python scripts/qa_eval/run_pipeline.py ab -r /path/to/your/repo
# 智谱显式指定：
# python scripts/qa_eval/run_pipeline.py ab -r /path/to/your/repo --provider zhipu
# python scripts/qa_eval/run_pipeline.py ab -r /path/to/your/repo --provider zhipu --model glm-4-flash```

### Agent 宿主（`--agent-host`）

| 宿主 | 说明 | Agent 前置条件 | 报告文件 |
|------|------|----------------|----------|
| `builtin`（默认） | Python 内置多轮 Agent + 智谱/DashScope | `ZHIPU_API_KEY` 或 `DASHSCOPE_API_KEY` | `report-builtin.txt` |
| `claude-code` | **Claude Code CLI**（`claude -p` + MCP） | `claude login` 已登录 | `report-claude.txt` |
| `deveco-code` | **DevEco Code / opencode CLI** | `deveco` 在 PATH，且 **DevEco 自己的** provider 已登录（见下） | `report-deveco.txt` |

**注意**：`--provider zhipu` 只影响 **builtin Agent** 和 **Judge**；`deveco-code` / `claude-code` 使用各自 CLI 的账号与凭证，不会读取 `ZHIPU_API_KEY`。

DevEco 首次使用需配置模型（凭证保存在用户目录，**不是** DEVECO_HOME）：

```bash
deveco providers login    # 选 Zhipu AI，输入 API Key
# 凭证目录（Windows）: C:\Users\<你>\.config\deveco
```

TUI 若提示 **DEVECO_HOME**，那是 DevEco **Studio** 安装路径（需 6.1+），仅编译/推包需要；**跑 qa_eval 可跳过**。你当前 Studio 为 5.1，填 `C:\Program Files\Huawei\DevEco Studio` 会校验失败，属正常。

homegraph MCP 写在**被测仓库**的 `.deveco/deveco.jsonc`；智谱 Key 仍读 `~/.config/deveco`。

**Judge 打分**（Stage 2）三种宿主共用，仍需 `ZHIPU_API_KEY` 或 `DASHSCOPE_API_KEY`（与 `--provider` 一致）。

#### 怎么跑

```bash
cd /path/to/homegraph
npm run build
node dist/bin/homegraph.js sync /path/to/your/repo

# ① 内置 Agent（智谱）
export ZHIPU_API_KEY="your-id.your-secret"
python scripts/qa_eval/run_pipeline.py ab -r /path/to/your/repo --provider zhipu --agent-host builtin
# → report-builtin.txt

# ② Claude Code（Agent 用 Claude 自己的账号，Judge 仍用上面的 Key）
which claude && claude login        # 必须先登录，否则每题返回 Not logged in
python scripts/qa_eval/run_pipeline.py ab -r /path/to/your/repo --provider zhipu --agent-host claude-code
# → report-claude.txt

# ③ DevEco Code（Agent 用 DevEco 自己的 provider，Judge 仍用 ZHIPU_API_KEY）
where deveco
deveco providers reset   # 仅凭证损坏/换机时需要
deveco                   # TUI 里配置智谱等模型后再跑评测
python scripts/qa_eval/run_pipeline.py ab -r /path/to/your/repo --provider zhipu --agent-host deveco-code
# 指定 DevEco 模型（可选，格式 provider/model）：
# python scripts/qa_eval/run_pipeline.py ab -r /path/to/your/repo --provider zhipu --agent-host deveco-code --deveco-model zhipuai/glm-4.5-flash
# → report-deveco.txt

# ④ 三种依次跑（各写各的报告，不会互相覆盖）
python scripts/qa_eval/run_pipeline.py hosts -r /path/to/your/repo --provider zhipu

# 等价于 hosts 的子集：
python scripts/qa_eval/run_pipeline.py hosts -r /path/to/your/repo --agent-hosts claude-code,deveco-code --provider zhipu```

产出示例（每种宿主一套，互不覆盖）：

| 宿主 | JSONL / 日志（`log/`） | 报告（`data/`） |
|------|------------------------|-----------------|
| builtin | `log/result-with-builtin.jsonl`、`log/agent-with-builtin.log` | `data/report-builtin.txt` |
| claude-code | `log/result-with-claude.jsonl`、`log/agent-with-claude.log` | `data/report-claude.txt` |
| deveco-code | `log/result-with-deveco.jsonl`、`log/agent-with-deveco.log` | `data/report-deveco.txt` |

（without 臂同理：`result-without-{host}.jsonl`、`agent-without-{host}.log`）

**若全局 `homegraph sync` 报 `Cannot find module 'arkanalyzer'`**：用本地 `dist/bin/homegraph.js`（pipeline 会自动优先找本地 build）。

### `ab` 各阶段产出

| 阶段 | 终端 | 文件 |
|------|------|------|
| Stage 1 Agent | 每题进度 | `log/result-*.jsonl`、`log/agent-*.log` |
| Stage 2 Judge | eval_metrics 进度 | `log/result-*-scored.jsonl` |
| Stage 3–4 报告 | **效率明细**（两路任务列表 + 平均值） | **`data/report-{host}.txt`** |

终端最后一行示例：

```
A/B 完整报告已写入: .../scripts/qa_eval/data/report-deveco.txt
```

### `report-{host}.txt` 结构

```
################################################################################
#                         A/B 完整评测报告                                      #
################################################################################

【输入文件】
【WITH homegraph】效率明细      ← 逐题 + 汇总（见下方「效率指标」）
【WITHOUT homegraph】效率明细
【WITH / WITHOUT homegraph】准确率统计  ← 见下方「准确率指标」
按类别准确率                    ← category_l1 分组 with/without 均分与 Δ
逐题对比                        ← 每题得分、答案摘要；末尾 with 赢/平/输 计数
【A/B 汇总表】                  ← 两臂核心指标并排 + Δ（with−without）
```

只重打报告、不重跑 Agent/Judge（无需 `--repo`）：

```bash
python scripts/qa_eval/run_pipeline.py ab --no-agent --no-judge
```
## Stage 1 — Agent（`agent_runner.py`）

内置 Qwen 多轮工具 Agent，默认最多 **8 轮**（`--max-turns`）。

| 臂 | 工具 | 说明 |
|----|------|------|
| **with** | `HomegraphQuery`、`ReadFile` | 先 homegraph 检索符号，再读源码 |
| **without** | `SearchText`、`FindFiles`、`ReadFile` | rg 全文搜索 + glob 找文件 |

with 臂跑前会检查被测仓库已索引（`.homegraph/` 或 `.homegraph/`）；without 臂不需要索引。

每条 JSONL 写入字段示例：

```json
{
  "id": "R01",
  "query": "getColorString 函数在哪个文件里定义？",
  "reference_answer": "...",
  "output_answer": "---\nHomegraphQuery\nquery: getColorString\n...\n---\n\n定义在 camera/common/.../ColorUtil.ets。",
  "agent_backend": "agent-with-homegraph",
  "agent_usage": { "total_tokens": 1296 },
  "agent_duration_ms": 7830,
  "agent_memory_mb": { "peak_rss_mb": 412.5, "avg_rss_mb": 380.2 }
}
```

`agent_memory_mb` 为 Agent 进程树（含 homegraph MCP 子进程）在答题期间的 RSS 采样。

`output_answer` 中工具调用包在 `--- ... ---` 块里（与 CodeGenie 格式一致）；Judge 会自动剥掉再打分。

### Agent 日志格式（`agent-*.log`）

```
2026-06-23 09:25:21.052447 Evaluate 1:
2026-06-23 09:25:21.052571 the 1 turn
2026-06-23 09:25:22.321954 first token          ← 第一次 LLM API 返回后写入
2026-06-23 09:25:22.321954 totalTokenCount = 349
2026-06-23 09:25:27.771606 the 2 turn
2026-06-23 09:25:28.861895 totalTokenCount = 947
2026-06-23 09:25:30.102441 peakRssMb = 412.5
2026-06-23 09:25:30.102441 avgRssMb = 380.2
...
```

`stats_efficiency.py` 解析这些行得到逐题效率与**内存**。**首响应** = 从 `Evaluate N:` 到第一次 LLM API 返回的耗时；**峰值内存** = 该题进程树 RSS 峰值（MB，Linux `/proc`）。

### 外部 Agent（可选）

若用 CodeGenie / Trae 等外部 Agent 产出同格式 JSONL + 日志：

```bash
python scripts/qa_eval/run_pipeline.py ab --no-agent
# 或只重打 Judge + 报告
python scripts/qa_eval/run_pipeline.py ab --no-agent --no-judge
```

## Stage 2 — Judge 打分（`eval_metrics.py`）

```bash
python scripts/qa_eval/eval_metrics.py \
  -i scripts/qa_eval/log/result-with-builtin.jsonl \
  -o scripts/qa_eval/log/result-with-builtin-scored.jsonl \
  -w 2
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `-i` / `--input` | — | Agent 产出 JSONL |
| `-o` / `--output` | `*-scored.jsonl` | 打分结果 |
| `-w` / `--workers` | `1` | 并发线程数 |
| `-m` / `--model` | `qwen3-235b-a22b-instruct-2507` | Judge 模型 |

追加字段：`answer_accuracy_score`（0–1）、`evaluation_status`（`success` / `failed`）。

## Stage 3 — 分数统计（`stats_scores.py`）

```bash
python scripts/qa_eval/stats_scores.py \
  -i scripts/qa_eval/log/result-with-builtin-scored.jsonl
```

输出（每臂各一份）：总/成功/失败样本数，均值、中位数、最小/最大、标准差、方差，五档分数分布，评估成功率。`run_pipeline ab` 会将其并入 `report-{host}.txt`。

## Stage 4 — 效率统计（`stats_efficiency.py`）

```bash
python scripts/qa_eval/stats_efficiency.py \
  -l scripts/qa_eval/log/agent-with-builtin.log
```

输出：

- **逐题**（任务明细）：首响应、轮次、总时间、总 Token、**峰值内存 (MB)**
- **汇总**（统计结果）：任务总数、平均首响应、平均轮次、平均总时间、平均总 Token、**平均/最大峰值内存**、合计总 Token

日志缺失时回退为 JSONL 的 `agent_usage` 逐题 Token（无轮次/耗时/首响应）。

**homegraph 价值**：对比 with / without 汇总行的**平均轮次、平均总时间、平均总 Token**（汇总表同列）；轮次越少、耗时越短、Token 越少，说明 homegraph 减少了盲目 grep/read。

## `run_pipeline.py` 命令

### `ab` — A/B 全流程

```bash
python scripts/qa_eval/run_pipeline.py ab -r /path/to/your/repo [选项]
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `--repo`, `-r` | — | **被测仓库**（跑 Agent 时必填） || `--dataset`, `-d` | `data/test-set.jsonl` | 测试集 |
| `--with-jsonl` / `--without-jsonl` | `log/result-*.jsonl` | Agent 产出 |
| `--with-scored` / `--without-scored` | `log/result-*-scored.jsonl` | Judge 产出 |
| `--with-log` / `--without-log` | `log/agent-*.log` | Agent 日志 |
| `--report` | `data/report-{host}.txt` | 完整报告路径（默认随 `--agent-host`） |
| `--model`, `-m` | `qwen3-235b-a22b-instruct-2507` | Agent + Judge 模型 |
| `--workers`, `-w` | `1` | Judge 并发 |
| `--max-turns` | `8` | Agent 最多工具轮次（仅 builtin） |
| `--agent-host` | `builtin` | `builtin` / `claude-code` / `deveco-code` / `all` |
| `--homegraph-bin` | 自动检测 | 本地 `dist/bin/homegraph.js` 优先 |
| `--no-agent` | — | 跳过 Stage 1，沿用已有 JSONL |
| `--no-judge` | — | 跳过 Stage 2，沿用已有 scored |

### `score` — 单路 Judge + 统计

```bash
python scripts/qa_eval/run_pipeline.py score \
  -i scripts/qa_eval/log/result-with-builtin.jsonl \
  -l scripts/qa_eval/log/agent-with-builtin.log
```

## 测试集格式（`test-set.jsonl`）

每行一条：

```json
{
  "id": "R01",
  "query": "getColorString 函数在哪个文件里定义？",
  "reference_answer": "getColorString 定义在 camera/common/src/main/ets/utils/ColorUtil.ets。",
  "category_l1": "检索",
  "category_l2": "函数",
  "level0": "camera",
  "level1": "ColorUtil",
  "difficulty": "简单",
  "language": "ArkTS"
}
```

`category_*`、`level*`、`difficulty` 仅用于报告分组，Judge 不读取。

## 结果怎么读

### 【A/B 汇总表】— 核心对比（`report-{host}.txt` 末尾）

| 指标 | 含义 | A/B 怎么看 |
|------|------|------------|
| 准确率 均值 | Judge 给出的 `answer_accuracy_score`（0–1）全题平均 | Δ > 0 表示 with 答案质量更高 |
| 准确率 中位数 | 同上，中位数（抗极端值） | 与均值交叉验证 |
| Judge 成功/总数 | 成功打分的题数 / 总题数 | 应接近 100%；失败需查 API/JSONL |
| 平均轮次 | 每题 Agent 调用 LLM 的工具循环次数（日志 `the N turn` 的最大 N）再求平均 | **越低越好**；with 理想上更低 |
| 平均耗时 (秒) | 每题从 `Evaluate N:` 到下一题开始的端到端时间再求平均 | **越短越好** |
| 平均 Token (k) | 每题 Agent 消耗 Token（日志 `totalTokenCount` 累加）再求平均，单位 k | **越少越好** |
| 平均首响应 (秒) | 每题从 `Evaluate N:` 到第一次 LLM API 返回再求平均 | 参考项，非 homegraph 主指标 |
| 平均峰值内存 (MB) | 每题 Agent+MCP 进程树 RSS 峰值再求平均 | **越低越好**；with 不应显著高于 without |
| 最大峰值内存 (MB) | 单题 RSS 峰值的最大值 | 观察是否 OOM 风险 |

Δ 列均为 **with − without**（正数表示 with 更高/更多/更慢，视指标而定）。

### 准确率明细（每臂「准确率统计」段）

| 指标 | 含义 |
|------|------|
| `answer_accuracy_score` 均值 / 中位数 | 该臂答案质量 |
| 最小值 / 最大值 | 最差、最好单题得分 |
| 标准差 / 方差 | 分数离散程度 |
| 分数分布（五档） | 0–0.2 … 0.8–1.0 各档题数与占比 |
| 评估成功率 | 成功 Judge 数 / 总样本数 |

### 效率明细（每臂「效率明细」段）

| 粒度 | 指标 | 含义 |
|------|------|------|
| 逐题 | 首响应 | 该题第一次 LLM 返回耗时 |
| 逐题 | 轮次 | 该题 LLM 工具循环次数 |
| 逐题 | 总时间 | 该题端到端耗时 |
| 逐题 | 总 Token | 该题 Agent Token 消耗 |
| 逐题 | 峰值内存 | 该题进程树 RSS 峰值 (MB) |
| 汇总 | 平均峰值内存 / 最大峰值内存 | 内存占用汇总 |
| 汇总 | 平均首响应 / 平均轮次 / 平均总时间 / 平均总 Token | 上表逐题指标的平均值 |
| 汇总 | 合计总 Token | 该臂 20 题 Token 总和 |

### 分组与逐题（report-{host}.txt 中部）

| 区块 | 内容 |
|------|------|
| 按类别准确率 | 按 `category_l1`（检索 / 解读 / 依赖）分组的 with/without 均分与 Δ |
| 逐题对比 | 每题 ID、类别、with/without 得分与 Δ、问题与答案摘要 |
| 逐题对比末尾 | **with 更高 / 持平 / without 更高** 题数统计 |

## 常见问题

| 现象 | 处理 |
|------|------|
| Claude 准确率全 < 0.1 / `Not logged in` | Agent 未登录：`claude login` 后重跑；pipeline 现会在首题探测并 fail-fast |
| `deveco-code` exit 1 / `Model not found: glm-4-flash` | `--provider zhipu` 的模型只给 Judge/builtin；deveco 用 `deveco models` 里的 `zhipuai/...` 名，或加 `--deveco-model zhipuai/glm-4.5-flash` |
| `401` / Judge 全失败 | 检查 API Key：`DASHSCOPE_API_KEY`（DashScope）或 `ZHIPU_API_KEY`（智谱，格式 `id.secret`）；智谱请加 `--provider zhipu`，勿把智谱 Key 设到 `DASHSCOPE_API_KEY` |
| `Cannot find module 'arkanalyzer'` | `npm run build`，用 `node dist/bin/homegraph.js sync` |
| `rg not found on PATH` | `sudo apt install ripgrep`（without 臂需要） |
| 日志解析 0 条任务 | 确认 log 含 `Evaluate N:` 行 |
| 首响应全为 0 | 旧 log bug；重跑 Agent 或依赖自动回退逻辑 |
| `claude` / `opencode` 未找到 | 安装 Claude Code 或 DevEco Code，并加入 PATH |
| 内存全为 N/A | Windows 无 `/proc`，内存采样自动跳过（不影响跑题）；Linux/WSL 上才有峰值内存 || 分数偏低但答案看起来对 | 检查 `output_answer` 是否只剩工具块、无最终自然语言答案 |
| pip 慢 | 用清华镜像（见快速开始） |

## 最小通路（仅 Judge 单条）

```bash
export DASHSCOPE_API_KEY="sk-xxx"
head -1 scripts/qa_eval/log/result-with-builtin.jsonl > /tmp/one.jsonl
python scripts/qa_eval/eval_metrics.py -i /tmp/one.jsonl -o /tmp/one-scored.jsonl
python scripts/qa_eval/stats_scores.py -i /tmp/one-scored.jsonl
```
