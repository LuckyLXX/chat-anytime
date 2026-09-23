# 发布流程改造：GitHub Actions 自动打包并挂 Release

## 一、背景与目标

**现状痛点**（来自既有发布流程记忆，1.0.0~1.3.0 共 8 轮实测）：每次发版都要在本机跑 `npx electron-builder --win nsis`（2–4 分钟），再手工 `gh release upload` 一个 135MB 的 exe（本机 git 走 socks5 代理反复出现 SSL_ERROR_SYSCALL，每轮都要临时覆盖 `http.proxy`）。

**目标**（已与用户对齐）：
1. Release 仍挂安装包，但改由 GitHub Actions 自动构建并上传；本地不再打包、不再上传。
2. CI 做全套门禁：`npm test` → `npm run build` → 打包 → 静态校验 → 自动挂 Release。
3. CI 出包后把产物下载回本地跑一次启动冒烟，再通知用户。
4. 本地 `npx electron-builder` 能力保留为兜底（CI 挂了不至于发不出包）。

**本次不发版、不改版本号**，只搭流水线。

## 二、已核验的硬事实（实测，实施时可直接依赖）

| # | 事实 | 影响 |
|---|---|---|
| 1 | 仓库 `LuckyLXX/chat-anytime` 是 **PUBLIC** | Actions 免费，Windows runner 无分钟数限制 |
| 2 | 当前**没有** `.github/` 目录 | 需新建 workflow |
| 3 | `@earendil-works/{pi-agent-core,pi-ai,pi-coding-agent,pi-server,pi-tui,chord}` 的 **0.85.0 在官方 registry.npmjs.org 上均存在，且 `dist.integrity` 与 lock 里逐位一致**（如 pi-agent-core `sha512-uOvSDEG5B/P1mpxnuXCkv…`） | 换成官方 registry 拉到的是**同一份 tarball**；用户担心的「pi 指定版本搞错」在本方案下有字节级保障 |
| 4 | lock 里所有 `@earendil-works/*`（含传递依赖 pi-tui/chord/pi-client/pi-protocol/pi-telemetry）**全钉 0.85.0**；package.json 用精确版本号（无 `^`）+ `overrides` 二次钉死 | 三重锁：声明/override/lock，`npm ci` 不解析、不漂移 |
| 5 | pi 包的 `scripts` 只有 build/test/prepublishOnly，**无 install/postinstall** | CI 安装不触发额外下载 |
| 6 | node-pty 用 `prebuilds/win32-x64/*.node`，基于 node-addon-api（字节里 `napi_create` 命中、`v8::` 未命中） | **CI 不需要 electron-rebuild**，这是 `npmRebuild:false` 能成立的前提 |
| 7 | 现成 1.3.0 包（`dist/win-unpacked/resources/app.asar`）里 **9 个 `@earendil-works/*` 包版本实测全 = 0.85.0** | 已有可复用的硬断言基线 |
| 8 | `src/main` 里**没有** `requestSingleInstanceLock`，也**没有**覆盖 `userData` 路径 | 冒烟启动的实例不会和宿主实例抢单实例锁；可用 `--user-data-dir` 隔离数据 |

### 两个会直接让 CI 挂掉的坑（必须按此处理）

- **坑 A：lock 里有一条 `git+ssh` 依赖** — `node_modules/@electron/node-gyp` 的 resolved 是 `git+ssh://git@github.com/electron/node-gyp.git#06b29aaf…`。CI 上 `npm ci` 走 SSH 会要求密钥 → 必须用 url 重写转成 HTTPS：
  ```
  git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
  git config --global url."https://github.com/".insteadOf "git@github.com:"
  ```
  （`electron/node-gyp` 是公开仓库，匿名 HTTPS 可 clone）
- **坑 B：lock 里 973 条 resolved 指向 `mirrors.tencent.com`**（海外 runner 访问慢/可能超时）→ CI 用官方 registry 并强制重写 host：
  ```
  npm ci --registry=https://registry.npmjs.org/ --replace-registry-host=always
  ```
  事实 3 已证明 integrity 同源，重写不会换包。

- **坑 C（打包细节）：electron-builder 默认 publish 策略是 `onTagOrDraft`**，CI 里若有 `GH_TOKEN` 它会自己往 Release 上传，与我们的 gh 步骤重复/冲突 → 打包步骤必须 `--publish never`，且**不**在该步骤暴露 `GH_TOKEN`。

