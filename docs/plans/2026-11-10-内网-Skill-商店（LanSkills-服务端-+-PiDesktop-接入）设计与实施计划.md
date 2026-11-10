# PiDesktop 内网 Skill 商店（LanSkills 服务端 + 客户端接入）设计与实施计划

> **本轮交付物 = 本设计/实施计划文档。不改任何代码、不改依赖、不实施。** 用户 2026-11-10 明确要求「先设计一下方案」；实施须在评审通过后另起一轮完成（建议按 §6 分两轮：先服务端、后客户端）。本文自包含，可交由全新会话仅凭此文档落地。

## 1. 背景、目标与已确认决策

**现状**：PiDesktop 的「Skill 商店」(`src/renderer/src/SkillStoreSettings.tsx` + `src/main/skill-store-client.ts`) 直连外网 `https://api.skillhub.cn`（腾讯 SkillHub Open API）。`SKILL_STORE_BASE_URL` 是写死的常量（`src/shared/skill-store.ts:14`），内网环境根本连不上，也没有任何来源配置入口。

**需求（用户 2026-11-10 原话整理）**：

1. 我们的 Skill 商店是**内网**用的 → 在设置页的 Skill 商店旁边**新开一个 tab**，叫「内网 Skill 商店」（或「自定义 Skill 商店」）。
2. 再写一个**独立的小项目**：「就是这个 skill 商店」——轻量级、**支持 MCP**、可以**自己上传 skill、更新 skill 版本、下载 skill**，形态**类似 `D:\日常工作区\lanpages`**。

**lanpages 的关键事实（已读代码与文档，实施时照抄它的成熟形态）**：Node 22 + TypeScript ESM + Fastify 5 + better-sqlite3 + adm-zip，SQLite 存元数据、文件落盘、版本目录 rename 原子生效；**手写 MCP JSON-RPC**（无 SDK、Streamable HTTP、兼容 JSON/SSE/batch，见 `src/routes/mcp.ts`）；REST `/api/v1`（`{ok:true,data}` / `{ok:false,error:{code,message}}` 信封）；Web 控制台原生 HTML/CSS/JS 无构建；CLI 带 `--json`；Docker 多阶段 + 非 root + healthcheck；离线部署包脚本；**API/MCP 内网不鉴权、控制台用 `ADMIN_PASSWORD` 会话登录**；测试用 `test/helpers.ts` 的 `startServer()`（临时数据目录 + 随机端口）。

**本轮已定的决策（有实质取舍的地方与结论）**：

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 商店协议 | **自定协议**（`/api/v1`，lanpages 风格信封），不复用 SkillHub 契约 | 两端都由我们实现，契约由自己文档化最干净；SkillHub 的详情形状连官方文档都不符（上一轮踩过），照抄只会把对方的怪癖继承进自己的产品 |
| 客户端接入形态 | 新增**独立设置 tab**「内网 Skill 商店」+ 独立的 `source: "intranet"` 命令分支 | 用户明确要求；与公开商店的状态、缓存、账本互不干扰 |
| 服务端鉴权 | **不做 Token**（内网开放，与 lanpages 一致）；控制台口令登录 | 内网自建；加 Token 会牵出 credentials.json 通道与额外 UI，需求未提。扩展点见 §8 |
| 上限口径 | 服务端硬界 **= 客户端安装硬界**（单文件 1MB / 合计 32MB / 200 文件） | 否则商店里能上传、客户端却装不了；两端同一口径，错误信息在**上传时**就说清楚 |
| 上传/发布入口 | 控制台（zip）、CLI、MCP 三路 | 用户要「自己上传 / 更新版本」；AI 走 MCP，人走控制台/CLI |
| 多内网源 | MVP **单源**（一个地址），协议里用 `sourceId` 预留多源 | 单源足够覆盖内网；多源是 UI 与配置的纯增量，不提前付成本 |
| 与公开商店的关系 | 两套 tab 并存、各自独立状态与账本归属 | 互不覆盖；同名 slug 跨源冲突时明确拒绝并说明来源 |

**非目标（本轮不做，见 §8）**：不做服务端 Token/OAuth、不做审核流与多租户、不做对象存储与多副本、不做客户端内「上传到商店」（P1，先用 MCP/CLI/控制台）、不做自动更新（仍只提示「有更新」）、不做 HTTPS 终结（交给反向代理）、不改四档技能目录/扫描/frontmatter/id 语义。

---

## 2. 总体架构

```
┌───────────────────────── 内网（同一网段 / 可达即可） ─────────────────────────┐
│                                                                              │
│  PiDesktop 渲染端                     PiDesktop utility 进程                   │
│  ├ 设置 → 内网 Skill 商店 tab          ├ skill-store.intranet 客户端（fetch）    │
│  │   window.piDesktop.send(...)  ───▶ ├ 安装层（逐文件下载 + sha256 + 原子落盘） │
│  └ 公共 SkillStoreBrowser 组件         └ 装完刷新链（invalidate→sync→emit→重建） │
│            ▲                                     │                            │
│            └──── skill-store-result 推送 ─────────┘                            │
│                                                  │ HTTP /api/v1                │
│                                                  ▼                            │
│                                    LanSkills（新项目，Docker 单镜像）            │
│                                    ├ REST /api/v1（列表/详情/文件/上传/删除）     │
│                                    ├ MCP  /mcp（8 个工具，Streamable HTTP）     │
│                                    ├ Web 控制台 /console/（口令登录）            │
│                                    ├ CLI  lanskills push|ls|pull|rm …         │
│                                    ├ SQLite 元数据 + /data/skills/<slug>/<v>/  │
│                                    └ 版本：每次上传一个新版本，latest 可切换     │
│                                                                              │
│  其它 AI 客户端 / Agent ── MCP ──▶ 同一个 /mcp（发布、查询、下载）               │
└──────────────────────────────────────────────────────────────────────────────┘
```

**客户端命令链**（沿用公开商店的既有形态，`runtime:send` 永不 reject，结果靠推送）：

```
IntranetSkillStoreSettings.tsx
  → window.piDesktop.send({type:"skill-store.list", requestId, source:"intranet", query})
      → main/index.ts  updateSettings()（仅 source.save/clear 落盘）
      → main 注入 baseUrl（配置在主进程；utility 无 Electron API）
      → pi-runtime runSkillStoreCommand() 按 source 分流到 skill-store-intranet-client
      → post({type:"skill-store-result", result:{kind, requestId, source:"intranet", ok, …}})
      → store.ts 按 result.source 路由到 intranetStore 切片
```

