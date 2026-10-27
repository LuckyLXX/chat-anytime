# Git 管理器（面板作品）

作品墙上的一个面板：**只读**浏览任意本地 Git 仓库 —— 提交历史（带分支泳道图）、提交详情与代码补丁、
工作区状态（已暂存 / 未暂存 / 未跟踪）、分支与标签列表。深色玻璃拟态界面，零依赖。

```
works/git-manager/
  index.html      面板入口（结构）
  styles.css      设计系统（深色玻璃拟态 + 明暗自适应）
  app.js          界面逻辑
  graph.js        提交图形（泳道）布局，纯函数
  graph.test.mjs  泳道算法的单测（`npm test` 会跑）
  bridge.mjs      本地 Git Bridge（零依赖 Node 服务，本文件说明的主角）
```

## 怎么用

**正常路径**：作品墙点「运行」。平台会先在终端标签里执行 `node bridge.mjs`，探活通过后才打开面板窗口；
面板窗口关闭时平台自动停掉这个服务（作品声明了 `command` + `url`，见 `gallery_publish`）。

**手动起**（面板已经开着、或想自己控制进程）：

```bash
cd works/git-manager
node bridge.mjs            # 默认 8791；端口被占就换：node bridge.mjs --port 8792
```

然后面板顶栏点仓库选择器 → 粘贴任意本地仓库路径（如 `D:/projects/app`）。默认仓库取当前工作区，
最近打开的仓库记在面板自己的 `localStorage` 里（作品 origin 固定，跨启动保留）。

## 数据通道

面板页跑在 `pidesktop-file://w-<作品 id>` 上（没有 preload、跑不了外部命令），所以 git 数据由
`bridge.mjs` 现算。这个服务：

- **只监听 `127.0.0.1`**，不对外；
- **只读**：全是查询类 git 命令，不写仓库、不碰工作区文件；
- **不开 shell**：一律 `spawn("git", [args])`，路径与文件名不进命令行解释器；
- **无状态**：仓库路径每次请求自带（`?path=`），服务不记任何仓库、不落任何盘；
- **自带 CORS**（`Access-Control-Allow-Origin: *`）：面板窗口有平台级跨域放宽，但内置浏览器里
  开发同一个页面时是另一个 origin，那里的头得服务自己给。

端点（全部 GET；错误也是 HTTP 200 + `{ok:false,error}`，前端一套判据处理）：

| 端点 | 说明 |
| --- | --- |
| `/api/health` | 存活探针（作品声明的 `url` 就是它） |
| `/api/repo?path=` | 仓库概要：根目录、当前分支、HEAD、origin |
| `/api/refs?path=` | 分支 / 远程分支 / 标签 |
| `/api/log?path=&skip=&limit=&all=&ref=` | 提交列表（新→旧，默认全部分支，单页上限 200）；`ref` 存在时只列该引用可达的提交（优先于 `all`） |
| `/api/commit?path=&sha=` | 单提交详情 + 变更文件（状态、增删行） |
| `/api/diff?path=&sha=&file=` | 单文件补丁；`mode=worktree\|index\|untracked` 看未提交改动 |
| `/api/status?path=` | 工作区状态（三类改动 + 领先/落后上游） |

同一份 UI 也被桥自己 serve 在 `http://127.0.0.1:8791/`：面板页万一连不上（极端情况下浏览器策略
拦截了跨 origin 请求），面板里的引导页有「在浏览器里直连打开」按钮 —— 那个地址与桥同源，零跨域。

## 边界与已知限制

- **只读，没有写操作**：不做暂存 / 提交 / 切换分支 / 丢弃改动。要那些操作请用真正的 Git 客户端。
- **端口固定 8791**：作品声明里的 `url` 指向它。端口被占时 bridge 会以非 0 退出并打印原因，
  终端标签里能直接看到（点运行时服务就跑在那个标签里）。
- **未跟踪目录按目录聚合**：`git status` 本身的行为；未跟踪的**文件**点开可以直接看内容（桥合成伪补丁）。
- **补丁渲染上限**：单次 git 输出 8 MB 截断；前端最多铺 3000 行（超出的部分可以点「复制补丁」拿全文）。
- **大仓库**：提交列表按 60 条分页滚动加载；首屏只跑 `rev-parse` / `for-each-ref` / `log --max-count`，
  没有全量遍历。

## 开发提示

- 改完三个前端文件刷新即可（桥对静态文件发 `Cache-Control: no-store`）。
- 不需要 npm install：这个目录没有依赖，`node bridge.mjs` 直接跑（Node 18+）。
- 面板里的错误会收集在 `window.__git_manager_errors`；`window.__git_manager` 暴露了
  `openRepo / setView / selectCommit / refresh / state`，控制台里可以直接调。
- 在浏览器里开发时页面 origin 与面板 origin 不同，**存储是两份**：内置浏览器里的最近仓库列表
  不会出现在面板窗口里（反过来也一样）。
