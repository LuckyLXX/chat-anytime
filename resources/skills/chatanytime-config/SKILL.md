---
name: ChatAnyTime 配置
description: 当用户想给 ChatAnyTime 增加或修改「资源配置」——接入 MCP 服务器、写一个技能 Skill、加一条自定义斜杠命令、配一条钩子 Hooks、定义子智能体（子代理）——或者问「我加的配置为什么没生效」时使用。含各配置文件的位置、可落盘的格式与示例、以及改完怎么让它生效。
---

# 帮用户配置 ChatAnyTime

> 本目录随应用分发（安装目录 `resources/skills/chatanytime-config/`），是**内置资产**：所有工作区可见，随应用升级。
> 要定制就把本目录复制到全局技能目录 `<用户目录>/.pi/agent/pidesktop-skills/chatanytime-config/`（同名覆盖内置）。

ChatAnyTime 的配置分两类，**动手的人不一样**。先分清，再干活：

| 配置面 | 谁动手 | 位置 |
| --- | --- | --- |
| **MCP 服务器 / 技能 Skill / 自定义命令 / 钩子 Hooks / 子智能体** | **你直接写文件**（本 Skill 覆盖的部分） | agent 目录或当前工作区（见第 0 节） |
| 应用设置：模型供应商与密钥、Agent 角色、权限模式、主题外观、浏览器/SSH/电脑控制/Jev 等开关、默认工作区、自动化任务 | **引导用户在设置页点**，不要手改文件 | 应用内「设置」面板 |

> **红线（不要碰）**：`%APPDATA%\chat-anytime\settings.json` 就是设置面板背后的内存状态，应用**下一次任何保存都会整体重写它**——手改的内容会被静默覆盖；而且外部改动要重启应用才读。用户要改设置，就告诉他去哪个分页点哪里。设置页分页：**通用 / 模型服务 / Agent 角色 / 子智能体 / 技能与工具 / 钩子 / 外观 / 用量统计 / 自动化任务**（长期记忆不在设置页，用记忆面板与 `memory_*` 工具管理）。

---

## 0. 先定位目录

资源类配置全部在 **agent 目录**（即 Pi 的 `~/.pi/agent`），**不在工作区里**。先确认它的绝对路径：

```bash
node -e "console.log(require('os').homedir() + '/.pi/agent')"
```

Windows 上通常是 `C:\Users\<用户名>\.pi\agent`。下面统一写作 `<agentDir>`。**写文件一律用绝对路径**（`~` 不保证被展开）。

| 配置 | 全局（所有工作区可见） | 当前项目（只对这个工作区） |
| --- | --- | --- |
| MCP 服务器 | `<agentDir>/mcp.json` | `<工作区>/.mcp.json` |
| 技能 Skill | `<agentDir>/pidesktop-skills/<slug>/SKILL.md` | `<工作区>/.pidesktop-skills/<slug>/SKILL.md` |
| 自定义命令 | `<agentDir>/pidesktop-commands/<名字>.md` | `<工作区>/.pidesktop-commands/<名字>.md` |
| 钩子 Hooks | `<agentDir>/pidesktop-hooks.json` | `<工作区>/.pidesktop-hooks.json` |
| 子智能体 | `<agentDir>/pidesktop-subagents.json` | `<工作区>/.pidesktop-subagents.json` |

- 同名时 **当前项目 > 全局**；技能还多两档更低的来源：`~/.agents/skills/`（共享目录）、安装目录 `resources/skills/`（内置，随包分发）。
- 安装目录里的 `resources/skills/`、`resources/subagents/` 是**只读随包资产**，升级会被覆盖——**不要改**。要覆盖同名，把内容复制到上面的全局或项目路径。
- **这些目录/文件不是预先存在的**：全局档通常已有 `mcp.json`、`pidesktop-commands/`、`pidesktop-hooks.json`、`pidesktop-subagents.json`，而 `pidesktop-skills/` 与**全部项目档**首次使用时往往都不存在（目录存在也可能是空的）。动手前先 `ls` 确认当前状态，不存在就建（`write` 会自动创建父目录）——别假设已存在，也别因为“没有这个文件”就停下来问用户。
- 用户没说作用域就先问一句：「只在这个项目里用，还是所有项目都要用？」

