# computer-use / computer_* 桌面控制实测缺陷修复（P0+P1+P2）

## 1. 背景

用户转来一份「电脑控制实测回归报告」（作者读完 GA 原版代码 + 本机十几轮对照实验），列出 P0（会直接导致失败或误判）、P1（死代码/错误文档）、P2（好用度）共 13 条。任务：**逐条实测复核，属实的就修**。

范围（已与用户对齐）：**skill 三个 py + SKILL.md + computer_\* 工具层一起修**；Click 验证改为 **三件套 +「0% 只警告不判失败」**；**自检脚本落进 `resources/skills/computer-use/test/`**。

## 2. 复核结论（2026-09-15 本机实测）

| 报告条目 | 复核 | 关键证据 |
| --- | --- | --- |
| P0-1 PrintWindow `flags=1` 对 DWM 合成窗口全黑，`ret=1` 且截黑不报错 | **属实** | 同一窗口（ChatAnyTime `Chrome_WidgetWin_1`，前台）：flags=1 → mean 0.0 / std 0.0 / 唯一灰度值 1（全黑）；flags=2、3 → mean 239 / 唯一值 200+ |
| P0-2 Click「0% 变化」误报 + 无命中校验 + 不校验前台 | **属实** | 自建 Tk 窗口：点真实按钮（回调命中 `hits=1`）但前后**客户区像素差恰为 0** → 现口径判「点歪」；而截图噪声（Electron 窗口连续两帧 MAD 12.7）又会判「有变化」。回执从不说明点到了哪个窗口 |
| P0-3 `GrabWindow` 不校验前台（可能拿到别的窗口的图且不报错） | **属实** | 目标矩形被别的窗口覆盖时，对该矩形 `ImageGrab` 得到的是**遮挡窗口**的颜色（192,57,43）；`Activate` 失败/被抢焦点时照样返回 |
| P1-1 `dpi_scale` 结构性恒 1，SKILL.md 换算指引失效 | **属实** | 本机 `dpi_scale == 1.0`（GetDpiForSystem=96、进程 DPI-aware）→ `/dpi_scale` 是无效操作 |
| P1-2 `ui_detect.detect()` 传 PIL 在部分 rapidocr 版本报 `LoadImageError`；tempfile 从不清理 | **属实** | 实测：`RapidOCR()(PIL.Image)` → `LoadImageError("... does not in (str, ndarray, bytes, Path)")`（1.3.24 报错、1.4.4 内部转换可用）；`detect(PIL)` 的临时 png 无删除路径 |
| P1-3 SKILL.md 避坑 3 规律写反 | **属实（文案错）** | Tk 静态窗口 flags=1 → mean 244 正常；Chromium/Electron flags=1 → 全黑。是 **flags** 问题不是窗口类问题，且「必须前台截图」的结论错 |
| P2-1..4 缺配方速查 / 缺发送类验证 / 缺降级链 / `__pycache__` 落进安装目录 | **属实** | `resources/skills/computer-use/__pycache__/` 已生成；`.gitignore` 挡住 git，但 electron-builder `extraResources.filter: **/*` 会把它打进安装包 |
| 「ImageGrab 只抓主显示器 → 非主屏坐标会错」 | **部分属实，本机无法复现** | 单屏 1920×1080、虚拟桌面原点 (0,0)，`all_screens=True/False` 逐像素相同 |

报告没写、但直接影响改法的两条新事实：

1. **`PrintWindow(flags=2/3)` 的位图从客户区左上角开始**（不是窗口左上角）：窗口尺寸位图按 `ClientToScreen−GetWindowRect` 偏移裁切 vs 真值 MAD=19.97，直接从 (0,0) 裁成客户区尺寸 MAD=0.000（前台 ChatAnyTime 实测）→ 无需 `DwmGetWindowAttribute`。
2. **命中判定可行**：`WindowFromPoint` + `GetAncestor(GA_ROOT)` 与目标 hwnd 比较，自建 Tk 窗口实测 `hit_ok=True`，被遮挡时返回遮挡窗口句柄（正是要抓的错）。

## 3. 决策（已对齐）

