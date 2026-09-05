# DSH-P2M（A 插件）设计文档

> 配套阅读：`AGENTS.md`（环境事实锁定）、`README.md`（对外说明）。
> 状态：v1 设计定稿。本文件是实现的唯一事实来源，改动需同步更新。

---

## 1. 背景与目标

DSH（DeepSeek Harness）是跑在 Cordis 4.0.2 上的个人 AI 服务台；它用 npm 包 + `cordis.patch.yml`（loader 补丁）承载第三方插件（下称"插件"）。插件多了以后出现三类痛点：

1. **没有统一管理**：插件散在 bundle 栈里，启停/禁用靠手改 patch 文件或 dsh-safe 启动期"熔断"。
2. **冲突只能被动熔断**：坏插件在**启动期**由 `dsh-safe.mjs` 逐次隔离，运行期冲突（apply 失败、服务重名、同 id 配置互踩）没有检测、没有裁决、没有回滚记录。
3. **没有优先级概念**：谁该保护、冲突时牺牲谁、维护时先看谁，全靠感觉。

DSH-P2M（简称 **A 插件 / p2m**）是一个 Cordis 插件 + 配套启动器的组合，目标：

- **统一管理**：枚举、启停、禁用、隔离、恢复其他插件，一处决策、持久生效。
- **冲突处理**：检测（启动期归因 + 运行期事件 + 静态扫描）→ 按优先级裁决 → 隔离 → 可回滚、留痕。
- **优先级机制**：恒定 `DSH 本体 > A 插件 > 其他插件`；其他插件按**累计使用时长**动态排序（如 B 时长超 C，则维护优先级变为 `DSH > A > B > C > …`）。

---

## 2. 关键机制事实（本机源码实测，非猜测）

| # | 事实 | 出处 | 对设计的影响 |
| --- | --- | --- | --- |
| F1 | 插件入口 = loader entry，`EntryOptions{id,name,config,group,disabled,inject}` | `cordis-plugin-loader/src/config/entry.ts` | p2m 以 entry 的 `id`/`name` 标识"某个插件" |
| F2 | `disabled` 支持布尔或 `!!js` 表达式（对 loader ctx 求值） | 同上 / `config/utils.ts` | v1 只用布尔，v2 可上 `!!js ctx.p2m…` 动态开关 |
| F3 | 热调度 API：`ctx.loader.create/update/remove/resolve/locate`；`update` 可改 `disabled`、`name`、移动位置并触发重启 | `cordis-plugin-loader/src/index.ts`、README | p2m 的"运行期调度"抓手 |
| F4 | root loader 的 `write()` 为 no-op（内存树）；**只有文件层重启后再生效** | `index.ts` Loader.write | 所有运行期决策必须同步写持久层（guard），否则重启丢状态 |
| F5 | loader 事件：`loader/entry-init`、`loader/partial-dispose`、`internal/plugin`、`internal/update` | `index.ts`、`entry.ts` | 观察启停/自卸的钩子 |
| F6 | 崩溃文本：`failed to <import\|apply\|dispose> loader entry <id> (<name>): <detail>`；`ctx.loader.locate(fiber)` 反查 entry id | `entry.ts:updateError`、`index.ts:locate` | 冲突归因的文本协议 |
| F7 | 补丁层合并：cordis.yml(空) ← 各 bundle patch ← 用户 patch ← `--patch` overlay（guard） | profile 目录实况、`cordis.patch.yml` 注释 | guard 是"最后一层"，禁用语义最强，适合做 p2m 的持久决策面 |
| F8 | 数据目录约定：`process.env.DSH_HOME \|\| ~/.dsh`（whale 插件同款） | `DeepSeek-Balance-Whale-Widget/lib/index.js` | p2m 状态文件放 `<DSH_HOME>/p2m/` |
| F9 | 插件模块形态：`{name, apply}`（CJS/ESM 均可），loader `unwrapExports` | `dsh-theme-endfield/index.js` | p2m 本体照此写 |
| F10 | DSH 核心条目 name 一律 `@deepseek-ai/*`（dsh-base、dsh-web-app…），用户第三方为市场包/link 包 | `~/.dsh/profiles/web/package.json` 的 bundles | **DSH 本体识别规则**：name 以 `@deepseek-ai/` 开头即 core tier（可配置名单扩展） |

---

## 3. 总体结构（仓库布局 = 交付物）