## 1. 通用纪律（每次动手前过一遍）

1. **读写工作区外的文件都会弹权限确认**：`<agentDir>` 在工作区之外，`write`/`edit`/`read` 到那里属于「越界操作」，只有**完全访问（full）**模式自动放行，其它模式会向用户弹权限卡。这是正常设计，不是出错——动手前先说清「我要写哪个文件、写什么」，被拒绝就停下来问用户，**不要用 bash 重定向绕过去**。
   - 如果只需要给当前项目用，优先写工作区内的 `.pidesktop-*` 路径（无权限摩擦）。
2. **合并式文件必须先读后写**：`mcp.json`、`pidesktop-hooks.json`、`pidesktop-subagents.json` 是「一个文件装全部条目」。先 `read` 现有内容，再**保留别人的条目**做增量修改；不要 `write` 覆盖一个你还没读过的文件。
3. **注释会丢**：`mcp.json` 与 `pidesktop-hooks.json` 支持带注释的 JSONC，但一旦整体重写，注释就没了。优先用 `edit` 做增量修改；确实要重写，就告诉用户注释已丢失。
4. **文件与目录可能不存在**：新建前先 `ls` 一下目标目录，别假设文件已存在（全局 `pidesktop-skills/` 与全部项目档首次使用时通常都没有；首次添加 MCP / 钩子 / 子智能体也常要新建整个文件）。
5. **改完必须给生效步骤**（第 7 节），否则用户会以为没生效——这几个配置面**没有文件监听**，不重载就不生效。
6. **不要动这些数据文件**：会话记录 `chatanytime-sessions/`、长期记忆 `pidesktop-memory/`、作品墙 `pidesktop-gallery/`、自动化任务 `pidesktop-automation/`、MCP 授权凭据 `pidesktop-mcp-auth.json`、模型缓存 `models-store.json`，以及 `%APPDATA%\chat-anytime\` 下的 `settings.json`、`credentials.json`、SSH 主机与指纹文件。它们各有 UI 或专用工具（记忆用 `memory_*` 工具、自动化用 `automation_*` 工具、作品墙用 `gallery_publish`）。
7. **敏感值不落盘**：MCP 的 token 用 `bearerTokenEnv` 指向环境变量名（**推荐**），不要把 token 明文写进配置——stdio 的 `env` 与 HTTP 的 `headers` 都是明文存盘的，非必要不写。也不要把密钥写进钩子脚本与本 Skill 产出的文件里。

---

## 2. MCP 服务器

### 文件与格式

`<agentDir>/mcp.json`（全局）与 `<工作区>/.mcp.json`（项目）；文件是 **JSONC**（可带注释），顶层键用 `mcpServers`（另一个可接受的写法是 `mcp-servers`，别两个混用）：

```jsonc
{
  "mcpServers": {
    "<服务器名>": { /* 条目 */ }
  }
}
```

### 两种条目

- **本地命令（stdio）**：`command`（必填，如 `npx`）、`args`（数组）、`env`（可选，`KEY=VALUE`，能不带就不带——里头的值是**明文**存盘）。
- **远程地址（HTTP）**：`url`（必填，必须是 `http://` 或 `https://`）。认证方式三种，可按需组合：
  - 不写认证字段（或 `"auth": "oauth"`）→ 走 **OAuth**：需要授权时该条目上会出现「认证」按钮，点它会打开系统浏览器完成授权（凭据本地保存、长期有效）。
  - `"bearerTokenEnv": "环境变量名"`：Bearer 认证，token 从该环境变量读（**推荐**，不落盘明文）；它优先于 OAuth，并覆盖 `headers` 里的 `Authorization`。
  - `"headers": { "名称": "值" }`：自定义请求头（`X-API-Key`、网关头等），与 Claude Code / Cursor 的 `.mcp.json` 同字段、可直接互抄；**值明文存盘**。假设表里写了 `Authorization` 就不再自动走 OAuth（要强制走就显式写 `"auth": "oauth"`）。
