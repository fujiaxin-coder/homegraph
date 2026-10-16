# 0056 — C 调用：别的文件的 static、没人打开的 ifdef


| 字段 | 内容 |
| --- | --- |
| 编号 | 0056 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-10-16 |
| 范围 | C/C++ 的 `calls` 在同名函数里选哪一个定义 |
| 关联 | [codegraph#2613](https://github.com/colbymchenry/codegraph/commit/dc4ccf6)、[#2615](https://github.com/colbymchenry/codegraph/commit/98127e5) |
| 非本 Spec | 按实参选重载、`->` / 下标 / `front()` 到元素类型、宏展开方法、特化名字、注释行当声明。那些改的是上游 `name-matcher` 里本仓没有的声明扫描，不整段搬 |


---

## 1. 背景与目标

同名 C 函数现在交给 `findBestMatch`，按同文件和目录远近打分。两个结果是错的：

1. 别的文件里的 `static` 函数，调用方看不见，但目录更近时会赢过真正的外部定义。redis 的 `mstime()` 会连到另一个文件自己的 `static mstime`。
2. 头文件里包在 `#ifdef FLAG` 里的定义，整个工程没有人 `#define FLAG`，仍然可能被选中。lua-cjson 的 `fpconv_init` 在 `fpconv.h` 里只在 `USE_INTERNAL_FPCONV` 下存在，redis 编的是 `fpconv.c`。

**目标：** 只在 C/C++ 的 `calls`、而且同名函数不止一个时收窄候选。别的语言（包括 ArkTS）的 `matchByExactName` 评分不变。

---

## 2. 范围

### 2.1 做

- 另一个文件的函数，声明行或上一行是 `static`，并且还存在非 `static` 或本文件的定义时，丢掉这个 `static`。
- C：剩下的定义里，若有的只在「工程里没人设置的功能宏」下才编译，而调用本身不是这种分支，则让位给默认会编进去的定义。判断在新文件 `c-feature-variants.ts`，只从这条收窄路径调用。
- 本文件的 `static` 保留。调用自己也在那个未设置的宏下面时，不改选。
- 清解析缓存时同时清这两处 memo。

### 2.2 不做

- 不改 `findBestMatch` 的打分，所以 ArkTS、TS、Java 等同名选择不变。
- 不搬 `cpp-includers`。被 `#include` 进来的头文件里的 `static inline`，若同时还有外部定义，会因为「别的文件的 static」被丢掉；没有外部定义时仍按原来的远近选。
- 按实参区分重载，以及接收者类型（`->`、下标、`front`/`back`/`at`）。

---

## 3. 行为

| 调用 | 候选 | 结果 |
| --- | --- | --- |
| `server.c` 调用 `mstime` | `util.c` 的 `static mstime`，`time.c` 的 `int mstime` | `time.c` |
| `quicklist.c` 在 `#ifdef REDIS_TEST` 里调用自己的 `static mstime` | 本文件 static，加上 `time.c` 的外部定义 | 本文件 |
| `lua_cjson.c` 调用 `fpconv_init` | `fpconv.h` 在没人设置的 `USE_INTERNAL_FPCONV` 下，`fpconv.c` 无条件 | `fpconv.c` |
| ArkTS 两个同名函数 | 与改动前相同，不走 C 的 static / ifdef 规则 | 仍由 `findBestMatch` 决定 |

---

## 4. 验收标准

- [x] Spec 落盘（本文件）
- [x] 单测覆盖上表四行
- [x] CHANGELOG Unreleased

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 把合法的跨文件 static 调用丢掉 | 只在还有非 static 或本文件定义时丢；源码读不到则不当成 static |
| 功能宏扫描读到无关文件 | 只在 C 的同名函数收窄时调用，且调用点自己也在该分支下时不让位 |

回滚：去掉 `matchByExactName` 里的 `narrowCCallTargets`。