- 不做：不引入 numpy/opencv 到 ljqCtrl 核心（仅自检脚本与 ui_detect 用/可选）；不改权限模型；不动 browser_*/预览；不重构无关代码。
- Click 验证 = 点前后像素差 + 命中窗口校验 + 光标处前台校验，**0% 只警告**；报告逐项写明并给可执行下一步。
- 自检脚本作为 skill 资产入库，可随时手动跑（防「凭属性猜结论」再犯）。

## 4. 实施步骤

### S1 `resources/skills/computer-use/ljqCtrl.py`

1. `_grab_printwindow(hwnd, size, flags=3)`：默认 `PW_CLIENTONLY|PW_RENDERFULLCONTENT`；文档注明「`ok` 只表示没抛异常，返回黑≠不支持」。
2. `GrabWindowBg` 改 flags=3 + docstring 重写（后台截图对 DWM/Chromium 同样有效；黑屏才是真不支持）。
3. `GrabWindow`：截图后校验前台，结果写进 `img.info`（`cu_fg_hwnd/cu_fg_title/cu_fg_ok/cu_client_origin/cu_client_size`），不一致打印 `[GrabWindow] ⚠️ …`；**不改返回类型、不抛错**。
4. `Activate(hwnd, verify=True)`：切换后核对前台并打印 `[Activate] ⚠️ 前台切换失败…`。
5. `Click(x, y, check=True, double=False, hwnd=None)`：返回**报告 dict**（原返回值是局部切图，仓库内无消费者）：命中校验（`WindowFromPoint`+GA_ROOT、`hit_ok`）、`in_client`（客户端坐标是否落在目标客户区）、变化项（`roi_changed` ±100 + `client_changed`/`client_diff_ratio`，**只判「有无像素差」，不设阈值**——阈值化会造出更难懂的假阴性）、前台项（`fg_title_after/fg_ok`）、`verdict`（changed / warn_static / warn_hit / warn_foreground）+ `advice`；仍打印一行同前缀 `[Click check] …`（工具层继续当 notes 收集）。
6. 删掉误导性换算写法：`dpi_scale` 保留（对外兼容）但标注「DPI-aware 进程内恒 1.0，只用于换算**外部来源的逻辑坐标**，不要拿它除截图坐标」，并在 Click/Press 附近写清「本模块坐标一律屏幕物理像素」。
7. 新增 `RootWindow(hwnd)` 小工具（命中校验共用）。

### S2 `resources/skills/computer-use/ui_detect.py`

- 新增 `_as_ndarray(image)`（PIL → numpy，numpy 随 rapidocr 必装；缺则给 `pip install` 提示）。
- `detect()` 接受 PIL / ndarray / 路径 / bytes；YOLO daemon 需要文件时用 `try/finally` 删除临时文件（修泄漏）。
- `_ocr_crops_batch` 拼接图改传 ndarray（不依赖 1.4 的 PIL 兼容）。
- docstring 记录实测版本差异（1.3.24 拒绝 PIL，1.4.4 可用）。

### S3 `src/main/runtime-computer.ts`

- `OP_SCREENSHOT`：结果带 `fg_ok/fg_title`；文案在 `fg_ok=false` 时改为「⚠️ 截图时前台是「X」不是目标窗口，这张图可能不是你想要的」。
- `OP_CLICK`：改调 `ljqCtrl.Click(x, y, hwnd=hwnd, double=…)`，回执渲染三项报告 + 可执行建议；notes 照旧回传。
- description 更新：`computer_click`/`computer_screenshot` 明确「0% 变化不等于点击失败」「截图回执带前台校验」。
- 权限、saveScreenshot、overlay 均不动。

### S4 `resources/skills/computer-use/SKILL.md`

- §0 加 `test/selfcheck.py`；§2 API 表更新（GrabWindowBg/Click 报告/dpi_scale）；§3 删掉「Electron 窗口截黑」错误说法（保留「UIA 树拿不到」这一正确限制）；§4 补 PIL/ndarray 版本事实与临时文件纪律；§5 点击后读三项报告 + 发送类动作验证口径（「点了发送」不算成功，要看见消息出现在列表里 / 读回文本比对）；§6 改写避坑 3（flags 问题，flags=3 全黑窗口也能截），新增「0% 变化 ≠ 点歪」「Activate 后前台可能不是目标窗口」「坐标一律物理像素、dpi_scale 别乱除」「降级链 UIA → 视觉检测 → 截图估坐标 → 问用户」；新增 §9 常见应用配方（通用化：输入→Enter 发送、列表项先 UIA/OCR 拿 bbox、下拉优先 Select 模式、多标签先核对标题）。