- `"disabled": true`：停用（仍列在面板上，但不连接、不产生工具）。
- 条目里可能还会看到 `"type": "stdio"` 之类**其它 MCP 客户端**写的字段——应用会忽略它们但不会报错，**保留原样**（你也别主动删用户的字段）；`headers` 与 `bearerTokenEnv` 不在此列，它们会被真正使用。

### 示例（可直接照抄后改）

```jsonc
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "company-wiki": {
      "url": "https://mcp.example.com/mcp",
      "auth": "oauth"
    },
    "internal-api": {
      "url": "https://mcp.example.com/internal",
      "bearerTokenEnv": "INTERNAL_MCP_TOKEN",
      "disabled": true
    },
    "gateway": {
      "url": "https://gw.example.com/mcp",
      // 网关/中转站类认证；值明文存盘，能用 bearerTokenEnv 就别写在这
      "headers": { "X-API-Key": "<密钥>" }
    }
  }
}
```

### 名字与工具名

服务器名即配置键（改名等于删除后新建）。它的工具会以 `mcp__<服务器名>__<工具名>` 出现在工具箱里，非法字符会被替换成 `_`。配好后用户就能直接让你调用这些工具（**重载资源之后**）。

### 生效

写进文件后需要**重载资源**（第 7 节）——加载新工具会重建当前会话。stdio 服务器首次启动通常靠 `npx` 拉包，第一次会慢；连不上时提醒用户看设置页里该服务器的状态。

---

## 3. 技能 Skill

### 结构

一个技能 = 一个目录 + 一个 `SKILL.md`：

```
<agentDir>/pidesktop-skills/
└── my-skill/
    ├── SKILL.md          # 必需，目录名即 slug（建议英文短横线）
    └── …                 # 可选：脚本、模板等资产，与 SKILL.md 放在同一目录
```

`SKILL.md` 正文里的相对路径以**该文件所在目录**为基准。技能正文**不进系统提示**：系统提示里只列出技能的 `name` + `description` + 文件路径，模型被调用时才用 `read` 读这个文件，所以正文可以写得很具体（步骤、示例、坑）。

### frontmatter（只有两个字段）

```markdown
---
name: 中文或英文技能名
description: 一句话说明「什么时候该用这个技能」，模型靠它决定是否调用——写清楚触发场景，不要写成功能罗列。
---
```

### 正文怎么写

写给「一个刚拿到任务、手里有 read/bash/edit 等工具的模型」看的操作说明书：

- 开门见山说这个技能解决什么问题、什么时候用。
- 分步骤写清「先做什么、再做什么」，并说明每步用哪个工具。
- 给出可直接照抄的示例（命令、文件片段）。
- 写清硬约束与坑（路径在哪、不能碰什么、失败了怎么办）。
- 别写与任务无关的项目背景，也别指望模型记得你写过的上下文。

### 示例：一个最小可用技能

```markdown
---
name: 周报生成
description: 当用户要生成/更新工作周报（本周做了什么、下周计划）时使用。
---

# 生成工作周报

1. 用 `bash` 跑 `git log --since="7 days ago" --pretty="%h %s"` 收集本周提交。
2. 用 `read` 看 `docs/迭代记录/` 里本周条目，补齐非代码产出。
3. 按「本周完成 / 进行中 / 风险与阻塞 / 下周计划」四段写成 `周报-<YYYY-MM-DD>.md`，放在工作区根目录。
4. 汇报时给出文件路径，并附三行摘要。

约束：只依据实际提交与记录，不要编造进展。
```

### 启停与生效