---

## 3. 两端契约（先定协议，再各自实现）

### 3.1 通用约定

- Base URL：客户端配置项，形如 `http://skills.corp.local:8080`；**允许带路径前缀**（`http://corp.local/store`）——拼接前统一去尾斜杠、再拼 `/api/v1/...`。只允许 `http:` / `https:`。
- 响应信封：成功 `{ok:true,data:{…}}`；失败 `{ok:false,error:{code,message,details?}}`（**中文 message**，与 lanpages 一致）。
- 时间：毫秒整数。
- 无鉴权（内网），不要求任何请求头；客户端可带 `User-Agent: PiDesktop/<version>`（服务端只记日志，不校验）。
- 分页：`page` 从 1 开始，`pageSize` 1–100，默认 20。

### 3.2 HTTP 端点

| # | 方法 / 路径 | 用途 | 关键参数 | 返回 data |
| --- | --- | --- | --- | --- |
| 1 | `GET /healthz` | 存活探针（Docker healthcheck） | — | `{ok:true,service:"lanskills",version,time}`（**注意 lanpages 的 healthz 不在 /api/v1 下，照抄**） |
| 2 | `GET /api/v1` | 服务信息与端点清单 | — | `{name,version,description,endpoints,limits}` |
| 3 | `GET /api/v1/ping` | 客户端「测试连接」 | — | `{name,version,skillCount,limits:{maxFileBytes,maxTotalBytes,maxFiles},baseUrl}` |
| 4 | `GET /api/v1/skills` | 列表 / 搜索 / 分类 / 排序 / 分页 | `page` `pageSize` `keyword` `category` `sortBy`(`updated_at`\|`name`\|`created_at`) `order`(`asc`\|`desc`) | `{total,page,pageSize,skills:Skill[]}` |
| 5 | `GET /api/v1/categories` | 分类字典（由已有技能聚合，不另立字典表） | — | `{items:[{key,name,count}]}` |
| 6 | `GET /api/v1/skills/:slug` | 详情 + 版本 + 指定版本文件清单 | `version?`（缺省 latest） | `{skill:Skill, latestVersion:Version, versions:Version[], files:File[], totalBytes}` |
| 7 | `GET /api/v1/skills/:slug/versions` | 版本列表（倒序） | — | `{versions:Version[]}` |
| 8 | `GET /api/v1/skills/:slug/files` | 文件清单（**安装与校验的唯一真源**） | `version?` | `{version,files:File[],totalBytes}` |
| 9 | `GET /api/v1/skills/:slug/file` | 单文件字节 | `path` `version?` | 原始字节；响应头 `X-Content-SHA256`、`Content-Type`、`ETag` |
| 10 | `GET /api/v1/skills/:slug/zip` | 整包 zip（给 CLI / 人工下载） | `version?` | `application/zip`，`Content-Disposition: attachment; filename="<slug>-<version>.zip"` |
| 11 | `POST /api/v1/skills` | 新建技能（首次上传） | JSON 或 `application/zip` | `{skill,version}` → 201 |
| 12 | `POST /api/v1/skills/:slug/versions` | 上传新版本 | 同上 | `{skill,version}` → 201 |
| 13 | `PATCH /api/v1/skills/:slug` | 改元数据（name/description/category/tags） | JSON | `{skill}` |
| 14 | `POST /api/v1/skills/:slug/versions/:version/activate` | 把某历史版本设为 latest（回滚） | — | `{skill,latestVersion}` |
| 15 | `DELETE /api/v1/skills/:slug/versions/:version` | 删一个非 latest 版本 | — | `{deleted:version}` |
| 16 | `DELETE /api/v1/skills/:slug` | 删技能（含全部版本） | `?confirm=<slug>` 必填 | `{deleted:slug}` |

**上传载荷（#11/#12）** 三种二选一：

```jsonc
// A. JSON + zipBase64
{ "slug": "code-review", "name": "代码审查", "description": "…", "category": "dev",
  "tags": ["review"], "version": "1.2.0", "changelog": "修复…", "zipBase64": "UEsDB…" }

// B. JSON + files（小文本技能，控制台粘贴/脚本生成）
{ "slug": "code-review", "version": "1.2.0",
  "files": [ { "path": "SKILL.md", "text": "---\nname: …\n---\n…" },
             { "path": "scripts/check.py", "base64": "IyEv…" } ] }

// C. 原始 zip body：Content-Type: application/zip
//    元数据走 query/header：?slug=code-review&version=1.2.0&changelog=…&name=…
```

### 3.3 数据形状

```ts
interface Skill {              // 列表项（轻量）
  slug: string; name: string; description: string;
  category: string; tags: string[];
  version: string;             // = latest 版本号
  fileCount: number; totalBytes: number; versionCount: number;
  createdAt: number; updatedAt: number;
}
interface Version {
  version: string; changelog: string; createdAt: number;
  fileCount: number; totalBytes: number;
}
interface File { path: string; size: number; sha256: string }   // 相对路径、正斜杠
```

- `Skill.name` / `description` 若上传体没给，由服务端从 `SKILL.md` frontmatter 解析兜底（**只认单行 `name:` / `description:`**，与 `src/main/skill-catalog.ts:49-67` 的口径一致，避免"商店里有名字、装上后没名字"）。
- `slug` 由上传体给或从 `name` 派生：小写、非字母数字转 `-`、压缩连续 `-`、`^[a-z0-9][a-z0-9-]{0,62}$`（与 lanpages `assertValidSlug` 同源）。派生失败时报 `invalid_slug` 要求显式给 `slug`。

### 3.4 错误码（`error.code`）

| code | HTTP | 场景 |
| --- | --- | --- |
| `invalid_slug` | 400 | slug 为空/不合规/是保留字 |
| `empty_upload` | 400 | 没有 zip / files / 原始 zip body |
| `invalid_path` | 400 | 包内路径穿越、绝对路径、盘符/ADS、控制字符、保留名、超长 |
| `missing_skill_md` | 400 | 包根缺少 `SKILL.md` |
| `invalid_version` | 400 | 版本号不合规 |
| `version_exists` | 409 | 同一技能下版本号重复 |
| `skill_not_found` | 404 | slug 不存在 |
| `version_not_found` | 404 | 指定版本不存在 |
| `file_not_found` | 404 | 清单里没有该文件（或磁盘缺失） |
| `confirm_required` | 400 | 删除技能未带 `?confirm=<slug>` |
| `too_large` | 413 | 单文件超限 / 合计超限（message 写明具体文件与上限） |
| `too_many_files` | 413 | 文件数超限 |
| `payload_too_large` | 413 | Fastify bodyLimit 触发的传输层上限（message 英文，属已知事实，客户端映射成中文兜底） |
| `version_limit` | 409 | 版本数超过 `MAX_VERSIONS_PER_SKILL`（自动清理最旧时不会触发） |
| `internal_error` | 500 | 未预期错误（日志留堆栈，响应不泄漏） |

