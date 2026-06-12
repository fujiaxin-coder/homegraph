# HomeGraph

本地代码知识图谱工具，面向 AI 编程助手（Claude Code、Cursor、Codex 等）提供 MCP 服务。

在开源知识图谱能力之上，**HomeGraph 新增了对 ArkTS（HarmonyOS）的支持**，通过 [arkanalyzer](https://www.npmjs.com/package/arkanalyzer) 解析 `.ets` / `.ts` 工程中的符号、调用关系与模块结构。

数据全部保存在本机 `.homegraph/` 目录，不上传云端。

[![npm version](https://img.shields.io/npm/v/homegraph.svg)](https://www.npmjs.com/package/homegraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 快速开始

### 1. 安装 CLI

需要 **Node.js 22.5+**（推荐 22 LTS 或 24）。HomeGraph 使用 Node 内置的 `node:sqlite`，22.5 以下无法运行。

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
homegraph install            # 配置 AI 助手
homegraph init -i [path]     # 初始化并索引项目
homegraph index [path]       # 全量索引（--force 强制重建）
homegraph sync [path]        # 增量同步变更
homegraph status [path]      # 查看索引状态
homegraph query <关键词>      # 搜索符号
homegraph callers <符号>      # 谁调用了它
homegraph callees <符号>      # 它调用了谁
homegraph impact <符号>       # 修改该符号的影响范围
homegraph serve --mcp         # 启动 MCP 服务（一般由 Agent 自动拉起）
```

---

## MCP 工具

Agent 侧工具名前缀为 `homegraph_`：

| 工具 | 用途 |
|------|------|
| `homegraph_explore` | 主要工具：一次返回相关符号源码与调用关系 |
| `homegraph_search` | 按名称快速定位符号 |
| `homegraph_callers` / `homegraph_callees` | 查看调用方 / 被调用方 |
| `homegraph_impact` | 变更影响分析 |
| `homegraph_node` | 单个符号的完整源码与上下文 |
| `homegraph_files` | 已索引的文件结构 |
| `homegraph_status` | 索引健康状态 |

---

## 支持的语言

继承上游多语言 tree-sitter 解析，包括但不限于：

TypeScript / JavaScript、Python、Go、Rust、Java、C#、PHP、Ruby、C / C++、Objective-C、Swift、Kotlin、Scala、Dart、Lua、Luau、Svelte、Vue、Liquid、Pascal / Delphi 等。

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

- Node.js **22.5+**（推荐 22 LTS 或 24；使用 Node 内置 `node:sqlite`）
- 首次索引时会对项目源码做 AST 解析，大型仓库首次 `init -i` 可能需要数分钟

---

## 许可证

MIT
