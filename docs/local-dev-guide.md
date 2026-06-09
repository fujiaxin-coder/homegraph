# 本地构建与使用指南

从源码构建 HomeGraph，用 **CLI** 或 **Cursor MCP** 索引、查询工程；文末附 Harmony 工程（`.ets` + C++）跨语言验证示例。

---

## 1. 构建

```bash
cd /path/to/homegraph
npm ci          # 首次或 lock 变更
npm run build   # → dist/（含 WASM、schema）
```

要求 Node **20.x – 24.x**。

后续命令用变量指向本地构建（路径按实际修改）：

```bash
export CG="node ./homegraph/dist/bin/homegraph.js"
$CG --version
```

---

## 2. CLI 使用

### 2.1 索引工程

```bash
# 设置环境变量 PROJECT，指定待分析的工程根目录
export PROJECT=./project

# 首次：初始化并全量索引
$CG init "$PROJECT"

# 已初始化：全量重索引（改 extraction / arkts 后必跑）
$CG index "$PROJECT"

# 增量同步（日常）
$CG sync "$PROJECT"

# 状态
$CG status "$PROJECT"
```

数据在项目根 `.homegraph/homegraph.db`

`.ets` 解析若 Scene 失败，可设 `export OHOS_SDK_HOME=/path/to/sdk`。

### 2.2 查询符号

```bash
# 全文搜索
$CG query setCropRect -p "$PROJECT"
$CG query Asset_setCropRect -p "$PROJECT" --limit 20

# 按类型过滤
$CG query Greeter -p "$PROJECT" --kind class

# JSON 输出（脚本友好）
$CG query setCropRect -p "$PROJECT" --json
```

### 2.3 调用关系

```bash
# 谁调用了这个符号
$CG callers setCropRect -p "$PROJECT"

# 这个符号调用了谁
$CG callees setCropRect -p "$PROJECT"

# 改动影响面
$CG impact setCropRect -p "$PROJECT" --depth 2
```

### 2.4 文件与上下文

```bash
# 已索引文件树
$CG files -p "$PROJECT" --filter imageEditor/common

# 为 AI 任务打包上下文（文本/markdown）
$CG context "Asset.setCropRect 如何调用 C++" -p "$PROJECT"
```

### 2.5 安装到 Agent（可选）

```bash
$CG install --target cursor --location global -y
$CG install --print-config cursor --location global   # 仅预览，不写文件
```

---

## 3. Cursor MCP

CLI 适合脚本与快速自检；Cursor 适合自然语言 + 多步推理。

### 3.1 配置

1. 本地homegraph项目根目录安装 MCP 条目：`$CG install --target cursor --location global -y`
2. 编辑 `~/.cursor/mcp.json`，示例如下：

```json
{
  "mcpServers": {
    "homegraph": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/home/you/code/homegraph/dist/bin/homegraph.js",
        "serve",
        "--mcp",
        "--path",
        "${workspaceFolder}"
      ]
    }
  }
}
```

3. Reload Window → Settings → Tools & MCPs 显示homegraph已经安装且打开 -> 确认已连接
4. **打开被测工程**为工作区根，新开 Agent 会话

### 3.2 提问示例

```
图片编辑器里，ArkTS 的 Asset.setCropRect 是怎么调用到 native C++ 的？
最终是哪个 C++ 函数处理裁剪？请给出 .ets 和 .cpp 的完整调用链。
```

可带符号名帮助 `homegraph_explore`：`setCropRect Asset_setCropRect SetCropRect napi_adapter`

---

被测工程示例：`applications_photos`（含 `imageEditor/.../ets/` 与 `.../cpp/`）。

### 4.1 CLI 自检

两种语言都入库：

```bash
$CG query setCropRect -p "$PROJECT"        # 应命中 Asset.ets 等
$CG query Asset_setCropRect -p "$PROJECT"   # 应命中 napi_adapter.cpp 等
```

进一步看调用方/被调方：

```bash
$CG callers setCropRect -p "$PROJECT"
$CG callees Asset_setCropRect -p "$PROJECT"
```

### 4.2 Cursor / Agent 通过标准

| 通过 | 失败 |
|------|------|
| `Asset.ets` → `sdk.Asset_setCropRect` | 只有 ets 或只有 cpp |
| `napi_adapter.cpp` 的 NAPI 入口 | 两种语言无 NAPI 连接 |
| C++ 实现（如 `Asset::SetCropRect`） | 全靠 Read/Grep 拼路径 |

预期链（对照用）：

1. `.../ets/service/Asset.ets` — `setCropRect()`
2. `.../ets/service/native.ts` — `libImageEditor.so`
3. `.../interface/napi_adapter.cpp` — `Asset_setCropRect`
4. C++ 实现层 — `Asset::SetCropRect` / 相关 Command 类

### 4.3 改完 HomeGraph 后

```bash
cd /path/to/homegraph && npm run build
$CG index "$PROJECT"    # 重索引
# Cursor 用户：Reload MCP
```

---

## 5. 常见问题

| 现象 | 处理 |
|------|------|
| `install cursor` 报 *too many arguments* | 用 `install --target cursor` |
| MCP *not initialized* | 加 `--path ${workspaceFolder}`；工作区打开被测工程 |
| CLI *not initialized* | 对被测目录执行 `init` 或 `index` |
| 搜不到 `.ets` | 重跑 `index`；确认有 `.ets` 且未 ignore |
| MCP 仍用旧逻辑 | mcp.json 指向最新 `dist/bin/homegraph.js` 并 Reload |

---

## 6. 一键清单

```bash
export CG="node ~/code/homegraph/dist/bin/homegraph.js"
export PROJECT=~/code/applications_photos

cd ~/code/homegraph && npm run build
$CG index "$PROJECT"
$CG status "$PROJECT"
$CG query setCropRect -p "$PROJECT"
$CG query Asset_setCropRect -p "$PROJECT"

# 可选：Cursor MCP
$CG install --target cursor --location global -y
# 编辑 ~/.cursor/mcp.json → node + dist 绝对路径（见 §3.1）
```

---

## 相关

- [HomeGraph 原理与实现](homegraph-principles.md)
- [CLI 参考（发布版）](https://homegraph.dev/homegraph/reference/cli/)