### 3.5 上传、版本与一致性规则（服务端硬性）

1. **sha256 一律服务端计算**，绝不信任上传体里的哈希。
2. **不写半套**：先把所有文件写进 `<DATA_DIR>/tmp/<uploadId>/` → 校验（文件数、根 `SKILL.md`）→ 版本目录 rename 生效 → 最后写 DB 事务。任何一步失败：删 tmp/版本目录，DB 不动。
3. **zip-slip 防护**：每个条目过 `sanitizeRelPath`（拒绝 `..`/绝对/盘符/NTFS ADS 冒号/控制字符/Windows 保留名/超长/结尾点或空格），落盘一律 `safeJoin(root, rel)`；**跳过符号链接**；过滤 `__MACOSX/`、`.DS_Store`、`Thumbs.db`、`desktop.ini`。
4. **自动去单一顶层目录**：当所有条目共享同一顶层段、且包根没有文件时剥掉它（`zip my-skill/` → 解出来是 `my-skill/SKILL.md`）；判断必须有反例测试（根下已有文件时不剥）。
5. **版本号**：`^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$`；缺省时自动递增——latest 若是 `x.y.z` → `x.y.(z+1)`，否则 `<latest>-1`，首次为 `1.0.0`；同技能内唯一（`version_exists`）。
6. **latest 切换**：`activate` 只改 `skills.latest_version_id`，不复制文件；删除 latest 版本前必须先把 latest 指到另一个版本（或该操作直接拒绝 `version_limit`/专用错误文案）。
7. **版本保留**：超过 `MAX_VERSIONS_PER_SKILL`（默认 20）时，上传成功后自动删**最旧的非 latest** 版本（先删 DB 行，再删盘；失败只留孤儿目录并记日志，不允许出现"DB 指向不存在的目录"）。
8. **删除顺序**：删技能 = 先删 DB（事务：versions → skill）→ 再删 `<DATA_DIR>/skills/<slug>/`；盘删除失败只记日志并返回"已删除，磁盘残留待清理"的附注字段，客户端不因此报错。

### 3.6 MCP（Streamable HTTP，手写 JSON-RPC，照 `lanpages/src/routes/mcp.ts`）

- 端点 `/mcp`，支持 `initialize` / `ping` / `tools/list` / `tools/call` / `resources/list` / `resources/read` / `prompts/list`（空）/ `notifications/*`（忽略），兼容 `application/json` 与 `text/event-stream` 两种响应、batch、`Mcp-Session-Id`、协议版本 `2025-06-18|2025-03-26|2024-11-05`。
- `serverInfo.name = "lanskills"`，中文 instructions 写清：内网不鉴权、单文件 1MB / 合计 32MB / 200 文件的上限、`publish_skill` 优先用 `files`，大包用 `zipBase64`，PiDesktop 客户端在同一网段可直接安装。

**8 个工具**：

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `list_skills` | `keyword?` `category?` `limit?` | 返回技能数组（含 latest 版本、体积、更新时间） |
| `get_skill` | `slug` | 详情 + 版本 + 文件清单 |
| `get_skill_file` | `slug` `path` `version?` | 文本 ≤256KB 直接返回文本；二进制返回 base64 并标注 `encoding:"base64"` |
| `publish_skill` | `slug?` `name?` `description?` `category?` `tags?` `version?` `changelog?` `files?` \| `zipBase64?` | 存在则发新版本、不存在则新建；返回 slug/版本/文件数/下载 URL |
| `set_latest_version` | `slug` `version` | 回滚/切换 latest |
| `delete_version` | `slug` `version` | 非 latest |
| `delete_skill` | `slug` `confirm` | `confirm` 必须等于 slug |
| `get_store_info` | — | 版本、技能数、限制、baseUrl |

- resources：`lanskills://skills`（全部技能摘要 JSON）、`lanskills://skills/<slug>`（详情 + 版本 + 清单）。
- 工具错误返回 `isError:true` + 中文文案（协议级错误才用 JSON-RPC error），与 lanpages 一致。

### 3.7 硬界（两端必须一致）

| 项 | 默认 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| 单文件 | 1 MB | `MAX_FILE_MB` | 与 PiDesktop `SKILL_FILE_MAX_BYTES` 相同（`src/main/skill-store-install.ts:22`） |
| 合计 | 32 MB | `MAX_TOTAL_MB` | 同上 `SKILL_TOTAL_MAX_BYTES` |
| 文件数 | 200 | `MAX_FILES` | 同上 `SKILL_FILE_COUNT_MAX` |
| 版本数/技能 | 20 | `MAX_VERSIONS_PER_SKILL` | 超出自动清理最旧非 latest |
| 上传 body | 64 MB | `MAX_UPLOAD_MB` | 只为覆盖 zip 编码膨胀，业务上限仍按上表 |

> 服务端**上传时就按客户端的硬界拒绝**，并在 message 里写清「PiDesktop 面板安装的单文件上限是 1MB」。这样不会出现"商店里传上去了，客户端却装不下来"。将来要放宽必须**两端同时改**（写进本文件 §8 与两端 AGENTS.md）。

---

## 4. 服务端项目：LanSkills

### 4.1 位置、命名、技术栈

- 目录：`D:\日常工作区\lanskills`（与 `lanpages` 同级、同样的独立 git 仓库；**不放进 PiDesktop 仓库**——它是独立服务端，进 PiDesktop 会污染 electron-builder 打包）。
- 包名 / CLI / 镜像：`lanskills`；产品名「LanSkills · 内网 Skill 商店」。
- 技术栈：Node ≥20.11（建议 22）+ TypeScript ESM（`module: NodeNext`，相对导入带 `.js`）+ Fastify 5 + better-sqlite3 + adm-zip + mime-types；测试 vitest；`tsx` 开发。

### 4.2 目录结构（照 lanpages 的分层，不要跨层）

