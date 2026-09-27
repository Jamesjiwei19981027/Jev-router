# Jev Agent Hosts

**中文** | [English](README.en.md)

为编程 Agent 接入一层 Jev 决策能力：通过同一个本地共享运行时，给 **Claude Code、Codex、Pi、Antigravity** 提供两项功能：**由 Jev 决定保留哪些工具结果的上下文压缩**，以及**只做决策的能力路由**。

[Jev](https://github.com/BillionsBobby/JevRouter#readme) 是一个结构化决策模型。你向它提一个有固定格式的问题，比如"这些工具结果里哪些还有用？"或者"下一步用哪个能力最合适？"，它会返回一个结构化的答案，并附带置信度。本项目把这类决策接入各个 Agent 自身的运行流程；一旦 Jev 不可用，Agent 就自动回到自己原本的行为。

> **项目状态：** 早期版本，以 Windows 为主。下文内容都在 Windows 11 + Node.js 24 上测试过，macOS 和 Linux 还没有测试。哪些功能已经在真实的 Agent 环境里验证过，请看[验证状态](#验证状态)。

---

## 兼容矩阵

| Agent | 上下文压缩 | 能力路由 | 接入位置 |
| :--- | :--- | :--- | :--- |
| **Claude Code** | —（见[上游项目](#上游项目)） | ✅ `jevrouter` 技能 + 全局路由规则 | `~/.claude/skills/jevrouter/`、`~/.claude/CLAUDE.md` |
| **Codex**（CLI / 桌面版） | ✅ 通过 save-token-jev 的 hooks（`PreCompact` + `SessionStart(compact)`） | ✅ `jevrouter` 技能 + 全局路由规则 | `~/.codex/hooks.json`、`~/.codex/skills/jevrouter/`、`~/.codex/AGENTS.md` |
| **Pi**（`@earendil-works/pi-coding-agent`） | ✅ `session_before_compact` 扩展 | ✅ `jev_route` 工具 + `/jev` 命令 | `~/.pi/agent/extensions/` |
| **Antigravity** | ✅ 证据召回（`PostToolUse` + `PreInvocation` hooks） | ✅ `jev-router` 技能插件 | `~/.gemini/config/plugins/` |

各列说明：

- **上下文压缩**：Agent 压缩上下文时，由 Jev 逐个判断工具调用：保留完整结果、只保留截断后的结果，还是把调用和结果一起删掉。用户和助手说过的话一个字都不改。
- **能力路由**：当 Agent 面对多个工具、模型或子 Agent 需要选择时，请 Jev 选出一个。路由**只给建议**，不会自动执行选中的能力，Agent 原有的权限检查和确认步骤照常生效。
- **Antigravity** 没有提供替换压缩逻辑的接口，所以这里的做法是：每次工具调用后记录证据，每次调用模型前把这些证据的精简摘要重新注入上下文。它**不会**替换 Antigravity 自带的压缩。

---

## 工作原理

```
                    ┌──────────────────────────── Jev System One 接口
                    │                               (POST /v1/systemone)
                    ▼
        ┌───────────────────────┐
        │  共享运行时            │  ~/.jev-agent/bin
        │  jev-agent (doctor /  │  · 从受保护的文件读取密钥
        │  route / ask)         │  · 超时控制、错误脱敏、只输出 JSON
        │  JevRouter 与          │  · 从不执行选中的能力
        │  save-token-jev 启动器 │
        └──────────┬────────────┘
     ┌─────────────┼──────────────┬─────────────────┐
     ▼             ▼              ▼                 ▼
 Claude Code     Codex            Pi            Antigravity
 技能 + 规则     技能 + 规则      扩展           插件
                 压缩 hooks       (压缩 + 路由)  (证据召回 + 路由技能)
```

Pi 和 Antigravity 的压缩适配器共用一个与宿主无关的保留引擎（`packages/core`）：

```
宿主上下文 ──capture──▶ ToolEvidence[] ──Jev──▶ RetentionPlan ──apply──▶ 宿主结果
```

**引擎强制保证的安全规则：**

- 工具调用和它的结果永远**一起**保留、一起截断、一起删除。
- 第一条消息、最近的若干条消息，以及找不到对应调用的工具结果（孤儿结果）都会被固定，永不删除。
- Jev 出现任何故障（超时、返回格式异常、缺少密钥），都会自动回退到宿主原本的行为。
- 适配器存储或记录的所有内容，都会先抹掉凭证和 `Authorization` 请求头。

---

## 环境要求

- Node.js **≥ 22.6**（测试依赖 `--experimental-strip-types`）
- Git（用于拉取锁定版本的上游项目）
- 一个兼容 Jev System One 的接口地址，以及对应的 API 密钥
- 已安装至少一个支持的 Agent

---

## 快速开始

```powershell
git clone https://github.com/Jamesjiwei19981027/Jev-router.git
cd Jev-router
npm install
npm test
```

### 1. 配置接口地址和密钥

项目**不内置任何默认接口地址**，需要自行设置：

```powershell
# Windows（用户级环境变量）
setx JEV_API_URL "https://<你的-jev-接口>/v1/systemone"
setx JEV_MODEL   "jev-1.13.0"
```

```bash
# macOS / Linux（未测试）
export JEV_API_URL="https://<你的-jev-接口>/v1/systemone"
export JEV_MODEL="jev-1.13.0"
```

把 API 密钥保存到下面这个文件，并确保只有你自己的账户能读取。不要把密钥写进提示词、命令行参数或本仓库：

```
~/.jev-agent/secrets/typesafe_api_key
```

### 2. 安装共享运行时和上游工具

```powershell
npm run setup
```

这一步会把共享运行时安装到 `~/.jev-agent/bin`，再把锁定版本的上游项目（JevRouter 和 save-token-jev）克隆到 `~/.jev-agent/vendor/` 并完成构建。上游代码是在安装时拉取的，本仓库里不包含上游源码。

### 3. 部署到你使用的 Agent

```powershell
npm run deploy -- --host claude-code   # jevrouter 技能 + CLAUDE.md 路由规则
npm run deploy -- --host codex         # jevrouter 技能 + AGENTS.md 规则 + 压缩 hooks
npm run deploy -- --host pi            # 压缩扩展 + 路由扩展
npm run deploy -- --host antigravity   # 证据召回插件 + 路由技能插件
npm run deploy -- --host all
```

部署可以重复执行，结果不变。每个要改动的文件都会先备份到 `~/.jev-agent/backups/<时间戳>/`。`CLAUDE.md` 和 `AGENTS.md` 里的全局规则写在 `<!-- jev-agent:global-routing-v1 -->` 标记之间，重复部署不会重复写入。

### 4. 检查配置

```powershell
npm run doctor
```

`doctor` 会检查接口是否可达、提供了哪些模型，输出中不包含任何凭证。

部署后，请完全重启 Claude Code、Codex 和 Pi。在 Codex 中打开 `/hooks`，信任那两条 save-token-jev 的 hook。Antigravity 会自动加载 `~/.gemini/config/plugins/` 下的插件，不需要重启。

---

## 配置项

| 变量 | 必填 | 默认值 | 作用 |
| :--- | :---: | :--- | :--- |
| `JEV_API_URL` | ✅ | — | 完整的 Jev 接口地址，例如 `https://…/v1/systemone`；只写到 `/v1` 也可以 |
| `JEV_MODEL` | | `jev-1.13.0` | Jev 模型 ID |
| `TYPESAFE_API_KEY_FILE` | | `~/.jev-agent/secrets/typesafe_api_key` | 密钥文件路径。文件存在时以文件为准，文件为空也不会改用环境变量 |
| `TYPESAFE_API_KEY` | | — | 仅在密钥文件不存在时使用 |
| `JEV_TIMEOUT_MS` | | 运行时默认值 | 单次请求超时时间 |
| `JEV_DATA_DIR` | | `~/.jev-agent/data/antigravity` | Antigravity 插件按对话保存证据的目录 |

---

## 使用方式

**Pi**

- 压缩是自动的：每当 Pi 压缩上下文（达到阈值时，或手动执行 `/compact` 时），扩展都会先请 Jev 做决策。
- `/jev-compact-status` 显示最近一次决策：有多少工具调用被保留、截断或删除，以及估算节省的 token 数。如果 Jev 选择全部保留，会显示 `Result: Jev kept all, Pi native compaction used`。
- `/jev <文本或 JSON>` 用来做一次路由冒烟测试；模型也可以通过 `jev_route` 工具自行调用路由。

**Codex**

- 压缩通过 save-token-jev 自动完成：Codex 压缩前，`PreCompact` 先给上下文打分；压缩完成后，`SessionStart(source="compact")` 立即恢复被保留的原文。

**Claude Code 与 Codex 的路由**

- 遇到需要做选择的时候，全局规则会让 Agent 先声明 `JevRouter: routing the next step`，然后调用共享运行时，并报告决策结果和置信度。

**Antigravity**

- 每次工具调用后记录一条证据，每次调用模型前注入一段 `[Jev Evidence Recall]`。证据按对话保存在 `JEV_DATA_DIR` 下，每条的输出最多 1000 字符、参数最多 500 字符，并已脱敏。

---

## 验证状态

| 宿主 / 功能 | 状态 | 依据 |
| :--- | :--- | :--- |
| 自动化测试 | ✅ 通过 | `npm test`：保留引擎、Pi 适配器、Antigravity 插件、部署脚本 |
| 共享运行时 `doctor` / `route` | ✅ 在线测试 | 用合成请求调用真实接口 |
| Pi：扩展加载 | ✅ 真实宿主 | 两个扩展都能通过 Pi RPC 的 `get_commands` 查到 |
| Pi：真实压缩调用 Jev | ✅ 真实宿主 | 在一次 Pi RPC 会话中，Jev 被调用，保留了全部 8 个工具调用，随后执行了 Pi 原生压缩 |
| Pi：真实宿主上 Jev 删除/截断 | ⏳ 尚未观察到 | 真实运行中 Jev 还没有选择过删除或截断；这条路径由自动化测试覆盖 |
| Pi：TUI 中 `/jev-compact-status` 的显示 | ⏳ 待人工检查 | |
| Antigravity：证据召回 | ✅ 真实宿主 | 真实对话中捕获了 60 条证据（0 条兜底文本），召回成功注入，凭证已脱敏 |
| Antigravity：路由技能 | 🟡 已加载 | 已出现在 Antigravity 的 Customizations 面板中；路由调用只用合成输入验证过 |
| Codex：压缩 hooks | 🟡 合成输入 | 用合成的 `PreCompact` / `SessionStart(compact)` 跑通了完整流程；还没有执行过真实的 `/compact` |
| Claude Code / Codex：路由 | 🟡 合成输入 | 通过共享运行时调用真实接口，但候选项是合成的 |

图例：✅ 已验证 · 🟡 仅用合成输入验证 · ⏳ 待验证

---

## 目录结构

```
packages/
  runtime/              共享运行时：jev-agent CLI + JevRouter / save-token-jev 启动器
  core/                 与宿主无关的保留引擎（证据 → Jev 计划 → 应用）
  pi-adapter/           Pi 压缩扩展
  pi-router/            Pi 的 jev_route 工具和 /jev 命令
  antigravity-plugin/   Antigravity 证据召回插件（PostToolUse / PreInvocation）
  antigravity-router/   Antigravity jev-router 技能插件
  claude-code/          jevrouter 技能 + CLAUDE.md 路由规则
  codex/                jevrouter 技能 + AGENTS.md 路由规则 + hooks.json 模板
scripts/                安装、部署（按宿主，带备份）、自检
tests/                  自动化测试（没有 JEV_API_URL 或密钥时自动跳过在线冒烟测试）
docs/                   架构说明和验证记录
```

---

## 卸载

每次部署前都会先备份到 `~/.jev-agent/backups/<时间戳>/`。要回滚某个宿主，删除上文列出的该宿主相关文件，再从最近一次备份中恢复即可。`CLAUDE.md` 或 `AGENTS.md` 里 `jev-agent:global-routing-v1` 标记之间的规则块需要手动删掉，密钥文件也要单独删除。

---

## 安全说明

- API 密钥从仓库之外的文件读取，任何适配器都不会把它写进提示词、命令行参数、日志或证据文件。
- 存储的证据和错误信息都会脱敏：API 密钥、token、密码，以及 `Authorization: Bearer|Basic …` 凭证。
- 读取转录文件时限制读取量：只读转录的末尾部分和步骤输出的开头部分，不会把整个大文件读进内存。
- 路由集成永远不会自行执行任何能力。

如果发现安全问题，请通过私密的 security advisory 报告，不要发公开 issue。

---

## 上游项目

本项目基于两个 MIT 许可的开源项目，执行 `npm run setup` 时会拉取它们锁定的版本：

- **[JevRouter](https://github.com/BillionsBobby/JevRouter)**（`f944acb`）：基于 Jev 的纯决策能力路由。
- **[save-token-jev](https://github.com/IAmUnbounded/save-token-jev-clean)**（`a700735`）：由 Jev 决定保留内容的上下文压缩。上游还支持 Claude Code 压缩、OpenCode 和 Anthropic API；本仓库目前只部署了其中的 Codex 集成。

## 许可证

[MIT](LICENSE)。上游项目保留各自的许可证。