- 用户在输入框打 `/skill:<技能名>` 可以直接指定用它；不指定时，模型看到系统提示里的技能清单也会自己选用。
- 技能的**启用开关**在设置页「技能与工具」，是逐个技能勾选的；开关状态记在 `<agentDir>/pidesktop-skill-state.json` 里，键是「路径哈希」——**不要手改那个文件**，让用户在设置页点。
- 新建/删除技能目录后要**重载资源**才会出现在技能清单里；只改 `SKILL.md` 正文则**立即生效**（模型下次 `read` 就是新内容）。

---

## 4. 自定义斜杠命令

一个 `.md` 文件 = 一条斜杠命令，**文件名（去掉 `.md`）就是命令名**。用户在输入框打 `/名字` 即可调用。

- 命令名允许：字母、数字、`_`、`-`、中文；**不能含冒号**（会和 `/skill:` 前缀冲突）。
- frontmatter 只认 `description`（显示在命令菜单副标题里，可省略）。
- 正文就是**提示词模板**：`$ARGUMENTS` 或 `${ARGUMENTS}` 会被用户输入的命令行参数替换；没写占位符时，参数会追加在模板末尾。

### 示例：`<agentDir>/pidesktop-commands/审查.md`

```markdown
---
description: 审查指定文件或目录，输出问题清单
---

审查 `$ARGUMENTS`：

1. 先读代码，建立事实，不要凭文件名猜测实现。
2. 只报有证据的问题，逐条写清 `文件:行号` → 问题 → 后果 → 建议。
3. 区分「真实缺陷」与「风格偏好」，别为凑数编问题。
4. 输出末尾给一句结论：可以提交 / 修完再提交。
```

### 生效

正文改了**下次发送即热生效**（每次发送都会重读文件）；**新增或删除**命令文件后需要**重载资源**才会出现在 `/` 菜单里。

---

## 5. 钩子 Hooks

### 文件与合并

`<agentDir>/pidesktop-hooks.json`（全局）与 `<工作区>/.pidesktop-hooks.json`（项目），**JSONC**，顶层是数组：

```jsonc
{ "hooks": [ /* 规则 */ ] }
```

两个作用域的规则**按 `name` 合并**（项目同名覆盖全局）。总开关在设置页「钩子」里的「启用钩子」；规则上的 `"disabled": true` 是单条停用。

### 事件

| event | 触发时机 |
| --- | --- |
| `session_start` | 会话创建完成；命令动作会被**等待完成**（环境准备语义，失败只告警不阻断） |
| `tool_call` | 工具执行**前**；只有这个事件支持拦截（`block` / `command.blocking`） |
| `tool_execution_end` | 工具执行完成后（如「改完即格式化」） |
| `agent_end` | 一次完整回复结束（含全部工具轮次），只触发一次；带累计 token 用量 |
| `turn_end` | 每个模型调用小轮结束，一次回复会触发多次；大多数场景用 `agent_end` |

### 四种动作

| kind | 字段 | 说明 |
| --- | --- | --- |
| `notify` | `title?` `body?` | 桌面通知。正文支持占位符：`{event}` `{sessionId}` `{sessionTitle}` `{agentName}` `{workspace}` `{toolName}` `{durationMs}` |
| `http` | `url`（必填，http/https） | 把上下文 JSON 以 POST 推给该地址（10 秒超时，失败只记日志） |
| `block` | `deny`（至少一条正则） | **只能挂 `tool_call`**；任一正则命中即否决这次工具调用 |
| `command` | `command`（必填）、`blocking?` | 用 shell 执行命令（Windows 下即 `cmd`），cwd = 工作区；`blocking: true` **只能挂 `tool_call`** |

通用字段：`name`（必填、≤64 字符、同文件内唯一）、`event`（必填）、`matcher?`（工具名正则，仅工具事件有意义，省略即匹配全部）、`disabled?`、`timeoutMs?`（1000–120000，缺省 10000，只对 `command` 有意义）。

### 匹配与上下文

