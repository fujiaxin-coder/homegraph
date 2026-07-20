# HomeGraph

本地代码知识图谱工具，面向 AI 编程助手（Claude Code、Cursor、Codex 等）提供 MCP 服务。

在开源知识图谱能力之上，**HomeGraph 新增了对 ArkTS（HarmonyOS）的支持**，通过 [arkanalyzer](https://www.npmjs.com/package/arkanalyzer) 解析 `.ets` / `.ts` 工程中的符号、调用关系与模块结构。

数据全部保存在本机 `.homegraph/` 目录，不上传云端。

[![npm version](https://img.shields.io/npm/v/homegraph.svg)](https://www.npmjs.com/package/homegraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 快速开始

### 1. 安装 CLI

需要 **Node.js 20+**（推荐 22 LTS 或 24）。索引库优先用 `better-sqlite3`（原生），装不上时回退到 `node-sqlite3-wasm`。

```bash
npm install -g homegraph
```

若在 Linux/WSL 遇到 `EACCES` 权限错误，可任选其一：

```bash
# 临时
sudo npm install -g homegraph

# 或把全局目录改到用户家目录（推荐）
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
npm install -g homegraph
```

验证：

```bash
homegraph --version
```

### 2. 接入 AI 助手

在新终端中运行交互式安装器，自动写入各 Agent 的 MCP 配置：

```bash
homegraph install
```

#### 支持的 Agent 与 `--target` 取值

| Agent | `--target` |
|-------|------------|
| Claude Code | `claude` |
| Cursor | `cursor` |
| Codex CLI | `codex` |
| opencode | `opencode` |
| DevEco Code | `deveco` |
| CodeBuddy | `codebuddy` |
| Hermes Agent | `hermes` |
| Gemini CLI | `gemini` |
| Antigravity IDE | `antigravity` |
| Kiro | `kiro` |

`--target` 还支持特殊取值：

| 取值 | 说明 |
|------|------|
| `auto` | 自动检测本机已安装的 Agent（`--yes` 默认值） |
| `all` | 写入全部 Agent |
| `none` | 不写入任何 Agent 配置 |

安装位置 `--location`：

- `global` — 写入用户目录，对所有项目生效（`--yes` 默认值）
- `local` — 仅写入当前项目目录

> Codex CLI、Hermes Agent、Antigravity IDE **仅支持** `--location=global`；选 `local` 时会被跳过。

#### 非交互式示例

```bash
# 自动检测已安装 Agent 并全局安装
homegraph install --yes

# 同时为 Cursor 和 DevEco Code 写入全局 MCP 配置
homegraph install --target=cursor,deveco --location=global --yes

# 单个 Agent
homegraph install --target=claude --location=global --yes      # Claude Code
homegraph install --target=cursor --location=global --yes      # Cursor
homegraph install --target=codex --location=global --yes       # Codex CLI
homegraph install --target=opencode --location=global --yes    # opencode
homegraph install --target=deveco --location=global --yes      # DevEco Code
homegraph install --target=codebuddy --location=global --yes   # CodeBuddy
homegraph install --target=hermes --location=global --yes      # Hermes Agent
homegraph install --target=gemini --location=global --yes      # Gemini CLI
homegraph install --target=antigravity --location=global --yes # Antigravity IDE
homegraph install --target=kiro --location=global --yes        # Kiro

# 写入全部 Agent（全局）
homegraph install --target=all --location=global --yes

# 项目级安装（仅对当前项目生效，如 ./.cursor/mcp.json）
homegraph install --target=cursor --location=local --yes
homegraph install --target=claude,cursor --location=local --yes
```

安装完成后**重启对应 Agent**，使 MCP 配置生效。

### 3. 初始化项目

```bash
cd your-project
homegraph init -i
```

- `homegraph init`：仅创建 `.homegraph/` 索引目录  
- `homegraph init -i`：创建目录并立即建立索引（推荐）

索引建立后，Agent 可通过 MCP 工具查询符号、调用链、影响范围等。

### 卸载

```bash
homegraph uninstall          # 从各 Agent 移除 MCP 配置
homegraph uninit             # 删除当前项目的 .homegraph/ 索引
```

---

## 常用命令

```bash
homegraph install              # 配置 AI 助手
homegraph init -i [path]       # 初始化并索引项目
homegraph index [path]         # 全量索引（--force 强制重建）
homegraph sync [path]          # 增量同步变更
homegraph status [path]        # 查看索引状态
homegraph query <关键词>        # 搜索符号
homegraph explore <查询>        # 探索区域（与 MCP homegraph_explore 相同输出）
homegraph node <符号或文件>      # 读取符号/文件（与 MCP homegraph_node 相同输出）
homegraph files                # 已索引文件树
homegraph callers <符号>        # 谁调用了它
homegraph callees <符号>        # 它调用了谁
homegraph impact <符号>         # 修改该符号的影响范围
homegraph affected [files...]  # 根据变更文件查找受影响的测试（支持 --stdin）
homegraph spec build           # 从已有 .spec 目录（或用户指定目录）构建Spec知识图谱（Commit4Spec）
homegraph spec mine            # 从 Git 历史挖掘设计Spec文档（AST 分析 + LLM 聚类生成）
homegraph spec match <文本>     # 全文搜索相似历史Spec
homegraph spec find <文件>      # 查找与指定文件关联的Spec
homegraph spec trace <符号>     # 追溯代码符号关联的设计Spec
homegraph spec stats           # 查看Spec知识图谱统计
homegraph spec evolve install  # 安装 post-commit 钩子（默认累计 3 次提交后触发演进）
homegraph spec evolve uninstall# 移除 post-commit 钩子
homegraph spec evolve process  # 手动触发一次Spec演化
homegraph serve --mcp           # 启动 MCP 服务（一般由 Agent 自动拉起）
```

`explore` / `node` 等命令与同名 MCP 工具共享同一套输出，适合没有 MCP 的子 Agent 或脚本直接调用。

---

## MCP 工具

Agent 侧工具名前缀为 `homegraph_`。

**暴露规则：** 默认注册全部工具。索引文件数 **少于 500** 的小项目会自动收缩为三个核心工具（`explore` / `search` / `node`）。可通过环境变量 `HOMEGRAPH_MCP_TOOLS`（逗号分隔短名，如 `explore,node`）自定义暴露列表。

**跨项目查询：** 所有工具均支持可选参数 `projectPath`（绝对路径），用于在 monorepo 中查询子项目，或当 MCP 服务器根目录没有索引时指定目标项目。

| 工具 | 用途 |
|------|------|
| `homegraph_explore` | **主工具**：一次调用返回相关符号的完整源码、调用路径与影响范围；支持自然语言问题或符号/文件名列表 |
| `homegraph_search` | 按名称快速搜索符号（仅返回位置，不含源码） |
| `homegraph_node` | 读取单个符号或整个文件的源码（带行号）及调用关系；可替代 Read 读文件 |
| `homegraph_callers` / `homegraph_callees` | 查看调用方 / 被调用方 |
| `homegraph_impact` | 变更影响分析（重构前使用） |
| `homegraph_files` | 已索引的文件树（支持 glob 过滤、按语言分组） |
| `homegraph_status` | 索引健康状态（调试用） |
| `homegraph_spec_match` | 将新需求描述与 Commit4Spec 知识图谱做全文匹配，返回相似历史Spec及关联提交与代码片段 |
| `homegraph_spec_find` | 根据文件路径反向查找关联的Spec |
| `homegraph_spec_trace` | 将代码符号追溯回关联的设计Spec |

### Commit4Spec（Spec知识图谱）

Commit4Spec 提供两条互补路径将设计Spec与 Git 历史关联，存入 `.homegraph/commit4spec/commit4spec.db`：

**路径 1：`spec build`（已有Spec导入）**

从项目已有的 `.spec` 目录（或用户指定目录）读取Spec文档，解析其中的 Git 引用和变更片段，直接构建知识图谱节点与关系。

**路径 2：`spec mine`（Spec逆向挖掘）**

从 Git 历史中自动提取设计Spec，基于模型生成对应 `.spec` 文档，进而构建知识图谱节点与关系。

支持增量模式（`meta.json` 记录已处理范围）、commit过滤和聚类输出模式（`--skip-llm`）。

`spec mine`逆向挖掘和`spec evolve process`演化更新涉及到模型访问，需用户自主配置模型服务，编辑配置文件`.homegraph/commit4spec/configs.json`

```json
// All available options (fields marked * are required):
{
  "llm": {
    "provider":     "openai",          // * "openai" or "anthropic"
    "apiKey":       "sk-...",          // * API key string (plain text)
    "apiKeyEnv":   "OPENAI_API_KEY",   //   or read from env var (takes precedence)
    "model":        "gpt-4o",          // * model name (e.g. gpt-4o, claude-3-5-sonnet)
    "baseUrl":      "https://...",     //   custom endpoint (proxies / local models)
    "temperature":  0.2,               //   creativity control (default: 0.2)
    "maxTokens":    20000              //   max output tokens (default: 20000)
  }
}
```

**查询与分析：**

```bash
homegraph spec match "用户登录"    # CLI/MCP 全文搜索
homegraph spec find src/auth.ts   # 哪些Spec涉及该文件
homegraph spec trace UserService  # 追溯符号关联的设计Spec
```

---

## 支持的语言

继承上游多语言 tree-sitter 解析，包括但不限于：

TypeScript / JavaScript、Python、Go、Rust、Java、C#、PHP、Ruby、C / C++、Objective-C、Swift、Kotlin、Scala、Dart、Lua、Luau、R、Svelte、Vue、Astro、Liquid、Razor、Pascal / Delphi 等。

**HomeGraph 新增：**

| 语言 | 扩展名 | 说明 |
|------|--------|------|
| **ArkTS** | `.ets` 等 | 基于 arkanalyzer，支持 HarmonyOS 工程的类、方法、导入与调用关系提取 |

---

## 从源码构建

适用于开发或二次修改：

```bash
git clone <your-repo-url>
cd homegraph          # 仓库目录名可仍为 homegraph
npm install
npm run build
npm run cli -- --help # 或直接：node dist/bin/homegraph.js --help
npm test              # 运行测试
```

本地调试 CLI：

```bash
npm run cli
# 等价于 npm run build && node dist/bin/homegraph.js
```

---

## 手动配置 MCP（可选）

以 Claude Code 为例，在 `~/.claude.json` 中添加：

```json
{
  "mcpServers": {
    "homegraph": {
      "type": "stdio",
      "command": "homegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

Cursor 等项目级配置写入 `./.cursor/mcp.json`，格式相同。推荐使用 `homegraph install` 自动完成。

---

## 上游同步

| 项目 | 说明 |
|------|------|
| 上游 | 持续同步 colbymchenry 开源知识图谱项目 main 分支 |
| 包名 / CLI | `homegraph`（npm：`npm install -g homegraph`） |
| 数据目录 | `.homegraph/` |
| 主要差异 | 新增 **ArkTS** 语言支持与相关索引逻辑 |

---

## 环境要求

- Node.js **20+**（推荐 22 LTS 或 24；SQLite 优先 better-sqlite3，回退 wasm）
- 首次索引时会对项目源码做 AST 解析，大型仓库首次 `init -i` 可能需要数分钟
- WSL2 下若项目位于 Windows 盘符（`/mnt/c` 等）且 MCP 连接不稳定，可设置 `HOMEGRAPH_NO_DAEMON=1` 跳过共享后台服务，每个会话独立运行

---

## 许可证

MIT