- **坑 D（asar 读取口径，实测三种写法全失败）**：`@electron/asar` 的 `getNode` 用 `path.sep` 切分，所以
  - ❌ `node_modules/@earendil-works/pi-tui/package.json`（正斜杠）→ not found
  - ❌ `\node_modules\@earendil-works\pi-tui\package.json`（前导分隔符，也正是 `listPackage` 的返回形态）→ not found
  - ✅ `path.join("node_modules","@earendil-works","pi-tui","package.json")` → 读到 `0.85.0`
  这解开了记忆里「`extractFile` 读 `out/main/pi-runtime.js` 报 not found」那笔旧账：**根因是路径口径，不是层级**。

## 三、实施步骤

### 步骤 1：新增 `.github/scripts/verify-package.cjs`（静态校验，本地与 CI 共用）

用 `.cjs` 后缀（避免被 vitest 收集）。用法：
```
node .github/scripts/verify-package.cjs [--skip=compare] [--v=1.3.0]
```
校验项（逐项失败即汇总报错、非零退出）：

1. **产物存在**：`dist/ChatAnyTime Setup <v>.exe`、同名 `.blockmap`、`dist/latest.yml`
2. **latest.yml 一致性**：`version` == package.json version；`files[0].size` == exe 实际字节数
3. **PE / NSIS**：exe 头两字节 `MZ`；`latin1` 串含 `Nullsoft`
   - ⚠️ 不要用 latin1 找版本串（安装包内是 UTF-16LE，恒假阴性，1.3.0 轮踩过）；版本号断言改走 VersionInfo
4. **VersionInfo**（PowerShell `Get-Item … .VersionInfo`）：`ProductVersion` 以期望版本开头
5. **asar 内容断言**：
   - `path.join` 口径读 `package.json` → version == 期望版本
   - **9 个 `@earendil-works/*` 包 version 必须全 == `0.85.0`**（用户明确关心的点，写成硬断言；期望值从 package.json 的 `dependencies`/`overrides` 推导，不写死）
6. **asar ↔ `out/` 逐文件 sha256 比对**（只比 `out/**` 与顶层 `package.json`，跳过 `asarUnpack` 的 node_modules）→ 证明「包里的代码就是本次构建的代码」，顺带排掉「源码改了但包没刷新」。可用 `--skip=compare` 单独跳过（本地干跑用）
7. **extraResources 资产**：`dist/win-unpacked/resources/skills` 齐备（automation/SKILL.md、computer-use/{SKILL.md,ljqCtrl.py,uia.py,ui_detect.py,test/selfcheck.py}、web-tasks/SKILL.md 共 7 文件）、`subagents` 3 份 JSON；**目录内 `__pycache__`/`.pyc` 数为 0**

### 步骤 2：新增 `.github/workflows/release.yml`

```yaml
name: release
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      tag:      { description: '版本 tag（留空用 v<package.json version>）', required: false, default: '' }
      publish:  { description: '是否上传到 Release', type: boolean, default: false }
permissions:
  contents: write
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      # 坑 A：git+ssh 依赖转 HTTPS
      # 坑 B：registry 覆写（integrity 保证同源）
      # 版本一致性：tag vX.Y.Z 与 package.json 必须一致（tag 触发时强制）
      # npm ci 后：node .github/scripts/verify-package.cjs --preinstall（断言 node_modules 里 9 个 pi 包 = 0.85.0）
      # npm test
      # npm run build
      # npx electron-builder --win nsis --publish never   （此步不暴露 GH_TOKEN，坑 C）
      # node .github/scripts/verify-package.cjs           （全套静态校验）
      # actions/upload-artifact@v4：exe + blockmap + latest.yml，retention-days: 14
      # publish 时（tag 触发默认 true；dispatch 由输入决定，默认 false）：
      #   gh release view "$TAG" || gh release create "$TAG" --title "…" --generate-notes
      #   gh release upload "$TAG" <exe> <blockmap> latest.yml --clobber
```
关键设计点：
- `publish` 在 **tag 触发时为 true、workflow_dispatch 时默认 false**（试跑不污染现有 Release）
- `--preinstall` 断言放在 `npm ci` 之后、打包之前 → pi 版本一旦不对，**根本不会走到出包**
- tag 触发时强制「tag 版本 == package.json version」，防呆
- `gh release create` 仅作兜底（若还没建 Release）；正经流程是本地先建 Release 带手写 notes

### 步骤 3：`package.json` 加一条本地兜底脚本

`"package:installer": "npm run build && electron-builder --win nsis --publish never"`
（**不动** version、**不动** build 配置、**不加** publish 字段——避免改变本地打包行为）

### 步骤 4：本地干跑校验脚本（不打包）

对现成的 `dist/ChatAnyTime Setup 1.3.0.exe` 跑 `node .github/scripts/verify-package.cjs --skip=compare --v=1.3.0`，确认除「asar↔out 比对」外全部通过。
**反向验证**（纪律要求）：故意把 pi 版本期望改成 `0.84.0` 跑一次，确认脚本真的转红，再改回。

