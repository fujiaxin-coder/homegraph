# 0048 — Harmony 能力配置入库 + 文案绑定 + 模块清单 + 接缝摘要


| 字段 | 内容 |
| --- | --- |
| 编号 | 0048 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-22 |
| 范围 | 五条信息补强（无路由打分改动）：form / shortcuts 配置；string 绑定锚点；HAR 模块清单；命中接缝摘要；单测与 CHANGELOG |
| 关联 | Spec 0039–0042、0044；codingeval 079：091 Form、018 shortcuts、文案题、107 加模块、151 stub Service |
| 非本 Spec | 改 explore 路由权重 / 合成 nav 边；1.4 project Unknown；patch 剔 `.homegraph`；MCP 关库锁 |


---

## 1. 背景与目标

079 未过里一批题不是「路由算错」，而是**图里缺配置事实 / 文案不够落地 / 模块边界不清 / 命中后仍海读**。本 Spec 只补信息，不改 call-path 打分。

**目标（五条，按序）：**

1. **服务卡片 / Form 配置**进图；题面要卡片但工程没有时给出**负向证据**（禁止只甩 SDK `.d.ts`）。
2. **桌面快捷方式** `shortcuts_config` + `module.json5` metadata 进图并可被 explore/project 直接指路。
3. **文案 Resource hits** 在键值之外附带仓内 `$r('app.string.<key>')` **绑定锚点**（有则写），减少整表 Read。
4. **`homegraph_project` HAR/多模块清单**：模块根、oh-package、本地 `file:` 依赖，便于仿建兄弟模块。
5. **命中后接缝摘要**：同模块能力 profile 路径 + 明显空实现 stub 一行提示（每锚点 ≤3 行）。

**例子：**

| # | 题 | 成功长什么样 |
| --- | --- | --- |
| 1 | 091 服务卡片 | explore 给出 `form_config.json` / FormExtension；若无则写「工程内无 form_config」 |
| 2 | 018 长按快捷入口 | 直接给出 `shortcuts_config.json` + metadata 注册处 |
| 3 | 018/091 文案断言 | Resource hits 含键值 + 引用该 `$r` 的 `.ets:line`（有索引命中时） |
| 4 | 107 加日常工具模块 | project 列出 `module_compass` 等 HAR 与 `file:` 依赖 |
| 5 | 151 播放按钮 | 命中 `MediaService.play` 时标 stub/空实现，少海读 UI |

---

## 2. 范围

### 2.1 做

#### 1 — Form / 服务卡片配置 + 负向证据

- 白名单 basename：`form_config.json`（`isSourceFile` / `detectLanguage` → `yaml`，同 0039/0041）。
- `arkts-entry`：
  - 解析 `forms[]` 的 `name`（缺则跳过该条）；每条 → `constant`（或等价轻量节点）：`id=harmony-form:<rel>:<name>`，`docstring`/`signature` 标明 form profile；**不抽控件边**。
  - `module.json5`：`extensionAbilities` 中 `type === "form"`（或 metadata `ohos.extension.form` + `$profile:form_config`）→ 记录 Ability 名、`srcEntry`、profile 引用（`route` 或 `constant`，带 `filePath=module.json5`）。
- explore：query/题面匹配 `form_config` / `FormExtension` / `服务卡片` / `卡片`（大小写不敏感，中英文）时：
  - **有**索引命中 → 文首 **Capability profiles** 短表（路径 + form/ability 名，cap≤8）。
  - **无** → 文首负向一行：`No in-repo form_config / FormExtensionAbility (do not treat SDK .d.ts as project wiring).`
- 幂等：已有 `**Capability profiles**` / 已有该负向句不再叠。

#### 2 — 桌面快捷方式 profile

- 白名单 basename：`shortcuts_config.json`。
- `arkts-entry`：解析 `shortcuts[]` 的 `shortcutId` + `label`（字符串或 `$string:` 原样）；可选 `wants[0].abilityName` 写入 signature；节点 `id=harmony-shortcut:<rel>:<id>`。
- `module.json5`：metadata `name` 为 `ohos.ability.shortcuts` **或** 含 `shortcuts_config`，且 `resource` 含 `$profile:` → 记录注册点（路径 + ability 上下文若可解析）。
- explore：query 匹配 `shortcuts_config` / `shortcuts` / `快捷方式` / `长按` / `快捷入口` 时走同一 **Capability profiles** 短表（与 Form 共用表头，分行标注 `form` / `shortcut`）。
- `homegraph_project` 资源清单：将 `form_config.json` / `shortcuts_config.json` 从「塞进 rawfile」改为独立 **`capability profiles`** 行（路径列表）。

