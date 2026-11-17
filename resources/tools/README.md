# 内置查找工具（fd / ripgrep）

Pi 的 `find` / `grep` 工具只有一条实现路径：spawn **fd**（按 glob 找文件）与 **ripgrep / rg**（搜文件内容）。
Pi 解析二进制的顺序是：

1. `<agentDir>/bin/fd.exe`、`<agentDir>/bin/rg.exe`（`agentDir` 默认 `~/.pi/agent`）
2. 系统 `PATH`
3. 从 GitHub Release 下载（10s 网络超时 ×3 次重试，再 120s 下载超时）

第 3 步在**内网 / 无外网**的机器上必然失败，而且 Pi 没有失败缓存——每次调用 find/grep 都会重新尝试下载，
防火墙丢包时每轮先卡 30 秒再报错「fd is not available and could not be downloaded」，能力等于丢失。

所以这里随安装包内置这两个二进制：主进程解析出 `<安装目录>/tools` 后经 `initialize` 下发给 utility 进程，
由 `src/main/bundled-tools.ts` 幂等同步到 `<agentDir>/bin/`。第一次启动即落地，无需外网。

## 文件

| 文件 | 版本 | 上游 | 许可证 |
| --- | --- | --- | --- |
| `fd.exe` | fd 10.5.0（win32-x64） | https://github.com/sharkdp/fd | MIT / Apache-2.0 双许可 |
| `rg.exe` | ripgrep 15.2.0（win32-x64） | https://github.com/BurntSushi/ripgrep | MIT / Unlicense 双许可 |

## 同步规则（不覆盖用户自己的版本）

见 `src/main/bundled-tools.ts`：

- 目标不存在 → 复制
- 目标存在、且内容与部署清单 `<agentDir>/pidesktop-tools-deploy.json` 记录一致（= 上次是我们放的）→ 内置版本更新时覆盖
- 目标存在、但内容与清单不一致或没有记录（= 用户自己放的 / 手工替换过）→ **不动**，尊重用户

## 更新二进制

替换本目录下的文件（macOS/Linux 放无后缀的 `fd` / `rg`），并同步更新上表与
`src/main/bundled-tools.test.ts` 的版本断言即可；打包后首次启动会自动覆盖上一版由我们部署的文件。