```
lanskills/
├─ package.json  tsconfig.json  vitest.config.ts
├─ Dockerfile  docker-compose.yml  .env.example  .dockerignore  .gitignore
├─ AGENTS.md  README.md
├─ docs/{API.md, MCP.md, 部署运维.md, 设计决策.md, 迭代记录.md}
├─ scripts/package-offline.sh
├─ src/
│  ├─ index.ts        启动（loadConfig → createApp → listen）
│  ├─ app.ts          Fastify 装配、错误处理、404、路由注册（照 lanpages app.ts）
│  ├─ config.ts       环境变量 → Config（含 limits 派生值）
│  ├─ context.ts      AppContext {config, store, service, logs?}
│  ├─ db.ts           better-sqlite3 + MIGRATIONS[]（只追加）
│  ├─ store.ts        SQL 访问层（skills / skill_versions）
│  ├─ ingest.ts       zip / JSON / 原始 zip → IngestFile[]（路径校验、去顶层、过滤、限位）
│  ├─ service.ts      上传/版本/删除的业务编排（先盘后 DB、不写半套、auto-bump、保留策略）
│  ├─ routes/api.ts   REST /api/v1（+ 控制台登录的 auth 端点）
│  ├─ routes/mcp.ts   手写 JSON-RPC（照 lanpages 的 361 行形态）
│  ├─ mcp/tools.ts    8 个工具（定义 + handler）
│  ├─ web.ts          /console 路由 + 静态资源 + 登录门
│  ├─ auth.ts         口令会话（照抄 lanpages：sha256 + HMAC 签名 cookie + 登录限流）
│  ├─ cli.ts          CLI
│  └─ util/{errors.ts,slug.ts,paths.ts,crypto.ts,baseurl.ts,ids.ts}
├─ web/{index.html, skill.html, upload.html, guide.html, app.js, style.css}
└─ test/{helpers.ts, unit.test.ts, api.test.ts, mcp.test.ts, cli.test.ts}
```

### 4.3 数据模型与磁盘布局

```sql
-- MIGRATIONS[0]
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',        -- JSON 字符串数组
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  latest_version_id TEXT                  -- 指向 skill_versions.id
);
CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  changelog TEXT NOT NULL DEFAULT '',
  manifest TEXT NOT NULL,                 -- JSON: [{path,size,sha256}]，按 path 排序
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(skill_id, version)
);
CREATE INDEX idx_versions_skill ON skill_versions(skill_id, created_at DESC);
```

磁盘：

```
<DATA_DIR>/db.sqlite                                   SQLite（WAL）
<DATA_DIR>/skills/<slug>/<versionId>/<relpath>         版本文件（versionId 是随机 id，不含版本号里的特殊字符）
<DATA_DIR>/tmp/<uploadId>/                             上传暂存（同卷，保证 rename 原子）
<DATA_DIR>/session.secret                              控制台会话签名密钥（可选 env 覆盖）
```

`manifest` 是**唯一真源**：`/files`、客户端安装校验、`zip` 打包都从它读；`File.path` 一律正斜杠、相对路径。

### 4.4 上传 / 版本落盘流程（不写半套）

```
解析载荷 → ingest（路径校验 → 去单一顶层 → 过滤垃圾 → 限位 → 必含 SKILL.md）
        → 计算 sha256 + size（manifest）
        → 版本号决议（显式 / 自动递增）→ 唯一性检查
        → 写 <tmp>/<uploadId>/ 全部文件 → 复核（文件数 + 根 SKILL.md 存在）
        → rename 到 skills/<slug>/<versionId>
        → DB 事务：insert version → insert/update skill（latest_version_id、updated_at）→ commit
        → 保留策略：超出 MAX_VERSIONS_PER_SKILL 时删最旧的非 latest（先 DB 后盘）
任何一步抛错：删 tmp/新版本目录，DB 未改动，返回结构化错误
```

### 4.5 安全（硬性）

1. 所有用户输入路径过 `sanitizeRelPath` + `safeJoin`；禁止 `path.join(dataDir, userInput)`。
2. zip 条目跳过符号链接；zip-slip 全拒；`..`/绝对路径/盘符/ADS/控制字符/保留名/超长。
3. **不执行包内任何代码**（不跑脚本、不解析动态内容）；`SKILL.md` 预览只做文本转义展示。
4. 控制台：`ADMIN_PASSWORD` 必填（启动校验）、cookie 会话、登录限流、所有动态值 `escapeHtml`。
5. API/MCP 无鉴权 → 启动时打一条 warn（照 lanpages 的做法），README 与控制台首页显著提示「内网开放，任何能访问端口的人都能上传/删除技能」。
6. 只读 `<DATA_DIR>/skills` 下的文件；不接受任意绝对路径读盘。

### 4.6 Web 控制台（`/console/`，原生 HTML/CSS/JS，无构建）

| 页面 | 内容 |
| --- | --- |
| `index.html` 概览 + 列表 | 统计（技能数/版本数/总大小/最近上传）、搜索/分类/排序、技能表格（名称、slug、latest、文件数、体积、更新时间） |
| `skill.html?slug=` 详情 | 基本信息、版本列表（切换 latest / 删除非 latest）、文件清单（路径/大小/sha256 前 12 位）、`SKILL.md` 预览（转义 `<pre>`）、下载 zip、删除技能（输入 slug 二次确认） |
| `upload.html` 上传 | 拖拽/选择 zip、自动用文件名猜 slug、名称/描述/分类/标签/版本/changelog 表单、上传进度与结果、失败原因原样展示 |
| `guide.html` 接入指南 | PiDesktop 配置（商店地址填本服务根地址）、MCP 配置片段（`{"type":"streamable-http","url":"http://<host>:8080/mcp"}`）、CLI 用法、REST 示例 |

> 目录上传不做（需要前端打包库）；控制台只吃 zip，README 写清「`zip -r my-skill.zip my-skill/`」。

### 4.7 CLI（`lanskills`，`--json` 便于 Agent 解析）

```
lanskills info                                      # = ping，打印版本/技能数/限制
lanskills ls [--keyword] [--category] [--limit]
lanskills show <slug> [--json]
lanskills push <dir|zip> [--slug] [--name] [--version] [--changelog] [--category] [--tag ...]
lanskills pull <slug> [--out <dir>] [--version]      # 逐文件下载 + sha256 校验后落盘（与客户端同纪律）
lanskills versions <slug>
lanskills activate <slug> <version>
lanskills rm <slug> --yes
```