- **匹配文本**：`bash` / `powershell` 匹配**命令行原文**；其它工具匹配参数的 JSON 串（含 `path` 等）。
- **命令动作的输入**：完整上下文 JSON 从 **stdin** 传入（字段同 HookContext：`event`/`sessionId`/`sessionTitle`/`agentName`/`workspace`/`toolName`/`toolInput`/`isError`/`durationMs`/`usage`），同时提供环境变量 `HOOK_EVENT`、`HOOK_SESSION_ID`、`HOOK_SESSION_TITLE`、`HOOK_AGENT`、`HOOK_WORKSPACE`、`HOOK_TOOL`。
- **阻断判定**（`blocking: true`）：退出码 **2**，或 stdout 输出 `{"block":true,"reason":"…"}`。其余情况不阻断。
- 钩子命令**不走权限门**（用户自己的配置、终端级信任）——所以别写危险命令，也别把用户没要求的删除/推送类动作塞进去。

### 完整示例

```jsonc
{
  "hooks": [
    {
      "name": "禁止强推",
      "event": "tool_call",
      "matcher": "^(bash|powershell)$",
      "action": { "kind": "block", "deny": ["git\\s+push[^\\n]*--force"] }
    },
    {
      "name": "写完即格式化",
      "event": "tool_execution_end",
      "matcher": "^(write|edit)$",
      "timeoutMs": 60000,
      "action": { "kind": "command", "command": "npx prettier --write ." }
    },
    {
      "name": "跑完通知",
      "event": "agent_end",
      "action": { "kind": "notify", "title": "ChatAnyTime", "body": "「{sessionTitle}」已完成（{durationMs}ms）" }
    },
    {
      "name": "手机推送",
      "event": "agent_end",
      "disabled": true,
      "action": { "kind": "http", "url": "https://example.com/hook" }
    }
  ]
}
```

### 生效

改完文件后需要**重载资源**（钩子规则是缓存的，触发时不会重读磁盘）。改完可以请用户在设置页「钩子」里点「测试」验证单条规则。

---

## 6. 子智能体

### 文件与作用域

- `<agentDir>/pidesktop-subagents.json`（全局）、`<工作区>/.pidesktop-subagents.json`（项目）；顶层是数组：`{ "subagents": [ … ] }`。
- 格式是**纯 JSON（不支持注释）**，与 MCP/钩子不同，写错一个字符整个文件失效。
- 内置三条（`code-reviewer`、`explorer`、`general-purpose`，随应用分发在安装目录 `resources/subagents/`）**只读**：用户定义按 `id` 或**同名**整体顶掉内置；要改内置的运行参数（**执行模型 / 思考等级**）请引导用户在设置页「子智能体」里点该行的「执行设置」选择。
- 子代理**不继承**钩子、浏览器、设计模式等扩展能力。

### 字段

| 字段 | 约束 |
| --- | --- |
| `id` | 必填，≤64 字符，建议英文短横线（委派时用它） |
| `name` | 必填，≤64 字符，展示名（也可用于委派匹配） |
| `description` | 一句话说明「什么时候委派给它」，主会话靠它决定是否委派 |
| `systemPrompt` | 必填，≤20000 字符，写给子代理的完整工作说明 |
| `tools` | `"inherit"` 或**完整的 8 项布尔表**：`read`/`bash`/`powershell`/`edit`/`write`/`grep`/`find`/`ls`（缺项按默认值补，只读型就只开 `read`/`bash`/`grep`/`find`/`ls`） |
| `model` | 可选，`{ "provider": "…", "id": "…" }`；省略即继承主会话模型 |
| `thinkingLevel` | 可选，`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`；省略即继承主会话当前档位。注意 `off`（关思考）是**显式档位**，与「省略 = 继承」不同。子模型不支持的档位会被自动降级到最近可用档（上游不会报 400）；委派卡片上显示的是**实际生效**的档位 |
| `color` | 可选，展示色（如 `amber` / `blue` / `violet`） |
| `injectAgentsMd` | 可选，`true` 时把工作区 AGENTS.md 注入子代理系统提示 |