```
DSH-P2M/
├─ package.json            # cordis 插件包元数据（dsh.bundle.patch → cordis.patch.yml）
├─ cordis.patch.yml        # 挂载 p2m 一行的 bundle patch（本包即“A插件”）
├─ lib/                    # 插件本体（ESM、零运行时依赖）
│  ├─ index.js             # apply(ctx,config)：注册 ctx.p2m 服务、事件钩子、采样调度
│  ├─ guard.js             # guard 持久层：唯一写者封装（读/写/迁移/备份/锁）
│  ├─ yaml-min.js          # YAML 子集解析/序列化（仅 loader 补丁方言，含 !!js 直通）
│  ├─ state.js             # <DSH_HOME>/p2m/ 下的 JSON 状态（原子写 tmp+rename）
│  ├─ ledger.js            # 累计使用时长台账 + 排序
│  ├─ priority.js          # 分层模型：core > p2m > others(按 usage 降序)
│  ├─ conflicts.js         # 静态扫描 + 运行期事件归一化 → Conflict 记录
│  ├─ policy.js            # 裁决引擎：谁胜谁负、写 guard、留痕、可回滚
│  └─ util.js
├─ launcher/dsh-safe.mjs   # v2 启动器（升级版，仅启动监督 + 启动期紧急隔离）
├─ test/                   # node:test 单测 + fixtures（零依赖）
├─ README.md / README.en.md / LICENSE(MIT)
├─ AGENTS.md / DESIGN.md   # 本文档
```

模块依赖方向（禁止反向）：`index → policy → {guard, ledger, priority, conflicts, state}`；`conflicts → {yaml-min, priority}`；`guard → yaml-min`；启动器只内联"紧急隔离"最小逻辑 + 与 p2m 通过**同一 canonical guard 文件 + 锁**互斥。

---

## 4. 数据面：持久层与文件格式

全部落在 `<DSH_HOME>/p2m/`（`DSH_HOME` 默认 `~/.dsh`），可用 config 覆盖根目录：

| 文件 | 格式 | 内容 |
| --- | --- | --- |
| `plugin-guard.yml` | YAML（loader patch 方言，顶层数组） | **canonical guard**：`- id: X` + `disabled: true` 列表。p2m 与启动器的唯一共享写面 |
| `state.json` | JSON | p2m 自身状态：版本、core 名单快照、guard 备份轮次、自检时间 |
| `usage.json` | JSON | `{ "<entryId>": { cumulativeMs, firstSeen, lastSeen, runningSince } }` |
| `incidents.jsonl` | JSONL（append-only） | 冲突/隔离/恢复事件流水：`{ts, kind, ids[], offender, reason, action, undo}` |

**guard 唯一写者纪律**：
- p2m 运行期一切"禁用/恢复"决策 → `guard.js`（锁 + 备份）→ 写 canonical 文件。
- 启动器仅在两处写：**a)** 首跑把旧 `plugin-guard.yml`（启动器同目录）迁移进 canonical；**b)** 启动崩溃紧急隔离（此时 p2m 尚未起来，无法代劳）——同样走 `guard.js` 的锁与备份，绝不裸写。
- 写前 `lock`（`<file>.lock`，O_EXCL + 过期兜底 60s），写后原子 rename，覆盖前先备份 `plugin-guard.yml.bak-<ts>`。

---

## 5. 优先级机制（核心要求 3 + 4）

### 5.1 分层模型

对任意 entry，分层函数 `tierOf(entry)`：

```
tier 0  DSH 本体  : name.startsWith('@deepseek-ai/') 或 id ∈ config.coreIds（名单快照，可扩展）
tier 1  A 插件     : name === 'dsh-p2m'（自识别，不可被改名换 id）
tier 2  其他插件    : 其余一切
```

规则（不可违反）：
1. **任何决策永不 disabled core 与 p2m 自身**；若观测到 guard 里有 p2m 自己的行 → 自愈：删除该行并记录 incident（自杀免疫）。
2. tier 2 内部按 `usage.json` 的 `cumulativeMs` **降序**为"维护优先级"：用得越久 = 优先级越高 = 越靠前被维护、越少被牺牲。
3. 排序是**动态**的：每次查询/每次决策都实时按最新台账计算；台账由采样持续累积（见 5.3）。

### 5.2 优先级用在哪（v1 三个消费点）

| 消费点 | 用法 |
| --- | --- |
| 冲突裁决 | 两插件冲突且须牺牲一个时，裁决"优先级低者出局"（tier 先决；同 tier 比 usage 降序，用时短者出局） |
| 维护视图/日志 | `ctx.p2m.list()` 返回带 `rank` 的有序列表（core > p2m > others by usage），写日志、供人阅读 |
| 恢复顺序 | 批量恢复/回滚时按该顺序逐一试探（core/p2m 永不参与） |

### 5.3 使用时长台账口径（需用户确认的默认口径）