- 环境变量 `LANSKILLS_URL`；`--url` 覆盖；`--json` 输出结构化结果。
- `push` 目录时在客户端侧打包（adm-zip），**跳过 `.git/`、`node_modules/`、`.DS_Store`、`__MACOSX`**。
- 未知命令/缺参 → 退出码 2 + 中文用法；HTTP/校验失败 → 退出码 1 + 服务端 message 原文。

### 4.8 部署

- `Dockerfile`：多阶段（build：全依赖 + tsc；runtime：prod 依赖 + dist + web），`node:22-bookworm-slim`，非 root `node` 用户，`HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8080/healthz')…"`，`VOLUME /data`。
- `docker-compose.yml`：端口 `8080:8080`、`lanskills-data:/data`、`env_file: .env`、`restart: unless-stopped`。
- `.env.example`：`ADMIN_PASSWORD`（必填）、`PUBLIC_BASE_URL`、`SITE_NAME=LanSkills`、`MAX_FILE_MB=1`、`MAX_TOTAL_MB=32`、`MAX_FILES=200`、`MAX_VERSIONS_PER_SKILL=20`、`MAX_UPLOAD_MB=64`、`TZ=Asia/Shanghai`。
- `scripts/package-offline.sh`：照抄 lanpages 的离线包（`docker save` + `install.sh`：导入镜像 → 生成随机口令 → 起容器 → 打印地址），改镜像名/端口/文案。
- 反向代理场景：`PUBLIC_BASE_URL` 填最终用户看到的地址（含路径前缀时要与客户端的 Base URL 一致）。

### 4.9 测试与验收（服务端）

- `test/unit.test.ts`：slug 规则/保留字、`sanitizeRelPath` 全套拒绝清单、去单一顶层（正反例）、垃圾过滤、版本自动递增（`1.2.3→1.2.4`、`beta→beta-1`、首个 `1.0.0`）、frontmatter 兜底、manifest 排序与 sha256。
- `test/api.test.ts`：新建（zip / files / 原始 zip）→ 列表/搜索/分类 → 详情 → files → file（sha256 与清单一致）→ zip 解包内容一致 → 新版本 → activate → 删除版本 → 删除技能；错误面：缺 SKILL.md、路径穿越、超 1MB、超 200 文件、重复版本、缺 `confirm`、404、删除后列表消失。
- `test/mcp.test.ts`：initialize（协议版本协商）、tools/list 8 个、publish_skill（files）→ list → get_skill_file → delete；错误工具 `isError:true`。
- `test/cli.test.ts`：真子进程 `node --import tsx src/cli.ts push <临时目录>` → `ls --json` 解析 → `pull` 落盘比对 sha256 → `rm --yes`。
- 必绿：`npm run typecheck`、`npm test`、`npm run build`；`docker build` 在实施轮至少验一次（本机有 Docker 时）。

### 4.10 已知坑（实施时直接规避，来自 lanpages 的实测结论）

1. `reply.send(stream)` 必须 `return`，否则 async handler 返回 undefined 触发 Fastify 二次 send（响应变空 body）。HEAD 单测。
2. zip 包自动去顶层目录前必须有反例：根下已有文件时**不许剥**，否则 `SKILL.md` 会跟着被塞进子目录。
3. better-sqlite3 是原生模块：多阶段构建与 `npm ci` 的平台必须一致（lanpages 的 Dockerfile 已验证，照抄）。
4. 手工 MCP 的 SSE 分支要用 `reply.hijack()`，并给 GET `/mcp` 心跳；POST 无响应时回 `202`。
5. Windows 上 `rename` 跨卷会失败 → `tmp` 必须与 `skills` 同卷（都在 `DATA_DIR` 下）。
6. 保留名按"扩展名前的主名"判定（`NUL.md` 也是设备名）。

---

## 5. PiDesktop 客户端接入

### 5.1 设置项与命令（主进程）

**新增设置**（`src/shared/protocol.ts`，`DesktopSettings` 里加一个字段）：

```ts
/** 内网 Skill 商店（LanSkills）连接配置；缺省 = 未配置。密钥不进本结构。 */
export interface IntranetStoreSettings {
  /** 服务根地址，允许路径前缀，例如 http://skills.corp.local:8080 或 http://corp.local/store */
  baseUrl: string;
  /** 显示名，缺省「内网 Skill 商店」 */
  name?: string;
}
// DesktopSettings 增：intranetStore?: IntranetStoreSettings;
```

- 归一化 `normalizeIntranetStore(value)`（`src/main/settings.ts`，紧随 `normalizeJev` 的风格）：`http:`/`https:` 校验、`trim()`、去尾斜杠；非法值**丢弃整个字段**（返回 undefined），不抛错；`name` 截断 60 字。
- **必须**在 `migrateSettings` 里读回（`src/main/settings.ts:614` 附近，与 `jev`/`ssh` 同排）。这是仓库踩过多次的坑：漏读一个字段 = 磁盘有、内存没有，下一次任意设置写入就把它抹掉。
- `settingsForRenderer` 只投影 appearance（`src/main/appearance-assets.ts:43`），本字段自动透传，渲染端可见（无密钥）。
- **不进 `settings.save` 的 Pick**（`src/shared/protocol.ts:2503`）——配置由独立命令维护，避免 `settings-save-contract.test.ts` 的三处镜像约束被打破，也避免"保存通用设置"把它抹掉。

**命令（渲染端 → 主进程）**：

| 命令 | 主进程行为 |
| --- | --- |
| `skill-store.source.save` `{requestId, baseUrl, name?}` | 校验 → 写 `settings.intranetStore` → `persistSettings().schedule(...)` → 直接向渲染端推 `{type:"skill-store-result", result:{kind:"source", requestId, ok:true, source:"intranet", config}}`；非法地址回 `ok:false`（中文原因） |
| `skill-store.source.clear` `{requestId}` | 删字段 → 落盘 → 推 `{kind:"source", ok:true}` |
| `skill-store.source.test` `{requestId, baseUrl?}` | `baseUrl` 缺省取已保存值 → 走 utility 发 `GET /api/v1/ping` → 推 `{kind:"source-test", ok, message, latencyMs?, version?, skillCount?}` |

**转发注入**（关键设计，`src/main/index.ts:1278` 的 `runtime:send` 处）：