#### 3 — string.json Resource hits 附绑定锚点

- 在现有 Spec 0041 `formatHarmonyResourceHits` 上：对每个命中 key，在图内找 **至多 2 个** `.ets` 符号/文件证据，其 `signature` / `docstring` / 名侧文本含 `app.string.<key>` 或 `$r('app.string.<key>')`（或 FTS/`searchNodes` 等价召回）。
- 行格式示例：  
  ``- `…/string.json:12` — "提交订单" → `submit_order` · bound `Index.ets:5` · Grep `$r('app.string.submit_order')` ``  
  无绑定则保持 0041 原 Grep 指引（不发明行号）。
- 不新增 string→控件边；不索引 color/media。

#### 4 — HAR / 多模块清单（project）

- `homegraph_project` 在模块列表之后（资源清单之前或之后，有则写）追加：

```markdown
### Module roster
- `module_compass` (`libs/module_compass`) · harmony · oh-package `@ohos/module_compass` · deps: `file:../module_clock`, …
```

- 数据来源：已有 project map 模块 + 各模块根 `oh-package.json5` 的 `name` 与 `dependencies` 中 **本地** `file:` / `../` 项（npm 远端包可省略或 cap）。
- `includeFiles=false` 时**仍输出**；解析失败则跳过该模块，不让整个 project 失败。

#### 5 — 命中接缝摘要

- explore 成功路径上，对**已进入本轮 emission 的锚点文件/主符号**（有 cap，建议 ≤6 锚点）追加 **Seam notes**（文首或 Registration/Resource 之后）：
  - 同 Harmony 模块下若存在已索引 `form_config` / `shortcuts_config` / route profile → 一行路径。
  - 主符号体（若可得源码切片）判定为 **stub**：体行数少且实质只有 `return` / `hilog` / `console` / 空块 → 一行 ``stub: `MediaService.play` @path:line``。
- 每锚点合计 ≤3 行；无则省略整节。

### 2.2 不做

- 不改 explore 对 RouterUtils vs 业务页的排序权重  
- 不合成新的 arkui-nav / form→UI 边  
- 不修 codingeval patch / WinError 锁库  
- 不要求 `homegraph_search` 单独改描述（走同一批节点即可）

---

## 3. 行为与约束

| 输入 | 行为 |
| --- | --- |
| 标准 form_config / shortcuts_config | 入库；explore 可 Capability profiles |
| 卡片题且仓内无 Form 配置 | 负向证据，非 SDK 冒充 |
| string 命中且 .ets 有 `$r` 痕迹 | Resource hits 带 bound |
| 多 HAR 工程 project | Module roster 含本地 deps |
| 空实现方法被 explore 命中 | Seam notes stub |

**约束：** 禁止为本 Spec 新增「半截」业务 call 边；短表只定位，不替代编辑时的 Read。

---

## 4. 验收标准

- [x] Spec 落盘；五条均有单测覆盖（fixture index 和/或纯函数）
- [x] `form_config.json` / `shortcuts_config.json` 可 `isSourceFile`；非白名单 json 仍忽略
- [x] fixture：form/shortcut 节点入库；卡片类 query 有 profiles 或负向句；快捷类 query 有 shortcuts 路径
- [x] Resource hits 在有 `$r` 证据时含 `bound`
- [x] `homegraph_project` 含 `Module roster`（多模块 fixture）
- [x] Seam notes：stub fixture 出现 `stub:`
- [x] `SERVER_INSTRUCTIONS` / explore·project 工具描述各补一句（能力 profile + roster + seams）
- [x] CHANGELOG `[Unreleased]`；实现后 Spec → 已完成（commit 另发）

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| profile schema 私有字段 | 缺字段跳过；不猜边 |
| Resource bound 误匹配 | 精确子串 `app.string.<key>`；每 key ≤2 |
| roster / seams 噪声 | cap + 无则省略 |
| 负向句误伤真有 Form 的仓 | 仅在零命中时发 |

回滚：去掉白名单与 extract 分支、Capability/负向/roster/seams 挂载、instructions 复原。

---

## 6. 非目标

- color / media FTS  
- 路由偏置与 Miss 同义扩召回  
- daemon 关库 / `.homegraph` 出 patch  