- **口径**：插件处于"运行中"即计使用时间（墙钟）。以采样循环实现：默认每 `sampleIntervalMs = 30_000` ms 走查 loader 树，`ctx.loader.locate(fiber)` 或遍历 group 取得"当前正在运行的 entry 集合"，把间隔时长累加给仍在运行的 id。
- 幂等与恢复：进程退出时不丢已落盘的累计值；崩溃瞬间丢失 ≤ 一个采样间隔（可接受，写文档说明）。
- 采样只读 loader 状态，**不改动任何插件**；tier0/tier1 也计入台账（dashboard 展示用），但不参与 tier2 排序外的任何裁决。
- 停用/崩溃时：若 entry 消失（disabled/remove），其 `runningSince` 清空、差额结算进 `cumulativeMs`。

### 5.4 示例（对应需求"B 时长超过 C"）

```
台账：A插件=∞(tier1), B=12h, C=5h, D=2h
list() 顺序：DSH(本体) → p2m(A) → B → C → D
B 继续用、C 停用一周后：DSH → p2m(A) → B? C 不变排序…台账降为 C=5h, D=3h → DSH → p2m → B → D → C
```

---

## 6. 冲突处理（核心要求 2）

### 6.1 冲突分类矩阵

| 类 | 表现 | 检测时点 | 检测手段 |
| --- | --- | --- | --- |
| C1 启动崩溃 | boot 失败，stderr 命中 `failed to … loader entry <id>` | 启动期 | 启动器归因（复用 dsh-safe 逻辑）→ 事件写入 incidents + 按策略隔离 |
| C2 运行期 apply 失败 | 某 entry apply 抛错，loader 自动 `disabled:true`（`entry.ts` case7） | 运行期 | p2m 监听 `loader/partial-dispose` / 周期 diff 树状态 |
| C3 同 id 配置互踩 | ≥2 层补丁对同一 entry id 给了**不同 config**（后者覆盖前者，静默丢配置） | 任意时点（扫描） | 静态扫描各层 patch：同 id 冲突检测 |
| C4 同层重复 id | 同一补丁数组内两个 entry 同 id | 任意时点（扫描） | 静态扫描 |
| C5 重复 name | 两个不同 id 指向同一模块 | 任意时点（扫描） | 静态扫描（可配置 ignore） |
| C6 自杀/越权 | guard 中出现 p2m/core 自己的行 | 启动自检 / 每次读 guard | 自愈：删除该行 + incident |
| C7 端口/保留资源互踩 | 多个插件 patch 同一系统服务（如 webserver port） | 扫描（可配置 key 规则） | C3 的特例，按 config 冲突上报 |

### 6.2 检测引擎（conflicts.js）

- `scanStatic(layers, opts)`：输入各层 patch（解析自 yaml-min / 或已注入的对象），输出 `Conflict[]`：`{kind, layerIds[], entryId, name, detail, severity: error|warn, evidence}`。不修改任何东西。
- `observeRuntime(ctx)`：订阅事件 + 定时 diff，把 C2 归一化成与静态冲突同构的 `Conflict`，进队列。

### 6.3 裁决引擎（policy.js）—— 核心流程

```
onConflict(c):
  c.ids 按优先级（5.1/5.2）排序 → 得到 protect 方 vs 牺牲候选
  if c 涉及 core 或 p2m:
     action = report_only   # 永不自动禁用；仅 incident + 告警
  else:
     loser = 排序最末者（usage 最低）
     action = isolate(loser)：
       1) guard.js: 备份 → 加行 disabled:true → 原子写
       2) 尝试 ctx.loader.update(loser, {disabled:true})（内存热生效，失败可忽略）
       3) incident 记 {kind, offender, loser, undo: 备份文件名}
  emit 通知（ctx.p2m 日志 + `ctx.p2m.events`）
```

- **回滚**：`ctx.p2m.restore(entryId)` 从 guard 删行（hot enable），incident 标记 recovered；`ctx.p2m.rollback(backupRef)` 整份还原备份。
- **始终可解释**：每次决策写 incidents.jsonl，含 evidence 与 undo 引用。

### 6.4 与 dsh-safe 的分工（用户已拍板：接管并升级）

| | 启动期（p2m 未运行） | 运行期（p2m 已运行） |
| --- | --- | --- |
| **谁决策** | 启动器（v2 dsh-safe）只做**紧急隔离**：崩溃归因 → 写 canonical guard（走锁/备份）→ 重启，最多 5 次 | **p2m**（guard 唯一写者）：一切运行期决策 |
| **谁记账** | 启动器写 incidents.jsonl 一条（boot-crash） | p2m 正常记账 |
| **p2m 起来后** | 启动自检：迁移遗留、C6 自杀自愈、guard/state 一致性对账 | — |

