# dsh-agents-rules

[English](README.md) | 中文

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 AGENTS 规则适配插件（bundle）。它加载厂商中立的 `.agents/rules` 约定下的规则文件——项目级（`<projectRoot>/.agents/rules`）与全局（`~/.agents/rules`）——并出于 Claude Code 兼容目的同时加载两级 `.claude/rules`，两种约定内容相同时去重。全部内容作为一个系统提示词段落注入。

## 为什么是这个形态

编码代理的规则约定在会话开始时一次性加载规则文件，会话中不会刷新：会话进行中新加的规则对该会话不可见，只有新开对话（或 fork）才会加载。本插件在 DSH 上精确复刻这一语义：

- 会话的第一次系统提示词装配读取一次规则文件，并把渲染结果按会话的活跃 agent 缓存。
- 同一会话此后的每次装配复用缓存文本——会话中的编辑、新增、删除都不会进入已有对话。
- 新会话、fork、或恢复的会话都是新 agent，因此会重新读取当前文件。

两种投递模式（`mode` 配置）：`context`（默认）发布一条和技能目录同样框架的持久 user-role 消息——对话里直接可见、可从会话日志重建，通过 `agent/pre-step` waterfall 注入，不改 agent loop。`system-prompt` 则改为在每个装配里拼接一个段落（会话内前缀稳定）。

## 加载哪些内容

- **全局规则**：`<agentsHome>/rules`（默认 `~/.agents/rules`）下所有 `*.md` 文件，递归发现，按名称稳定排序。
- **全局兼容规则**（`claudeCompat: true`，默认开启）：`<claudeHome>/rules`（默认 `~/.claude/rules`）下所有 `*.md` 文件。
- **项目规则**：`<projectRoot>/.agents/rules` 下所有 `*.md` 文件；项目根是从会话 cwd 向上找到的第一个包含项目根标记（默认 `.git`；会话 cwd 本身是兜底）的祖先目录。一路到文件系统根都没有标记时，项目规则不加载。
- **项目兼容规则**：`<projectRoot>/.claude/rules` 下所有 `*.md` 文件。
- 根由宽到窄、规范约定在前地渲染：全局 `.agents` → 全局 `.claude` → 项目 `.agents` → 项目 `.claude`。

**去重**：准备后内容（剥掉 frontmatter、trim）与更早文件完全相同的文件只渲染一次——先出现者胜，因此 `.agents` 里的副本优先于它的 `.claude` 镜像，全局副本优先于恰好相同的项目副本。去重按内容而非文件名：相对路径相同但正文不同的两个文件都会保留。被跳过的副本记录在结尾说明里（`Rule files skipped as exact duplicates of an earlier rule file: <路径> (= <保留路径>)`），且去重发生在字节预算之前，重复内容永不占用预算。

`.agents/rules` 约定没有文档化的 frontmatter 字段语义，`.claude/rules` 的 frontmatter 本插件同样不解释：每个文件在剥离开头的 YAML frontmatter 元数据块后按原文注入，只保留正文。

## 渲染形态

```md
<system-reminder>
The following agent rules were loaded once at session start and are frozen for this session. Use them as guidance when applicable. They do not override system, developer, or direct user instructions.

<agent_rules>
<rule origin="global" path="~/.agents/rules/style.md">

<规则内容，保留自身的 markdown 标题层级>
</rule>

<rule origin="project" path=".agents/rules/api.md">

<规则内容>
</rule>
</agent_rules>
</system-reminder>
```

每个文件用 XML 风格元素包裹（与技能目录的约定一致），而不是 markdown 标题：规则文件自带 `#`/`##` 标题，如果框架也用标题，层级会和内容打架（文件名反而嵌在内容标题之下）。全局规则先于项目规则，同一层级内 `.agents` 先于 `.claude`（由宽到窄）。内容里字面出现的 `</rule>` 或框架闭合标签会被转义。

## 与 dsh-agent-instructions 的关系

DSH 自带的 `@deepseek-ai/dsh-agent-instructions` 加载 `AGENTS.md`/`CLAUDE.md` 指令文件（用户级 `$DSH_HOME/AGENTS.md` 加项目目录链，含嵌套发现与变更追踪）。本插件覆盖该机制不解释的 `rules` 目录这一互补面——两种约定的 `rules` 目录都算——并且刻意不做其他任何事：不加载 `CLAUDE.md`、不碰 `.claude/rules` 之外的 `.claude/` 路径、不处理 `@path` 导入。

## 安装

已发布到 npm：[`dsh-agents-rules`](https://www.npmjs.com/package/dsh-agents-rules)：

```sh
dsh plugin --profile web add dsh-agents-rules
```

装完直接跳到下面第 3 步（重启 dsh）。

从本项目的 checkout 目录开始（下文的 `<checkout 路径>` 替换为其绝对路径）：

### 1. 构建包

profile 导入的是构建产物 `lib/`，所以安装前、以及每次改完源码后都要构建：

```sh
pnpm install
pnpm run build    # tsc -> lib/
pnpm test         # 可选的自检
```

### 2. 安装进 profile

标准路径——用 `dsh plugin` 代跑 pnpm（包通过 `dsh.bundle.patch` 声明为 bundle，会自动加入 profile 层叠）：

```sh
dsh plugin --profile web add <checkout 路径>
```

**pnpm 报 store 版本冲突时的兜底方案**（当 profile 的 `node_modules` 是旧版 pnpm 大版本创建时会出现——报错会提到两个 store 路径，如 `...store\\v10` 和 `...store\\v11`）。手动完成 `dsh plugin` 要做的两件事：

1. 在 `~/.dsh/profiles/web/package.json` 里注册 bundle：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-agents-rules"
         ]
       }
     },
     "dependencies": {
       "dsh-agents-rules": "link:<checkout 路径>"
     }
   }
   ```

   （profile 里已有的 bundle/依赖原样保留；是追加，不是替换）

2. 让裸包名可解析——链接进两个解析根（下面是 Windows junction；其他平台用 symlink）：

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-agents-rules" -Target '<checkout 路径>'
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-agents-rules" -Target '<checkout 路径>'
   ```