### 示例：一个只读的变更说明写手

```json
{
  "subagents": [
    {
      "id": "changelog-writer",
      "name": "changelog-writer",
      "description": "根据 git 改动起草变更日志（发布说明、CHANGELOG 条目）。用户要写版本说明、整理本次改动时委派。只读分析，不改代码。",
      "color": "blue",
      "injectAgentsMd": true,
      "tools": {
        "read": true,
        "bash": true,
        "powershell": false,
        "edit": false,
        "write": false,
        "grep": true,
        "find": true,
        "ls": true
      },
      "systemPrompt": "你是变更日志写手，被主会话委派根据实际代码改动起草发布说明。\n\n只读：不修改任何文件。先用 git diff / git log / git show 建立事实。\n\n输出要求：\n- 按「新增 / 修复 / 变更 / 移除」分组，每条一句话，说清对用户的影响。\n- 每条都能对应到具体改动；无法归类的宁可不写。\n- 不要复述提交信息原文，改写成用户能看懂的话。\n- 最后给出建议的版本号变更级别（补丁 / 次版本 / 主版本）与理由。"
    }
  ]
}
```

### 生效

改完需要**重载资源**（定义是启动/建会话时读取的）；内置子代理的「执行模型 / 思考等级」例外——改完下次委派即生效。

---

## 7. 改完怎么生效（速查）

| 改了什么 | 怎么生效 |
| --- | --- |
| 技能 `SKILL.md` **正文**、命令 `.md` **正文** | **立即**（模型下次 `read` / 用户下次发送时重读） |
| **新增/删除** 技能目录、命令文件，以及 MCP / 钩子 / 子智能体配置 | 让用户到 **设置 →「技能与工具」右上角点「重载资源」**（会重建当前会话，聊天历史保留）。需要已打开工作区，且当前会话不在生成中（忙时先等这次回复结束）。实在不行：重启应用 |
| 应用设置（模型、角色、权限、外观、各能力开关） | 一律引导用户在「设置」对应分页里改（不要手改 `settings.json`） |
| 钩子规则临时验证 | 设置 →「钩子」→ 单条规则的「测试」 |

告诉用户时的说法要具体，例如：「MCP 配置已写进 `…/mcp.json`。请在 **设置 → 技能与工具** 点右上角「重载资源」，然后就能用 `mcp__docs__*` 这些工具了。」

## 8. 排错清单

用户说「配了没用」时，按顺序查：

1. **有没有重载**：第 7 节——除技能/命令正文外都需要重载资源或重启。
2. **文件是不是合法 JSON**：`pidesktop-subagents.json` 是纯 JSON（不能有注释）；MCP 与钩子允许注释，但用 `JSON.parse` 检查会因此误报——直接 `read` 看内容，或让用户在设置页看报错。
3. **作用域对不对**：项目文件只在打开那个工作区时生效；写到了 `<agentDir>` 才是全局。
4. **技能**：目录里是不是叫 `SKILL.md`（大小写敏感）、frontmatter 有没有 `name`/`description`、技能在设置页是不是被关掉了。
5. **命令**：文件名有没有非法字符（冒号等）、是不是 `.md` 结尾；新增后要重载资源才会出现在 `/` 菜单。
6. **MCP**：设置页「技能与工具」看该服务器状态（已连接 / 未连接 / 需认证）；stdio 依赖 `npx` 是否可用、HTTP 地址是否可达；需要 OAuth 的去点「认证」。
7. **钩子**：总开关「启用钩子」是否勾选、规则 `disabled` 是否为 true、`event` 与动作是否匹配（`block` 只能挂 `tool_call`）、`matcher` 正则是否写错（匹配的是工具名，不是文件路径）。
8. **子智能体**：`id` 与 `name` 是否与内置冲突（同名会整体覆盖内置）、`tools` 表是否把需要的工具关了、描述是否写清触发场景（主会话看不到适用场景就不会委派）。
