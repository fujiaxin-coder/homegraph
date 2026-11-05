# 0067 — CLI `api-kg`：本机鸿蒙 API 图谱构建（替代 `index-api`）

| 字段 | 内容 |
| --- | --- |
| 编号 | 0067 |
| 类型 | 需求 |
| 状态 | 已完成 |
| 日期 | 2026-11-05 |
| 范围 | CLI `api-kg`（`index-api` 同形兼容别名）；`resolveOhosApiKg` / `@ohos.*.d.ts` 命中门闸；仓内引用与单测；CHANGELOG |
| 非本 Spec | `--all` 全量多版本；改 MCP 工具面；改 `init`/`index` 自动 ATTACH 策略本身；GitHub Release 循环逻辑（仍用 `scripts/ohos-sdk-publish.mjs`） |

---

## 1. 背景与目标

需要一条**可单独使用**的命令：装好 homegraph 后在任意目录（不必在鸿蒙工程内）从本机 DevEco/OHOS SDK 构建 API 声明图谱 DB。旧命令 `index-api <input> [version] [-o]` 强制给 SDK 输入路径，且未统一「版本从哪来、为何选用、SDK 是否真有 API 声明」。

**目标：**

- 命令形如：`homegraph api-kg <output> [version] [--sdk <path>]`
- `output` 必填；`version` / `--sdk` 可选
- 无工程上下文时也能靠 env / 本机 SDK 安装路径解析
- 选用版本时打印 **version + reason + sdkHome**
- 候选 SDK 必须扫到至少一个 `@ohos.*.d.ts` 才算命中，否则跳过找下一个
- 仓内凡引用旧 `index-api` 用法 / 文案的同步改到新命令；`index-api` 保留为**同参数形状**的兼容别名（破坏旧的 `<input>` 首位参数语义，CHANGELOG 标明）

---

## 2. 范围

### 2.1 做

- 新增 `resolveOhosApiKg`（及 `@ohos.*.d.ts` 扫描辅助）：解析 `output` / 可选 version / 可选 sdk，返回 `{ sdkHome, version, versionReason, outputPath, apiDtsTrigger, cleanup? }`
- CLI：`api-kg` + 别名 `index-api`；缺 `output` 由 commander 报 usage；解析失败非 0 退出并说明
- 版本探测优先级（standalone 优先，工程仅为弱兜底）：
  1. 显式 `[version]`
  2. `HOMEGRAPH_OHOS_API_VERSION`
  3. `--sdk` / `HOMEGRAPH_OHOS_SDK` / `OHOS_SDK_HOME` / `DEVECO_SDK_HOME` / `HOS_SDK_HOME` 指向树 → 要求 `@ohos.*.d.ts`，版本优先读 SDK `platformVersion`（若已有显式/env 版本则用作选用约束；与 `platformVersion` 不一致时 **warn** 仍以显式/env 为准，或在仅 SDK 源时用 `platformVersion`）
  4. 扫本机常见安装路径的候选（同样要过 `@ohos.*.d.ts` 门闸）；唯一则用；多个有版本时取**字典序最大**并 reason 标明 auto-newest；多个且无法定夺则报错列出候选
  5. （弱）cwd 存在 `build-profile.json5` 时用 `compileSdkVersion`，再匹配已发现且通过门闸的 SDK
- 构建仍复用 `indexOhosApiDb`
- 单测覆盖：门闸命中/未命中跳过、版本 reason、缺参/无候选失败、显式 version 覆盖
- 更新报错文案与 `scripts` 侧如有 CLI 引用；库调用可继续 `resolveOhosSdkInput` + 门闸（`resolveOhosSdkInput` / 本地 discover 也只接受含 `@ohos.*.d.ts` 的 home）

### 2.2 不做

- 不加 `--all`
- 不查 `hdc` 设备 `apiversion`
- 不改 npm 发包 job 的 for-dir 循环（已有）

---

## 3. 行为

| 场景 | 结果 |
| --- | --- |
| `api-kg <output>`，本机唯一合法 SDK | 构建到 `<output>`；打印 version、reason、sdkHome |
| `api-kg <output> 6.0.1` | 选用匹配 6.0.1 且含 `@ohos.*.d.ts` 的 SDK；reason=`explicit` |
| `api-kg <output> --sdk <tools>` | 从该树解析；无 `@ohos.*.d.ts` → 失败 |
| 候选仅有 `openharmony/ets` 但无 `@ohos.*.d.ts` | 视为未命中，继续其他候选；全无则失败 |
| `HOMEGRAPH_OHOS_API_VERSION` 与 SDK `platformVersion` 不一致 | warn；以 env/显式 version 为 db 版本标签 |
| 缺少 `<output>` | commander usage / 非 0 |
| `index-api <output> [version]` | 与 `api-kg` 同形同行为 |

### 3.1 `@ohos.*.d.ts` 门闸

在 `sdkHome/openharmony/ets`（及已列出的 ets root）下递归查找**文件名**匹配：以 `@ohos.` 开头（大小写敏感前缀）且以 `.d.ts` 结尾（大小写不敏感扩展名）。命中任意一个即通过；返回相对 ets root 的路径供日志。

---

## 4. 验收

- [x] Spec 落盘
- [x] `resolveOhosApiKg` + `@ohos.*.d.ts` 门闸；discover/`resolveOhosSdkInput` 同步门闸
- [x] CLI `api-kg` / 别名 `index-api`；仓内文案与引用同步
- [x] 单测通过（门闸、reason、失败路径）
- [x] CHANGELOG `[Unreleased]` 有条目