```ts
// utility 没有 Electron API，读不到 settings；baseUrl 由主进程在转发前注入。
// 先例：jev.test 的 apiKey 注入（index.ts:466-468）。
function enrichStoreCommand(command: RuntimeCommand): RuntimeCommand {
  if (!command.type.startsWith("skill-store.")) return command;
  if (command.type.startsWith("skill-store.source.")) return command;   // main 自己处理，不转发
  if (command.source !== "intranet") return command;
  return { ...command, baseUrl: loadSettings().intranetStore?.baseUrl };
}
```

- `source.save` / `source.clear` **由主进程直接处理、不转发 utility**（避免 utility 收到自己不认识的分支）。`runtime:send` 里先判这两条 → 处理后 `return`。
- 未配置地址时 `baseUrl` 为 `undefined`，utility 侧直接报「请先在内网 Skill 商店里填写服务地址」——不静默失败。

### 5.2 共享协议变更（`src/shared/skill-store.ts` + `src/shared/protocol.ts`）

```ts
export type SkillStoreSource = "public" | "intranet";

// 六个既有命令 + source.test 都加 source / baseUrl
| { type: "skill-store.list"; requestId: string; source: SkillStoreSource; query: SkillStoreQuery }
| { type: "skill-store.categories"; requestId: string; source: SkillStoreSource }
| { type: "skill-store.detail"; requestId: string; source: SkillStoreSource; slug: string; version?: string }
| { type: "skill-store.install"; requestId: string; source: SkillStoreSource; slug: string; scope: SkillStoreScope; version?: string; confirmReplace?: boolean }
| { type: "skill-store.uninstall"; requestId: string; source: SkillStoreSource; slug: string; scope: SkillStoreScope }
// top 只对 public 有意义，仍带 source 字段保持一致
| { type: "skill-store.top"; requestId: string; source: SkillStoreSource }
// 内网地址注入（utility 侧可选读；主进程转发时补）
| { type: "skill-store.source.test"; requestId: string; baseUrl?: string }
```

- **结果联合每个分支都带 `source`**（渲染端据此路由到对应状态切片），新增两个 kind：
  - `{kind:"source"; requestId; source:"intranet"; ok:true; config?: IntranetStoreSettings}` / `ok:false; error`
  - `{kind:"source-test"; requestId; ok:boolean; message:string; latencyMs?:number; version?:string; skillCount?:number}`
- `SkillStoreInstallSummary` 增 `sourceId: SkillStoreSource`；`SkillStoreInstallOutcome` 增 `sourceId`（回执里显示"来自内网商店"）。
- `SkillStoreSort` 增 `"name"`（内网商店用「最近更新 / 名称」两档；公开商店的四个选项不变）。

### 5.3 内网客户端（新文件 `src/main/skill-store-intranet-client.ts`）

- 纯逻辑、注入式 fetch（照 `skill-store-client.ts` 的 `StoreFetch` 形态），**归一化输出复用现有类型**：`SkillStoreSkill` / `SkillStoreDetail` / `SkillStoreVersion` / `SkillStoreFile` —— 这样 UI 与安装层零改动。
- 函数：`intranetPing(baseUrl)`、`intranetList(baseUrl, query)`、`intranetCategories`、`intranetDetail`、`intranetVersions`、`intranetFiles`、`intranetFileBytes(baseUrl, slug, version, path)`。
- baseUrl 规整：`new URL()` 解析；协议只允许 `http:`/`https:`；路径前缀保留；所有拼接走一个 `joinUrl(base, path)`（不在别处手拼字符串）。
- 超时 12s（下载 24s）；错误映射：连接失败/DNS → 「无法连接内网商店（<baseUrl>）：<原因>」；`{ok:false,error.message}` 原样透出；HTTP 404/413/409 按 §3.4 给中文。
- 单测 `skill-store-intranet-client.test.ts`（注入 fetch）：列表/详情/分类归一化、路径前缀拼接、`{ok:false}` 透传、超时、非 JSON、413 中文、下载字节。

### 5.4 安装 / 卸载 / 账本（`src/main/skill-store-install.ts`）

- `planInstall` / `commitInstall` / `installSkillFromStore` 增 `sourceId: SkillStoreSource`（**缺省 `"public"`**，兼容既有调用与测试）与 `sourceUrl?: string`。
- 账本 `StoreInstallRecord` 增 `sourceId?: SkillStoreSource` + `sourceUrl?: string`；**旧记录缺 `sourceId` 视为 `"public"`**（不做迁移、不改 `version:1`）。
- 冲突规则（`planInstall` 里）：
  - 目标目录已存在 + 账本记录存在 + `record.sourceId !== 本次 sourceId` → **拒绝**：`目录 <slug> 已由「公开 SkillHub」安装；请先卸载它，或改用同名来源。`
  - 同源 + 未 `confirmReplace` → 现有的"已安装，请确认覆盖"文案。
  - 无记录 + 目录存在（手工放置）→ 现有行为（拒绝并要求确认）。
- `downloadAndVerify` 的 `fetchBytes` 由命令入口注入：内网源用 `(slug, version, path) => intranetFileBytes(baseUrl, …)`；公开源保持 `defaultFetchStoreBytes`。
- `uninstall` 增 `sourceId`：只允许卸载**同源**记录（跨源卸载报「该目录由另一个商店源安装」）。
- `skillStoreInstalls()`（`pi-runtime.ts:5372`）返回项增 `sourceId`；渲染端徽标只在同源时显示「已安装 / 有更新」。

### 5.5 渲染端状态与组件

**状态（`src/renderer/src/store.ts`）**：

- 新增 `intranetStore: SkillStoreState`（与 `skillStore` 同结构，`SkillStoreState` 不变），`initialize` 初值同款。
- 把纯函数 `applySkillStoreResult` 内的逻辑抽成 `reduceSkillStore(state, result): SkillStoreState | undefined`；
  `applySkillStoreResult` 保留为兼容薄壳（返回 `{skillStore: next}`），**现有 `store.test.ts` / 组件测试不用改**。
- `handleRuntimeMessage` 的 `case "skill-store-result"` 按 `message.result.source` 路由：`intranet` → `intranetStore`，其余 → `skillStore`。
- 新增 `SkillStorePaneId = "public" | "intranet"` 判定与 `skillStoreSliceFor(result)` 小工具（纯函数，单测覆盖路由）。

**组件**：

