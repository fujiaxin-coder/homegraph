# 0047 — 活性看门狗默认关；daemon 空闲退出与建图门闩


| 字段 | 内容 |
| --- | --- |
| 编号 | 0047 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-21 |
| 范围 | 主线程活性看门狗默认关闭；daemon idle 默认 60s；refcount=0 且建图中则延后 idle |
| 关联 | Spec 0046（daemon.log）；#850 活性看门狗；#411 daemon；DevEco 多窗口同工程 |
| 非本 Spec | 改 DevEco Code；禁 daemon（`HOMEGRAPH_NO_DAEMON`）；改 PPID/stdin 宿主收尸 |


---

## 1. 背景与目标

DevEco 同工程多窗口共享 daemon。现场问题：

1. **60s 活性看门狗**在并发 init / CPU 打满时误杀健康进程；产品侧收益低。  
2. daemon **idle 默认 300s**，且最后一扇窗关掉时若仍在建图，不应按普通 idle 直接退掉未完成索引。

**目标：**

- 活性看门狗 **默认不装**；显式 `HOMEGRAPH_WATCHDOG=1` 才启用（`HOMEGRAPH_NO_WATCHDOG=1` 仍强制关）。  
- **有 client（refcount>0）永不因 idle / 建完图退出。**  
- **refcount=0**：若 `building_fast` / `indexing` → 等建图结束；已稳定后再 **默认 60s** idle 无新连接才退。

---

## 2. 范围

### 2.1 做

1. `installMainThreadWatchdog`：默认返回 null；仅当 `HOMEGRAPH_WATCHDOG` 为真且未设 `HOMEGRAPH_NO_WATCHDOG` 时武装。不影响 file watcher / 增量 sync。  
2. `HOMEGRAPH_DAEMON_IDLE_TIMEOUT_MS` 默认改为 **60000**（仍可用 env 覆盖；`0` = 永不 idle 退）。  
3. `armIdleTimer` 路径：  
   - `clients.size > 0` → 不退出；  
   - 建图进行中 → **不 `stop`**，短间隔轮询，直至非进行中且仍无 client，再重新武装完整 idle；  
   - 非建图且无 client → idle 到期 `stop('idle timeout')`。  
4. 建图进行中判定：`build_phase ∈ { building_fast, indexing }`（不含日常 watch 增量）。  
5. 单测 + CHANGELOG。

### 2.2 不做

- 删除看门狗代码路径（保留 opt-in）  
- 改 max-idle backstop / client liveness sweep 语义（可并存）  
- DevEco 侧 env 注入  

---

## 3. 行为摘要

| 条件 | 行为 |
| --- | --- |
| 默认 | 不装活性看门狗 |
| `HOMEGRAPH_WATCHDOG=1` | 装（除非 `HOMEGRAPH_NO_WATCHDOG=1`） |
| refcount ≥ 1 | daemon 保持；disarm idle |
| refcount = 0 且建图中 | 延后退出，轮询至建图结束 |
| refcount = 0 且已稳定 | 默认 60s 后再退 |

---

## 4. 验收标准

- [x] Spec 落盘  
- [x] 看门狗默认关；opt-in 单测  
- [x] idle 默认 60s；建图门闩单测  
- [x] CHANGELOG Unreleased  

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 真主线程死锁不再自愈 | 产品可接受；opt-in 仍可开 |
| 建图卡死导致 daemon 永不 idle | 既有 max-idle backstop / 人工杀进程；建图失败会落到 fast/full |

回滚：恢复默认武装看门狗与 300s idle 即可。