### 3. 重启 dsh

bundle 在进程启动时加载；运行中的服务不会热加载新加的 bundle 行。安装后、或改了本包 `cordis.patch.yml` 后，重启 dsh 进程（比如跑 Web GUI 的那个）。

### 4. 验证

- 离线组合检查——dump 里必须出现这一行：

  ```sh
  dsh --profile web --dump-config | Select-String agents-rules
  ```

- 在线检查——开一个**新**对话（已有会话按设计是冻结的），选一个有 `.agents/rules` 的工作区，随便发一句话：规则上下文消息（`<agent_rules>` 块）会直接出现在对话流里你的消息之后，框架与技能目录相同。在对话里搜规则文件名（如 `english-code-comments`）必中。

### 卸载

从 `dsh.profile.bundles` 移除该行（和依赖），删除两个 junction 链接，重启 dsh。

## 配置

bundle patch 插入一行（`id: agents-rules`）；在 profile 的 `cordis.patch.yml` 里覆盖（patch 会整体替换该行 config，保留的字段需要重述）：

```yaml
- id: agents-rules
  config:
    agentsHome: ~/.agents
    claudeCompat: true
    claudeHome: ~/.claude
    projectRootMarkers: ['.git']
    maxBytes: 65536
    maxFileBytes: 262144
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `context` | `context` = 持久 user-role 消息（对话可见）；`system-prompt` = persona 后的一个提示词段落。 |
| `agentsHome` | `~/.agents` | 全局规则所在主目录；规则来自 `<agentsHome>/rules`。前导 `~` 按 OS 主目录展开。 |
| `claudeCompat` | `true` | 同时加载 `<claudeHome>/rules`（全局）与 `<projectRoot>/.claude/rules`（项目），按内容对 `.agents` 约定去重。 |
| `claudeHome` | `~/.claude` | 全局 Claude 兼容规则所在主目录；规则来自 `<claudeHome>/rules`。校验方式同 `agentsHome`。 |
| `projectRootMarkers` | `['.git']` | 从会话 cwd 向上识别项目根的同目录标记文件名。 |
| `maxBytes` | 必填 | 完整渲染段落的总字节预算。非正数关闭注入。 |
| `maxFileBytes` | `262144` | 单文件字节上限；超限的规则文件跳过并列入说明。 |

预算行为：完全重复的内容最先丢弃（永不占用预算），然后从宽（全局）端整文件丢弃，每次丢弃都记录在结尾说明；若单文件仍超出，则带可见标记截断。配置错误（`maxBytes` 非有限数、`agentsHome`/`claudeHome` 相对路径、`claudeCompat` 非布尔、标记名含分隔符）在插件加载时立刻报错。

## 降级行为

- 未挂载 `ctx.fs` provider：每会话警告一次，不贡献任何内容（无 provider 的产品仍可启动）。
- 规则目录暂不可用（provider 错误）：警告一次；该会话快照跳过它，新会话重试。
- 读取有界（`maxFileBytes`）且可取消；超过上限的读取跳过并列入说明。

## Model Experience

### 模型看到什么

deployment persona prefix（`deployment:persona-prefix`）之后的一个系统提示词段落，内容为该会话第一次装配时的冻结快照。

#### Token 影响

每会话一次成本，会话生命周期内固定；受 `maxBytes` 约束。

#### KV 缓存影响

会话内前缀稳定：同一会话的各次装配之间段落文本不变，不会让请求前缀失效。新会话组装自己的快照。

## 已知限制

- 快照与会话冻结是设计行为；没有刷新命令。要加载编辑过的规则，请新开会话（或 fork）。
- 没有按文件的条件加载：约定没有本插件会解释的适用性语义，发现的每个文件都无条件注入。特别是 Claude Code `.claude/rules` frontmatter 的条件字段（`paths`、`always` 等）不做求值——这类文件始终注入，frontmatter 与其他文件一样被剥掉。
- 去重按准备后的正文精确匹配：同一文件带空白级差异的镜像（或反之）仍会渲染两次。
- 冻结快照是按活跃 agent 键控的进程内存，不持久化到会话日志（按 DSH 架构，系统提示词在装配时重建）。

## 开发

```sh
pnpm install
pnpm run build   # tsc -> lib/
pnpm test        # vitest（单元测试 + 基于内存文件系统的环境无关集成测试）
# 自包含冒烟测试（fixture 在系统临时目录；构建后运行）
node tests/user-paths.smoke.mjs
node tests/scope.smoke.mjs
node tests/real-fs.smoke.mjs
node tests/symlink.smoke.mjs
```