---

## 7. 运行时序（一次启动）

```
DSH-safe v2 启动
 ├─ ① 迁移旧 guard（仅首跑）→ canonical <DSH_HOME>/p2m/plugin-guard.yml
 ├─ ② spawn dsh --profile web --patch <canonical guard> --port …
 ├─ ③ 崩溃? → 归因 id → 若 id ∈ {core,p2m} 只告警不隔离（防自杀）→ 否则紧急隔离 + reboot（≤5）
 └─ ④ 稳定运行 → p2m 加载：
      bootstrap：读 guard/state → C6 自愈 → 静态扫描一轮（只报告）→ 起采样与观察
      运行中：事件/采样 → 冲突裁决 → guard 持久化 + hot update
```

---

## 8. 稳定性保障（对应要求：始终优先保障 DSH 与 A 自身）

1. **零运行时依赖**：不引入 `yaml` 等外部包（子集解析自带），天然避开依赖冲突（讽刺但必要：管理插件自己不制造冲突）。
2. **只读优先**：静态扫描只读；对 tier0/1 任何时刻不写 disabled。
3. **原子写 + 备份 + 锁**：guard/state 全走 tmp+rename；写前锁，防 p2m 与启动器抢写。
4. **失败降级**：p2m 自身逻辑抛错 → catch 全，仅记日志，绝不影响 loader 树其他部分；p2m 崩溃时 dsh 本体不受影响（它就是普通 entry）。
5. **自杀免疫**：见 5.1 规则 1。
6. 采样间隔、裁决开关（`autoIsolate:false` 时只报告不隔离）全部 config 可调。

---

## 9. 插件 config（cordis.patch.yml 挂载行给入）

| key | 默认 | 说明 |
| --- | --- | --- |
| `stateRoot` | `$DSH_HOME/p2m` | 状态目录（可指到 profile 下） |
| `guardFile` | `<stateRoot>/plugin-guard.yml` | canonical guard 路径 |
| `sampleIntervalMs` | 30000 | 使用时长采样间隔 |
| `autoIsolate` | true | 运行期是否自动隔离（false=只报告） |
| `coreNamePrefixes` | `['@deepseek-ai/']` | core tier 识别前缀 |
| `coreEntryIds` | `[]` | core tier 额外 id 名单 |
| `knownSystemKeys` | `['webserver','web-ui-*']` | C7 保留资源 key 规则 |

---

## 10. 测试与验证计划

- **单元**（`node --test`，零依赖）：yaml-min 往返（含 !!js、引号、注释、嵌套）；guard 读/写/备份/锁；ledger 累积与排序；priority tier 判定；conflicts 静态扫描各分类；policy 裁决矩阵（含 core/p2m 免疫、usage 高低取舍、autoIsolate=false）。
- **夹具**：复刻真实素材 —— webserver 端口 patch、web-ui-pet disabled、theme/whale 的 insert 行。
- **真机冒烟（用户环境执行，因沙箱不能实启 dsh）**：README 第 7 节步骤：备份 profile package.json → `dsh plugin --profile web add`/手动 link → 重启 dsh-safe v2 → 观察 p2m 日志与 `list()` 排序；人为制造冲突（重复 id patch）验证裁决。

## 11. 风险与未决（诚实清单）

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| 热调度持久性 | root tree `write()` no-op | 决策一律双写：guard 持久 + loader.update 热生效；README 说明重启语义 |
| yaml-min 子集边界 | 只支持 loader 补丁方言；极端 YAML（锚点/复杂流式）不保证 | 解析失败 → 该层按"不可读"跳过并 incident，绝不 crash |
| `!!js` 表达式静态值 | 静态扫描把 `!!js` 当不透明串比对，可能误报 C3 | severity=warn，仅报告 |
| 采样计数偏差 | 崩溃丢 ≤1 个采样间隔 | 文档明示口径，误差可接受 |
| 与官方内置插件设置页并存 | DSH 自带 UI 插件管理（dsh-client-ui-settings-plugins） | v1 不接管其写路径，只做 guard 层统一；v2 评估对接 |
| launcher 与 p2m 双写竞态 | 只在"启动崩溃瞬间"与"运行期"两个不相交时段写；锁兜底 | guard.js 锁 + 备份 |

## 12. 路线图

- **v1（本期交付）**：本设计全部落地 + 单测 + GitHub 仓库 `DSH-P2M` + 双语 README + 安装指引。
- **v2（候选）**：`disabled: !!js ctx.p2m…` 动态开关；对接 dsh 官方插件 UI/CLI（`dsh plugin`）；更多 C7 保留资源规则与社区规则文件；多 profile 命名空间。