- `src/renderer/src/components/SkillStoreBrowser.tsx`（**新，从 `SkillStoreSettings` 抽出**）：
  - props：`{ source: SkillStoreSource; title: string; subtitle: string; state: SkillStoreState; showTop: boolean; sortOptions; emptyHint; headerExtra?: ReactNode; onRefresh; onSend }`
  - 内含浏览条、卡片网格、分页、详情抽屉、安装确认、卸载、内联结果条；`data-control` 沿用 `skill-store-*` 系列（**契约不变**，主题镜像只需新增 tab 级钩子）。
  - 安装/卸载按 `source` + `installs` 过滤决定徽标与按钮可用性（跨源同名目录显示「同名目录已由公开商店安装」提示）。
- `SkillStoreSettings.tsx` 变薄壳：保留 `data-pane="skill-store"`、原有 12 个 `data-control`、原有行为与文案（`SkillStoreSettings.test.tsx` 保持全绿）。
- `src/renderer/src/IntranetSkillStoreSettings.tsx`（新）：`data-pane="intranet-skill-store"`，两态：
  - **未配置**：说明 + 地址输入（`data-control="intranet-store-url"`）+ 名称（可选）+ 「保存并连接」（`intranet-store-save`）+ 折叠的部署指引（`docker compose up -d --build`、`lanskills push`、MCP 配置片段）+ 一句「地址由管理员提供，例如 http://skills.corp.local:8080」。
  - **已配置**：页头显示地址（`intranet-store-change` 更改/清除）+ 「测试连接」（`intranet-store-test`，显示延迟/版本/技能数）+ 刷新（`intranet-store-refresh`）+ 安装作用域（沿用 `skill-store-scope`）+ 共享 `SkillStoreBrowser`（`showTop=false`，排序=最近更新/名称）。
- `App.tsx` **四处注册**：`SettingsTab` 联合（`:265`）、nav 按钮（`:456`）、内容分支（`:456`）、命令面板 `settingsTabs`（`:2619`）。
- 样式：`styles.css` 追加 `.intranet-store-*`（配置卡/地址栏/空态），复用 `.skill-store-*` 骨架；**新样式块必须插在 `.team-board` 之前**（`team-board-type-scale.test.ts` 从 `.team-board {` 切到文件尾）。

### 5.6 内网 tab 的交互细节

- 首屏：已配置 → 发 `categories` + `list`（`source:"intranet"`）；未配置 → 只显示配置卡，不发请求。
- 搜索 300ms 防抖（同公开商店）；分类下拉来自服务端；排序两档。
- 详情：点击卡片 → `skill-store.detail`；展示来源（服务端名/地址）、版本、文件数/体积（超 1MB 文件给出「面板不支持安装」提示）、`SKILL.md` 预览、安装确认清单（来源/版本/文件/体积/作用域/风险）、已安装态与「有更新」。
- 失败一律**内联**在页面里（网络不通、404、413、校验失败、跨源冲突），不靠 toast；不伪造成功。
- 演示环境（`demo-api.ts`）：新命令全部回「演示环境不支持内网 Skill 商店（需要真实网络与文件系统）」，与主题导入/公开商店同口径。

### 5.7 主题契约（五处镜像 + 计数）

- `data-pane` 新增 `intranet-skill-store`（41 → 42 项）。
- `data-control` 新增 4 个：`intranet-store-url`、`intranet-store-save`、`intranet-store-test`、`intranet-store-change`（另有 `intranet-store-refresh`，共 5 个 → 124 → 129；**以 `check_theme.py` 集合实际长度为准，不照抄数字**）。
- 同步位置：`AGENTS.md`、`docs/theme-guide.md`（pane 列表 + 「十个 tab」→ 十一个 + control 表）、`resources/skills/pidesktop-theme-creator/SKILL.md`（「主要区域（41）」「关键控件（124）」）、`references/variables.md` 两行、`scripts/check_theme.py` 的 `KNOWN_PANES` / `KNOWN_CONTROLS`。
- `src/main/skill-store-wiring.test.ts` 的计数断言（当前 `41`/`124`）与「五处镜像都含 skill-store」同步更新为 42/129 且含 `intranet-skill-store`。
- 新增 `src/main/intranet-store-wiring.test.ts`（照 skill-store-wiring 的源码断言形态）：新命令接线、main 注入、store 路由、`data-pane`/`data-control`、demo 降级、五处镜像。

### 5.8 文档

- `AGENTS.md`：Skill 商店段补「内网商店 LanSkills：服务端在 `D:\日常工作区\lanskills`；客户端 `source:"intranet"`；地址在主进程、utility 靠 main 注入 `baseUrl`；上限两端一致」。
- `resources/skills/chatanytime-config/SKILL.md`：技能一节补一句「内网技能也可从设置 → 内网 Skill 商店安装」。
- 实施完成后按仓库格式追加 `docs/迭代记录/2026-11.md`（两轮各一条）。

---

## 6. 实施步骤

### 轮 A：服务端 LanSkills（独立仓库，先做，客户端才有真实对端可测）

1. 建目录 `D:\日常工作区\lanskills` + `git init`（**不 push、不打 tag**）；写 `package.json` / `tsconfig.json` / `vitest.config.ts` / `.gitignore` / `.dockerignore` / `AGENTS.md`（技术栈、命令、硬性约定、测试纪律，照 lanpages 的结构写）。
2. `util/`（errors/slug/paths/crypto/ids/baseurl）+ `config.ts` + `db.ts`（MIGRATIONS[0]）+ `store.ts`；单测覆盖 slug/paths/版本递增。
3. `ingest.ts`（zip/JSON/raw zip → IngestFile[]）+ `service.ts`（上传/版本/删除/保留策略/原子落盘）；单测按 §4.9。
4. `routes/api.ts`（§3.2 全部端点 + auth 登录端点）+ `app.ts`（错误处理/404/healthz）。
5. `routes/mcp.ts` + `mcp/tools.ts`（8 个工具 + 2 个 resources）。
6. `web/`（4 页）+ `web.ts` + `auth.ts`。
7. `cli.ts`（§4.7）。
8. Dockerfile / compose / .env.example / `scripts/package-offline.sh`。
9. 文档（README / docs/API.md / docs/MCP.md / docs/部署运维.md / docs/设计决策.md / docs/迭代记录.md）。
10. 验证：`npm run typecheck && npm test && npm run build`；本机起 `PORT=8788 DATA_DIR=.tmpdata ADMIN_PASSWORD=test12345 node dist/index.js` 冒烟（push/列表/详情/文件 sha256/zip/pull/rm）；`docker build` 至少一次。

