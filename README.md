# 插件冲突管家（P2M）

[**English**](./README.en.md) | **中文**

**插件冲突管家（P2M）：统一管理插件启停、检测并裁决插件冲突、按使用时长动态维护优先级。**

> 仓库与包标识沿用 `DSH-P2M` / `dsh-p2m`（技术标识不变）；P2M 为本插件对外昵称。

---

## 它解决什么

插件装多了以后的三类痛点：

| 痛点 | P2M 的做法 |
| --- | --- |
| 没有统一管理 | 一处登记/启停/隔离/恢复所有插件，决策写入**唯一的 guard 文件**，跨重启生效 |
| 冲突只能被动熔断 | 检测（启动崩溃归因 / 运行期自动禁用 / 静态补丁扫描）→ 按优先级裁决 → 留痕、可回滚 |
| 没有优先级概念 | 恒定 `DSH > P2M > 其他`；其他插件按**累计使用时长**实时排序：B 用得比 C 久，维护顺序就是 `DSH > P2M > B > C > …` |

**补充能力（v1 含）**：下载后"真实开启前先试跑"——新插件启用前在子进程里试运行一次；会崩就弹窗给两个选项：**「取消开启」/「无视风险继续使用」**。

## 优先级机制

```
tier 0  DSH 本体      （name 以 @deepseek-ai/ 开头，或配置的 coreEntryIds）
tier 1  P2M 自身      （entry id: p2m，自杀免疫：guard 里出现自己会被自动移除）
tier 2  其他插件       （按 usage.json 累计使用毫秒降序 = 维护优先级）

铁律：任何决策永不禁用 tier0/tier1；同层冲突牺牲"用时短者"。
```

动态示例（对应需求）：台账 `B=12h, C=5h, D=2h` → 顺序 `DSH → P2M → B → C → D`；B 继续用、C 停用使 `D=3h > C=5h` 变 `C=5h,D=3h` → 顺序变为 `DSH → P2M → B → D → C`。

## 工作原理（一页速览）

- DSH 插件 = Cordis loader entry：每个插件是 npm 包，`cordis.patch.yml` 声明挂载行。
- 配置按层合并，`--patch` 覆盖层（guard 文件）最后生效，**禁用心最强**。
- P2M 用 loader 热管理 API（`create/update/remove`）做运行期调度；root 树的 `write()` 是 no-op，所以**每次决策双写**：guard（持久，重启有效）+ 运行时热更新（即时生效）。
- 详细设计（冲突分类矩阵、guard 协议、数据格式、边界）见 [DESIGN.md](./DESIGN.md)。

## 安装

环境要求：DSH（`dsh` CLI 全局安装）、Node ≥ 18。

### 方式 A：官方插件 CLI（仓库公开后可用）

```bash
dsh plugin --profile web add github:GiantAxeint/DSH-P2M
```

### 方式 B：本地 link（开发/未发布时）

1. 把本仓库放到任意目录（如 `E:\DeepseekHome\Plugin\DSH-P2M`）。
2. 编辑 profile 的 `package.json`（Windows 示例：`%USERPROFILE%\.dsh\profiles\web\package.json`）：
   - `dependencies` 增加：`"dsh-p2m": "link:E:/DeepseekHome/Plugin/DSH-P2M"`
   - `dsh.profile.bundles` 数组**开头**插入 `"dsh-p2m"`（保证它最先加载，体现 `DSH > P2M` 顺序）。
3. 在 profile 目录执行 `pnpm install`（DSH 用 pnpm workspace）。
4. 重启 DSH（推荐用下方的 v2 启动器）。

> P2M 的 entry id 固定为 `p2m`，**请勿改动**（guard 自愈机制依赖它）。

### 升级启动器（推荐，接管并升级 dsh-safe）

仓库内 `launcher/dsh-safe.mjs` 是 v2 启动器：**纯启动监督**（崩溃时只做紧急隔离），canonical guard 迁移到 `<DSH_HOME>/p2m/plugin-guard.yml` 并与 P2M 共用锁/备份协议，崩溃事件写入同一份 `incidents.jsonl`。把该文件复制覆盖你原来的 `dsh-safe.mjs` 即可（旧文件会先备份）。Windows 一键脚本：

```
scripts\install-safe.cmd
```

## 使用

P2M 启动后自动工作；状态与数据落在 `<DSH_HOME>/p2m/`（默认 `~/.dsh/p2m/`）：

| 文件 | 内容 |
| --- | --- |
| `plugin-guard.yml` | **唯一 guard**（被禁插件的持久名单，启动时以 `--patch` 注入） |
| `usage.json` | 每插件累计使用时长台账（采样口径 30s，可配） |
| `incidents.jsonl` | 冲突/隔离/恢复/弹窗决策的追加流水（append-only） |
| `state.json` | p2m 自身状态（boot 计数、快照等） |