### 步骤 5：提交并 push（**需要用户授权**）

一个 commit：`ci(release): 新增 GitHub Actions 自动构建安装包并挂 Release 的流水线`
（含 workflow + 校验脚本 + package.json 脚本；工作区里其它未提交文件一概不碰）

**需要授权的动作**：`git push origin main`（workflow 必须在默认分支才能手动触发；公开仓库的 Actions 日志公开，源码本来就公开）。

### 步骤 6：`workflow_dispatch` 试跑，修到全绿

`gh workflow run release.yml --ref main -f tag=v1.3.0 -f publish=false`，盯 `gh run watch`，失败则看日志修（预算 2–4 轮）。

### 步骤 7：冒烟（本地）

从 run 下载 artifact → 启动 → 确认主窗口出现：
- 用 **`dist/win-unpacked` 目录版** 冒烟（CI 打 nsis 时本来就产出，几乎零额外成本），**不装安装程序**——避免覆盖你已安装的正式版、避免写系统注册表
- 用 `--user-data-dir=<仓库外临时目录>` 隔离应用数据，**不碰宿主 dev 实例**（事实 8：无单实例锁，但 userData 默认共享，必须隔离）
- 窗口是否出现用 `/skill:电脑控制` 的 win32 窗口枚举确认；结束后**只关掉我自己启动的那个进程**，绝不碰宿主实例
- 若你希望连「安装程序本身」也验一遍（写注册表/开始菜单项，有覆盖正式版安装的风险），在计划批准时说明，我再单独用 `/S /D=<临时目录>` 静默装一次并卸载

### 步骤 8：收尾记录

- 更新 `AGENTS.md` 第 49 行 handoff 要求（打包行为已由 CI 负责，本地验证口径改为「CI 产物 + 隔离冒烟」）
- 重写长期记忆「PiDesktop 发布流程」的发版段（新流程 + 坑 A/B/C/D + 试跑方式）
- 迭代记录（`docs/迭代记录/2026-09.md` 归档 + 主文件最新进展；gitignore，不入库）

## 四、新的发版流程（改造后）

1. 本地：改 `package.json` 版本号 → `chore(release): 版本号 X → Y` commit → push main
2. 本地：`gh release create vX.Y.Z --repo … --title "X.Y.Z版本" --notes-file <手写三段 notes>`（**gh 会自动创建并推送 tag → 触发 CI**）
3. CI 自动：校验 pi 版本 → test → build → 打包 → 静态校验 → 挂 exe/blockmap/latest.yml 到该 Release
4. 本地：下载 CI 产物，隔离冒烟 → 通知用户
5. 本地不再跑 electron-builder、不再 `gh release upload`

## 五、验证方式

- `node .github/scripts/verify-package.cjs` 对现成 1.3.0 产物干跑通过（含反向验证转红）
- CI run 全绿：`npm test` + `npm run build` + 打包 + 静态校验全部通过
- 冒烟：win-unpacked 目录版以独立 userData 启动，主窗口出现
- 校验「pi 版本不错」这件事有**三层**证据：lock+integrity 同源、`npm ci --preinstall` 断言 node_modules 版本、asar 内 9 包版本断言

## 六、风险与假设

| 风险 | 处置 |
|---|---|
| 首次 CI 要调 2–4 轮 | 用 `workflow_dispatch`+`publish=false` 试跑，**不动任何现有 Release** |
| 坑 A（git+ssh）若重写不生效，npm ci 会断 | 已定位到唯一一条依赖；HTTPS 匿名可 clone，必要时在 CI 里显式 `git ls-remote` 验证 |
| CI 产物与本地产物有细微差异（electron 下载源、时间戳、`app-update.yml` 推断） | 首次**必须**下载冒烟；`app-update.yml` 缺失只告警不失败（当前没接 electron-updater） |
| 依赖 CI 后，CI 故障会阻塞发布 | 保留本地 `npm run package:installer` 与 `npx electron-builder` 兜底 |
| Release notes 质量下降（CI 兜底用 `--generate-notes`） | 正经流程仍是本地 `gh release create --notes-file` 手写三段 |
| 历史 8 个 Release 附件 | 本方案**不**触碰 |
| 一次性成本 | CI 单轮约 12–18 分钟（含 npm ci 与 electron 下载）；首轮求稳不加额外缓存，跑通后可加 `~/.cache/electron*` 缓存 |

## 七、不做的事

- 不改版本号、不发版、不删旧 Release 附件
- 不动 `build` 配置与 `files`/`asarUnpack`/`extraResources` 过滤器
- 不顺手重构发布流程之外的任何代码