### S5 新增 `resources/skills/computer-use/test/selfcheck.py`

纯标准库 + pywin32 + Pillow，自造窗口自收拾，分档 `--printwindow / --click / --screenshot / --ocr / --uia / --all`：

| 用例 | 断言 |
| --- | --- |
| printwindow | 同窗口 flags=3 得真实内容（唯一灰度值 > 20）；打印 flags=1 是否全黑作为环境指纹 |
| click | 造 Tk 按钮 + 色板：点按钮 `hit_ok=True`；点改色板 `client_changed=True`；点静态区域 `verdict=warn_static`（证明「无变化 ≠ 点歪」） |
| screenshot | `GrabWindow(目标)` 中心像素 == 该窗口背景色；`img.info['cu_fg_ok']=True` |
| ocr | `detect(PIL Image)` 不抛错且识别出注入文本（覆盖 1.3/1.4） |
| uia | Tk 窗口跑 `uia.Tree()` 冒烟（不硬断言） |

纪律：结束 destroy 自建窗口、前台恢复为运行前的窗口，不碰第三方应用窗口；输出 `[PASS]/[FAIL]` + JSON，失败退出码非 0。

### S6 打包

`package.json` 的 `extraResources` 过滤加 `!**/__pycache__/**`、`!**/*.pyc`，并用 `npm run package:win` 验证产物里没有字节码。

### S7 测试与文档

- `src/main/runtime-computer.test.ts`：截图回执 `fg_ok=false` 的警告文案、点击回执三项报告渲染、notes 仍收集新前缀。
- 迭代记录：`docs/迭代记录/2026-09.md` 追加条目 + 主文件「最新进展」一句；待办区登记本报告里**无法证伪/未修**的两条（见风险 4）。
- 长期记忆：更新「PiDesktop 踩坑记录」的 win32 硬事实（PrintWindow flags=3、点击三件套、前台校验、dpi_scale 恒 1）+ 自检脚本入口。
- commit：`fix(computer): PrintWindow flags=3 修复后台截图全黑 + Click 三件套验证 + skill 文档与自检脚本`（**仅本地 commit**；不推、不打 tag、不升版本号，发版等用户安排）。

## 5. 验证方式

1. `npm test` + `npm run build` 全绿（含新增用例）。
2. 真机 `python resources/skills/computer-use/test/selfcheck.py --all`。
3. 真机 e2e：自建 Tk 窗口走 Click/输入/截图（复用 `.pidesktop/` 里已写好的探针，不入库新脚本）。
4. `npm run package:win` 后核对 `dist/win-unpacked/resources/skills/computer-use/`：无 `__pycache__`、py 为新版。
5. 运行中的实例不受影响（dev 下运行时读仓库 `resources/skills/`，重启应用生效——重启是用户的步骤，我不动宿主进程）。

## 6. 风险与假设

1. **`PW_RENDERFULLCONTENT`(flags=2) 官方标注 Win8.1+**：本项目只跑 Win10/11，可接受；不做旧系统分支（回退点就是 flags=1）。
2. **点击验证无法 100% 判定「生效」**：本质是「命中目标 + 有像素变化」；方案只把**确定的错**（命中不在目标窗口、前台被抢）明确报出来，把不确定的（0% 变化）降级为警告+建议，避免制造新的假阴性。
3. **噪声**：动画/视频/闪烁光标会让「有变化」恒真（Electron 窗口连续两帧 MAD 12.7），故变化项只作弱信号，命中与前台才是强信号。
4. **未修/无法证伪的留待办**：① 多屏/负坐标下 `ImageGrab` 是否需 `all_screens=True`（本机单屏无法复现）；② 「操作期间前台被抢后是否自动中止/重试」仍交给模型按报告决定（工具层不擅自重试）。
5. **打包改动**：`extraResources` 过滤属打包行为变更，若 `npm run package:win` 异常，回退该过滤（不影响功能修复）。