### ctx.p2m API（运行期可调）

| 方法 | 作用 |
| --- | --- |
| `list()` | 按优先级输出排序列表（含 tier / usageMs / running / disabled） |
| `status()` | 当前配置与 guard 状态 |
| `usage()` / `incidents(n)` | 台账 / 最近 n 条流水 |
| `scanConflicts()` | 立即做一轮静态+运行期冲突扫描（只报告） |
| `enable(id)` / `disable(id)` | 恢复/禁用（恢复前会走试用门禁；protected 不可禁用） |
| `trial(id)` | 手动子进程试跑一次，返回 verdict（ok/crash/timeout/unsupported） |
| `reconcile()` / `sample()` | 手动触发对账 / 采样 |

### 试用门禁（下载即试跑）

- 开启新插件/恢复被隔离插件前，先在**子进程**里 import+apply 试跑一次。
- 试跑失败（crash/timeout/无法判定）→ 桌面弹窗：**取消开启**（默认，安全）/ **无视风险继续使用**（记 incident；若仍崩溃，冷却期内自动隔离，避免弹窗风暴）。
- 配置 `autoGateRisk:false` 关闭门禁，或 `ui:'none'` 关闭弹窗（一律默认取消）。

## 配置（挂载行 config 给入）

| key | 默认 | 说明 |
| --- | --- | --- |
| `sampleIntervalMs` | 30000 | 使用时长采样间隔 |
| `autoIsolate` | true | 运行期自动隔离（false=只报告） |
| `autoGateRisk` | true | 试用门禁开关 |
| `ui` | 'auto' | 弹窗模式：auto/desktop/none |
| `popupCooldownMs` | 120000 | 同一插件弹窗冷却 |
| `trialTimeoutMs` | 15000 | 试跑子进程超时 |
| `coreNamePrefixes` | ['@deepseek-ai/'] | DSH 本体识别前缀 |
| `coreEntryIds` | [] | DSH 本体额外 entry id |
| `patchLayers` | [] | `scanConflicts()` 额外扫描的补丁文件 |

## 冲突类型速查

| 类 | 含义 | 处理 |
| --- | --- | --- |
| C1 启动崩溃 | 启动失败命中 `failed to … loader entry` | dsh-safe v2 紧急隔离 + incident |
| C2 运行期自动禁用 | loader 把某 entry 置 disabled 未持久化 | 试跑判定：冲突→隔离；自崩→弹窗 |
| C3 同 id 配置互踩 | 多层补丁对同一 id 给不同配置 | 报告（需人工） |
| C4/C5 重复 id / 同名模块 | 结构性问题 | 报告（需人工） |
| C6 自杀/越权 | guard 出现 p2m/core | 自愈移除 + incident |

## 测试

零依赖单测（`node:test`）：

```bash
node --test test/*.test.mjs   # 50 个用例：guard/ledger/priority/conflicts/policy/yaml/trial
```

## 目录结构

```
DSH-P2M/
├─ lib/            P2M 本体（ESM，零运行时依赖）
│  ├─ index.js     入口：ctx.p2m 服务、采样、对账、门禁
│  ├─ guard.js     guard 唯一写者（锁+备份+迁移）
│  ├─ yaml-min.js  自带 loader 补丁方言 YAML 解析器
│  ├─ ledger.js    使用时长台账（纯函数 tick）
│  ├─ priority.js  分层与动态排序
│  ├─ conflicts.js 冲突检测（静态+运行期）
│  ├─ policy.js    裁决引擎
│  ├─ trial.js     子进程试跑（R5）
│  └─ dialog.js    崩溃风险双按钮弹窗（R5）
├─ launcher/       dsh-safe v2 纯启动监督器（复制覆盖旧版）
├─ test/           单测 + 试跑夹具
└─ DESIGN.md       完整设计与边界（必读）
```

## 安全与边界（诚实声明）

- P2M **零运行时依赖**（连 yaml 解析都自带），自己不会制造依赖冲突。
- 涉及 DSH 本体与自身的决策永远只报告、不自动禁用；guard 出现自身会自愈。
- 试跑能捕获 import/apply 级崩溃；把整个进程炸掉级别的硬崩溃由 dsh-safe 启动熔断兜底。
- 官方 `dsh plugin add` 是"下载即重启"流，p2m 无法在重启前介入该流（由 v2 启动器熔断+incident 接管）；热挂载/手动恢复等 p2m 可控入口已全部接入试用门禁。

## License

[MIT](./LICENSE) © 2026 Erius (GiantAxeint)
