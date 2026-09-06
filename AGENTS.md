# AGENTS.md — DSH-P2M 项目环境约定

> 本文档供任何 AI agent / 新会话接手本项目时**先读再动手**，避免重复踩环境坑。

## 主机与工具环境（实测锁定，2026-09-05）

| 项 | 值 | 备注 |
| --- | --- | --- |
| OS | Windows（Git Bash 为默认 shell） | 路径建议用正斜杠 `/c/Users/...` |
| Node（本会话/WorkBuddy managed） | `C:\Users\28903\.workbuddy\binaries\node\versions\22.22.2-2\node.exe` | **装包勿用**，仅跑脚本/测试 |
| 系统 npm / node | `C:\Program Files\nodejs\npm.cmd`、`C:\Program Files\nodejs\node.exe` | 全局包（dsh/pnpm/gh 等）装在此 |
| 全局包目录 | `C:\Users\28903\AppData\Roaming\npm\node_modules` | dsh CLI = `@deepseek-ai/dsh` |
| gh CLI | 已登录 `GiantAxeint`（keyring，repo scope） | 可建仓/推送 |
| DSH 安装 | npm 全局 `@deepseek-ai/dsh`；profile 根 `~/.dsh/profiles/web/`（Cordis 工程） | `DSH_HOME` 环境变量约定存在，默认 `~/.dsh` |
| 插件目录（本机实例） | `E:\DeepseekHome\Plugin\`（每个插件一个 git 包） | 启动器/guard：`E:\DeepseekHome\dsh-safe.mjs` + `plugin-guard.yml` |
| Cordis 运行时 | `@deepseek-ai/cordis` **4.0.2**（dsh 内置 fork） | loader = `@deepseek-ai/cordis-plugin-loader` |
| 沙箱写限制 | WorkBuddy 沙箱拦截"覆盖/删除已存在文件"的子进程操作；`pnpm install`/`dsh` 实启等**交用户在自己环境执行** | 本项目产物全部新建目录，不受影响 |

## 项目事实速查（勿凭记忆）

- **DSH 插件 = Cordis loader entry**：每个插件是一个 npm 包，`package.json` 声明 `dsh.bundle.patch` 指向 `cordis.patch.yml`；该文件为**顶层 loader 补丁数组**，行形态：
  - `- insert: [{id: <entryId>, name: '<moduleSpec>', config: {...}}]`（挂载一行插件）
  - `- id: <entryId>` + `config:` / `disabled: true`（按 id 覆写/禁用）
  - `disabled` 支持 `!!js 表达式`（求值上下文为 loader ctx）
- **配置层合并顺序**（后者覆盖前者）：profile `cordis.yml`(空) ← 各 bundle 的 `cordis.patch.yml` ← 用户 `cordis.patch.yml` ← `--patch` 启动覆盖层（guard 文件）。
- **运行时管理 API（热调度）**：`ctx.loader.create/update/remove/resolve/locate/await`；`update(id, opts)` 支持改 `disabled`、换 `name`、移动位置。**注意**：root tree 的 `write()` 是 no-op —— 运行时改动只在内存生效，**要跨重启持久必须写 guard/patch 文件**。
- **崩溃归因**：loader 抛 `failed to <import|apply|dispose> loader entry <id> (<name>): <detail>`；dsh-safe 据此提取 `<id>`。
- **插件模块写法**：`module.exports = { name, apply }`（CJS）或 ESM `export default { name, apply }`；loader `unwrapExports` 兼容。P2M 本体用 **ESM、零运行时依赖**（自带 YAML 子集解析器，见 `lib/yaml-min.js`）。

## 排障心法（2026-09-06 冲突事件沉淀，勿凭经验重试）

> 完整复盘：`docs/incident-2026-09-06.html`（三次启动崩溃：缺包 → API 漂移 → 同名服务冲突）。已落地的对应观测能力：E1 C7 预检、E2 resolve 快照、E3 peer preflight、E4 覆盖感知（见 DESIGN §14）。

1. **pnpm 状态文件信任快路径**：`pnpm install` 判定"是否 up to date"只看 `.modules.yaml` + lockfile，**不 stat 磁盘实体**。若 `.pnpm/` 实体被抹掉而 lockfile 完好，普通 `pnpm install` 永远走快路径、实体永不补齐（报错会一直"看似无解"）。修复：先把 `node_modules` **改名备份**（不要删）再 `pnpm install` 强制重建。
2. **"export 缺失 / does not provide an export" ≠ 缺包**：很可能是解析目标版本不对——profile 本地实体丢失后 Node 沿目录**向上爬升**命中全局 CLI 内置包（如 dsh-settings@0.1.2-alpha.3 移除旧导出）。排查用 `createRequire(path.join(profileDir, '__p2m__.cjs')).resolve(spec)` 实证解析落点与版本；修复：在 profile 显式钉版本（`pnpm add <spec>@<兼容版>`）让本地实体优先。
3. **"service X has been registered" ≠ 依赖又坏了**：是补丁层把**出厂默认 disabled 的条目**（常是"默认后端替代品"，如 morlay RDB 三件套）通过 profile 整批 `disabled:false` 唤醒了。修复是**二选一**：改回 disabled:true，或连官方默认后端一并禁用——不要两个都开。
4. cordis 服务注册字面量只有两类：Service 子类 `super(ctx, name)` 与 `ctx.provide(name, …)`；名字常写在一跳依赖基类包里（`sessionPersistence` 实际在 `@deepseek-ai/dsh-session-persistence`）——所以 C7 扫描连带扫一跳依赖包。

## 纪律摘要（agent-coding-discipline 五律）

1. 版本/API 先行：引依赖先查官方（本项目刻意零依赖，见 DESIGN 第 12 节）。
2. 环境感知：以上表为准，新增机器/路径先实测再写入本文档。
3. 单区块原子 git 提交：message 格式 `<区块>: <做了什么>`，每块一 commit。
4. 通读 + 注释：lib 每个模块头注释"为什么存在"，关键函数 JSDoc。
5. 分块交接：改动前通读 DESIGN.md 的模块划分，跨模块改动同步更新 DESIGN。

## 常用命令

```bash
# 跑全部单测（无需任何 npm install，零依赖）
node --test test/
# 只跑某模块
node --test test/guard.test.mjs
```