### 轮 B：PiDesktop 接入（在 PiDesktop 仓库）

1. `src/shared/skill-store.ts`：`SkillStoreSource`、`IntranetStoreSettings`、命令/结果增 `source`/`baseUrl`、两个新 kind、`SkillStoreInstallSummary.sourceId`、`SkillStoreSort` 增 `name`。
2. `src/shared/protocol.ts`：`DesktopSettings.intranetStore`、`RuntimeCommand` 增 `skill-store.source.save|clear|test`（+ 既有六命令的 `source`/`baseUrl`）。
3. `src/main/settings.ts`：`normalizeIntranetStore` + `migrateSettings` 读回。
4. `src/main/index.ts`：`updateSettings` 处理 `source.save|clear`（校验 + 落盘 + 推结果）；`runtime:send` 加 `enrichStoreCommand`（注入 `baseUrl`、拦下 source 命令）。
5. 新 `src/main/skill-store-intranet-client.ts` + 单测。
6. `src/main/skill-store-install.ts`：`sourceId`/`sourceUrl` 贯穿、跨源冲突、卸载同源限制；补测试（跨源冲突/同源覆盖/旧账本缺 sourceId 视为 public）。
7. `src/main/pi-runtime.ts`：`runSkillStoreCommand` 按 `command.source` 分流；内网 cache key 带 source；`install` 注入内网 `fetchBytes`；新增 `case "skill-store.source.test"`（ping）。
8. `src/renderer/src/store.ts`：`intranetStore` 切片 + `reduceSkillStore` + 路由。
9. 抽 `components/SkillStoreBrowser.tsx`；`SkillStoreSettings.tsx` 薄壳化；新 `IntranetSkillStoreSettings.tsx` + `IntranetSkillStoreSettings.test.tsx`。
10. `App.tsx` 四处注册；`demo-api.ts` 降级；`styles.css` 追加（注意 `.team-board` 之前）。
11. 主题五处镜像 + 计数 + `skill-store-wiring.test.ts` 更新 + 新 `intranet-store-wiring.test.ts`。
12. 文档（`AGENTS.md`、`chatanytime-config/SKILL.md`、`docs/迭代记录/2026-11.md`）。

### 轮 B 验收（真机探针，需用户在自己机器上配合；实施会话只做前四条）

1. `node dist/index.js`（端口 8788）起 LanSkills；`lanskills push resources/skills/chatanytime-config --slug 演示技能`。
2. 打开 PiDesktop → 设置 → 内网 Skill 商店 → 填 `http://127.0.0.1:8788` → 保存并连接 → 显示版本/技能数。
3. 列表出现 → 详情 → 文件清单与 SKILL.md 预览 → 安装到用户全局 → 校验 `<agentDir>/pidesktop-skills/<slug>/SKILL.md` 存在且 sha256 与服务端 `/files` 一致 → 「技能与工具」出现该 skill → 卸载后目录与账本清空。
4. 边界：服务停掉（连接失败文案）、错误地址、404 技能、超限技能（上传被拒）、同名跨源冲突、未配置地址、演示环境。
5. **重启应用让改动生效是用户的步骤**，实施会话绝不结束/重启宿主进程。

---

## 7. 验证方式（两端各自必绿）

| 端 | 命令 |
| --- | --- |
| LanSkills | `npm run typecheck`、`npm test`、`npm run build`（+ Docker build 至少一次） |
| PiDesktop | `npm test`、`npm run build`（回归重点：`skill-store-*.test.ts`、`SkillStoreSettings.test.tsx`、`settings-save-contract.test.ts`、`ResourceSettings.test.tsx`、`demo-api.test.ts`、主题镜像测试） |

失败必须修或如实上报，不得跳过或降低标准。**本轮（只出方案）不做任何代码改动，因此不跑测试、不引构建。**

---

## 8. 风险、假设与不做的事

1. **服务端无鉴权**：内网开放，任何能访问端口的人都能上传/删除（lanpages 同款口径）。若组织要求鉴权，扩展点是「源配置加 Token（credentials.json + safeStorage）+ 服务端 `API_TOKEN` 校验」，两端各加一层，协议不变——**本轮明确不做**。
2. **明文 HTTP**：内网常见；客户端允许 `http:`，页面上用一行提示「内网明文传输」，HTTPS 交给反向代理。
3. **1MB/32MB/200 硬界**：与客户端安装侧完全一致，所以**商店里能传的，客户端就能装**；需要大文件技能时两端同时放宽（写进两端 AGENTS.md 的待办）。
4. **Node 全局 fetch 不走系统代理**：与企业代理环境的关系同现有 SkillHub 请求（同一进程、同一 fetch）；内网直连通常无此问题。
5. **单个内网源**：协议已按 `sourceId` 设计，多源是 UI/配置增量，不做跨源聚合搜索。
6. **账本兼容**：旧账本没有 `sourceId` → 视为 `"public"`；不改 metadata `version`，不做迁移。
7. **技能名/slug 冲突**：公开源与内网源可能同名 → 安装时按来源拒绝（不静默覆盖），UI 明确说明。
8. **不做**：发布审核/多租户/权限、对象存储/多副本、客户端内上传到商店（P1：MCP/CLI/控制台已覆盖）、自动更新、HTTPS 终结、跨源聚合、改四档技能目录与扫描语义、把服务端代码放进 PiDesktop 仓库。
9. **仓库位置与命名**：默认 `D:\日常工作区\lanskills`（与 lanpages 同级）；名字可改（只影响 package.json / 镜像名 / 文档），**目录定了再开工**。

---

## 9. 交付与记录纪律

- 本轮：仅把本计划写入 `docs/plans/` 并本地提交（`docs(plans): 内网 Skill 商店设计与实施计划`），**不改源码、不建新项目、不 push、不打 tag、不改版本号**。
- 轮 A 完成后：在 `lanskills` 仓库提交（`feat: 内网 Skill 商店服务端`），并更新其 `docs/迭代记录.md`。
- 轮 B 完成后：在 PiDesktop 仓库提交（`feat(skill-store): 内网 Skill 商店接入`），按 `docs/迭代记录.md` 的格式追加当月归档条目（需求来源 → 落地文件与决策 → 关键数字 → 踩坑 → 验证结论 → 边界）。
- 两轮都不做：`git push`、打 tag、改 `package.json` 版本号（需先征得用户同意）。
