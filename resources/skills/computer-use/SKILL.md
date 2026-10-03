---
name: 电脑控制
description: 当用户想让你操作桌面上的其他应用窗口（打开/切换程序、点击按钮、填写输入框、敲键盘快捷键、读取屏幕内容、对屏幕截图识别）时使用。通过 Windows 原生 win32 API 控制本机任意窗口：窗口枚举、前后台截图、鼠标点击（带效果验证）、键盘输入。当前任务只涉及内置浏览器标签页时优先用 browser_* 工具，不要用本 skill。
---

# 电脑控制（computer use）

> 本目录随应用分发（安装目录 `resources/skills/computer-use/`，仓库源 `resources/skills/`），是**内置资产**：
> 所有工作区、所有角色都能看到它，随应用升级。要自定义就把整个 `computer-use/` 目录复制到
> 全局技能目录 `~/.pi/agent/pidesktop-skills/computer-use/`（同名会覆盖内置），或复制到
> 项目技能目录 `<工作区>/.pidesktop-skills/computer-use/`（项目优先于全局与内置）。
> 改过之后可以随时自检：`python <skill目录>/test/selfcheck.py --all`（见第 0 节）。

控制本机任意桌面窗口。能力分两层，**优先用内置工具，工具不够再写脚本**：

1. **内置 `computer_*` 工具**（推荐，结构化 + 权限门 + 截图直返图片）：
   `computer_windows`（枚举窗口）→ `computer_screenshot`（截图，坐标就用截图坐标系）→
   `computer_click`（点击，自动激活 + 命中/变化/前台三项验证）/ `computer_type`（输入文本）/
   `computer_press`（组合键）。标准节奏：枚举 → 截图看清 → 点击/输入 → 再截图验证，
   一步一验证，不要在未知状态下连续多步。
2. **本 skill 的 `ljqCtrl.py`**（长尾操作，用 bash/powershell 写 python 调用）：
   UIA 控件树探测、模板找图、后台截图（`GrabWindowBg`）、后台消息级控制等工具未覆盖的场景。
   调用方式见第 1 节。

**一律物理坐标**、**操作前先激活窗口**、**一步一验证**、**读工具回执的三项验证再决定下一步**。

## 0. 环境自检（首次使用必做）

```bash
python -c "import win32gui, win32api, win32clipboard, PIL; print('ok')"
python <本目录>/test/selfcheck.py --all      # 完整自检（自造窗口，不改动别人的窗口）
```

报 ImportError 就先装依赖：`pip install pywin32 pillow`（基础四件，勿装 pyautogui/opencv）。
可选增强：`pip install uiautomation`（UIA 控件树，第 3 节）、
`pip install rapidocr-onnxruntime`（视觉检测 OCR，自带 numpy，第 4 节）。
`python` 不存在时先向用户说明并请求安装 Python 3.10+。

`test/selfcheck.py` 分档：`--printwindow`（后台截图 flags 对照）/ `--click`（点击验证口径）/
`--screenshot`（前台校验）/ `--ocr`（视觉检测入参兼容）/ `--uia`（控件树冒烟）/ `--all`。
它自己造 Tk 窗口、跑完自己收拾并恢复原来的前台窗口；输出 `[PASS]/[FAIL]`，退出码非 0 表示有失败。
**凭经验写断言前先跑一遍它**——本 skill 历史上有两条结论就是靠它推翻的。

## 1. 写脚本调用 ljqCtrl（长尾场景）

把 `ljqCtrl.py` 所在目录（即本 SKILL.md 所在目录，read 时你知道路径）加进 sys.path：

```python
import sys
sys.path.insert(0, r"<本 SKILL.md 所在目录>")   # 内置资产：<安装目录>\resources\skills\computer-use
import ljqCtrl
```

推荐写法：把整段脚本写进固定文件 `<工作区>/.pidesktop/cu-run.py`（覆盖写，避免堆积），然后
`python <工作区>/.pidesktop/cu-run.py` 执行；bash 工具也支持 heredoc 一次性执行。
脚本里用 `print()` 输出 JSON 摘要，方便自己核对。

## 2. API 速查

**坐标语义（先读）**：本模块所有坐标（Click/截图内坐标/ClientOrigin/ClientRectScreen）
一律是**屏幕物理像素**；进程启动就调了 `SetProcessDPIAware()`，所以 125%/150% 缩放下也直接可用。
`ljqCtrl.dpi_scale` 在 DPI-aware 进程里**恒为 1.0**，只能用来把**外部来源的逻辑坐标**
（字体度量、某 SDK 的 DIP）换成物理：`物理 = 逻辑 × dpi_scale`。**别拿它去除截图坐标**——
那等于什么都没做，只会让人以为换算过了。

| API | 说明 |
|---|---|
| `ljqCtrl.ListWindows()` | 枚举可见顶层窗口 → `[{hwnd,title,class,rect,visible}]`，**永远第一步**（rect 是含边框窗口矩形，不是客户区） |
| `ljqCtrl.FindWindow(标题子串)` | 找窗口 → hwnd；找不到抛错 |
| `ljqCtrl.RootWindow(hwnd)` / `WindowAt(x, y)` | 顶层窗口句柄 / 屏幕点上真正躺着的顶层窗口（命中校验用） |
| `ljqCtrl.Foreground()` | 当前前台窗口 `{hwnd,title,class}` |
| `ljqCtrl.Activate(hwnd, verify=True)` | 切前台（自动恢复最小化）；**switch 失败会打印 `[Activate] ⚠️` 警告**——注意 Windows 会拒绝后台进程的前台请求 |
| `ljqCtrl.ClientRectScreen(hwnd)` | 客户区屏幕物理矩形 `(l,t,r,b)`，**坐标换算唯一基准** |
| `ljqCtrl.GrabWindow(hwnd)` | 前台客户区截图（自动 Activate）→ PIL Image；**`img.info['cu_fg_ok']` 报告截图时前台是否就是目标窗口**，False 说明这张图可能不是目标窗口的画面 |
| `ljqCtrl.GrabWindowBg(hwnd)` | 后台截图（PrintWindow，不激活不打扰）→ PIL Image。**DWM 合成窗口（Chromium/Electron/浏览器/UWP）同样能截**（内部用 `PW_CLIENTONLY\|PW_RENDERFULLCONTENT`）；真的全黑才是该窗口不支持 |
| `ljqCtrl.Click(x, y, hwnd=…)` | 物理坐标点击 → **报告 dict**，看 `verdict` / `advice`（详见第 5 节的验证口径）；**`hwnd=` 必传**：传了才会做「命中窗口」校验与点击前守卫 |
| `ljqCtrl.Press('ctrl+v')` | 组合键（键名见文件内 VK_CODE 表） |
| `ljqCtrl.type_text(text)` | 剪贴板+ctrl+v 输入文本（先点击目标输入框） |
| `ljqCtrl.ScreenCapAt(x, y)` | 物理坐标周边 ±100px 截图（验证点击效果用） |

## 3. UIA 控件树（uia.py，原生应用首选探测路线）

依赖 `pip install uiautomation`。**比截图估坐标稳定得多**：免坐标读写控件，
原生应用（记事本/资源管理器/计算器/传统 Win32/Qt）优先走这条路线。

| API | 说明 |
|---|---|
| `uia.Tree(window, depth=8, query=None)` | 枚举控件树 → `[{role,name,value,rect,enabled,auto_id,depth}]`（≤300 节点） |
| `uia.Find(window, name=, control_type=, exact=False)` | 按名称子串/类型查找（exact=True 精确匹配，**同名前缀控件必须用 exact**） |
| `uia.ClickEl(window, name=, exact=)` | 免坐标点击：Invoke/Select/Toggle 模式优先，无模式回退矩形中心坐标 |
| `uia.SetTextEl(window, text, name=)` | ValuePattern 直接写文本（比键入快、不抢输入法） |
| `uia.GetValue(window, name=)` | 读控件当前值 |

CLI：`python uia.py "窗口名" --find 按钮` / `--click 确定` / `--tree`。

**坑**：① control_type 传 `Button`/`ListItem`/`Edit` 即可（与 `ButtonControl` 等价）；
② 下拉/弹出菜单是**独立顶层窗口**，不在原窗口树里——切选项优先用控件自身的
 Select/Value 模式，不行再 `ListWindows()` 枚举全部窗口找弹出层；③ 游戏窗口禁用 UIA（反作弊），
某窗口无效则降级截图路线；④ Electron/Chromium 窗口的 UIA 树依赖无障碍，未激活时可能拿不到，
 Activate 后重试，仍不行用第 4 节视觉检测（**这是 UIA 的限制，不是截图限制**——后台截图对
 Electron 窗口已经可用，两者别搞混）。

## 4. 视觉检测（ui_detect.py，截图定位控件）

依赖 `pip install rapidocr-onnxruntime`（自带 numpy；开箱可用：全图 OCR 文本元素）。
可选增强：`pip install ultralytics` + OmniParser-2.0 icon_detect YOLO 权重放
 `<skill目录>/weights/icon_detect/model.pt`（额外检测无文字图标）。

```python
from ui_detect import detect
els = detect("shot.png")   # 路径 / PIL.Image / ndarray / bytes 都行
# 返回 [{bbox,type:'text'|'icon',label,confidence}]
```

CLI：`python ui_detect.py shot.png --json`。**附送 OCR 不要单独再跑**。
坐标换算：`bbox 中心 + ljqCtrl.ClientRectScreen(hwnd) 左上角` → 屏幕物理坐标。

入参兼容：rapidocr 各版本对 PIL 的容忍度不同（1.3.24 直接报 `LoadImageError`），
本模块统一在内部转 ndarray，所以你传 PIL 也没问题；YOLO 需要磁盘路径时落的临时文件
用完即删（不要自己再造临时 png 堆积）。

## 5. 标准工作流（每一步都要验证）

1. **探测**：`ListWindows()`（或内置 `computer_windows`）找目标窗口（按 title 子串/class 匹配），核对 hwnd。
2. **看屏**：`GrabWindow(hwnd)` 截图存 `<工作区>/.pidesktop/cu-shot.png`（固定名覆盖）。
   **先看前台校验**：`img.info['cu_fg_ok']` 为 False 就说明截到的可能是**别的窗口的画面**，
   别拿它算坐标（先 Activate 重试）。
   然后看清内容：多模态对话模型直接用 read 工具读该图片；文本模型调用
   `recognize_images` 工具传 `files=[".pidesktop/cu-shot.png"]`。
3. **算坐标**：截图内坐标 → 屏幕物理坐标 = `ClientRectScreen(hwnd)` 的 `(l,t)` + 截图内坐标。
   注意截图坐标系即物理像素。
4. **操作**：`Activate(hwnd)` → `Click(x, y, hwnd=hwnd)`（或点击输入框后 `type_text`）。
   内置 `computer_click` 已自动传 hwnd。**坐标上坐着别的应用的窗口时会被直接拒绝点击**
   （`verdict='refused_hit'`）——这是好事，说明坐标错了，重新截图算。
5. **验证**（点击回执三件套，按强→弱读）：   - **命中**（强）：`hit_ok` / `hit_hwnd` / `hit_title`——被拒绝或命中别的窗口，先修坐标。
   - **前台**（强）：`fg_ok` / `fg_title_after`——False 说明焦点在别的窗口，需要键盘时先 Activate。
   - **变化**（弱）：`client_changed` / `client_diff_ratio`、`roi_changed`。
     **无变化不等于点歪**（静态区域、无视觉回馈的控件正常无变化）；反过来动画/视频会让
     「有变化」恒真。要确认效果就重新截图看界面状态，**不要盲目重复点击**。
6. **发送类动作的验证口径**：点击「发送」/回车提交这类不可逆动作，**回执说「已点击」不算成功**——
   必须看到结果出现在目标位置（消息出现在列表里、弹窗关闭、新窗口出现），
   或读回文本比对（`ctrl+a` → `ctrl+c` → `GetClipboardText()`）。
   没有可观测结果就停下来问用户，不要反复重试。

节奏纪律：新界面**先探测后操作**；一轮只做一个决策动作，读实际输出再决定下一步；
不要在未知状态下把多步操作写进一个脚本连跑。

**探测降级链**（上一层拿不到就走下一层，别硬猜坐标）：
UIA 控件树（原生应用最稳、免坐标）→ 视觉检测 OCR/YOLO（有文字/图标的控件）→
截图人工估坐标（最后手段）→ 都不可靠时停下来问用户。

## 6. 避坑清单（来自真实踩坑，违反必出错）

1. **一律物理坐标**：Click/SetCursorPos/截图坐标系都是物理像素。从 UIA/其他工具拿到
   逻辑坐标时 `物理 = 逻辑 × ljqCtrl.dpi_scale`——注意本进程内 `dpi_scale` **恒为 1.0**
   （DPI-aware），它不是「必须除一下的系数」，别把截图坐标又除一遍。
2. **坐标换算只用 ClientToScreen 体系**（`ClientRectScreen`）。**禁止** `GetWindowRect`/
   DWM 窗口矩形 + 截图坐标——它们含标题栏边框阴影，必然错位。（`ListWindows().rect`
   也是含边框的窗口矩形，只能用来判断窗口大概在哪，不能拿来算客户区坐标。）
3. **后台截图看 flags，不看窗口类别**：`PrintWindow` 只给 `PW_CLIENTONLY(1)` 时，
   DWM 合成窗口（Chromium/Electron/浏览器/UWP）会返回**全黑帧**且返回值为 1（不能当成功判据）；
   加上 `PW_RENDERFULLCONTENT(2)`（即 flags=3，本模块默认）后这些窗口同样能截到内容。
   原生窗口在 flags=1 下往往恰好正常，于是历史避坑清单错误地记成了「Electron 必须前台截图」。
   真的全黑才是该窗口不支持后台截图，那时再用 `GrabWindow`（前台）。
4. **点击回执先看「命中」和「前台」，最后才看「变化」**：
   - 命中不对（被拒绝 / `hit_ok=False`）= 坐标错了或被遮住，重新截图算，**不要盲目重试**；
   - 前台被抢 = 后续键盘会落到别的窗口，需要键盘先 `Activate`；
   - 无像素变化 ≠ 点歪（静态区域正常无变化；实测点真实按钮也可能整体零变化）。
5. **`Activate` 之后必须核对前台**：Windows 会拒绝后台进程的前台请求（本模块会打印
   `[Activate] ⚠️`）；而 `GrabWindow` 是按「目标客户区那块屏幕区域」抓图的，
   前台不对时它会拿到**别的窗口的画面**而且不报错——所以它也在 `img.info['cu_fg_ok']` 里标出来。
6. **输入文本前必须先点击输入框**（拿到焦点），否则 type_text 会粘到别处。
   type_text 会覆盖用户剪贴板，需要保留就先 `GetClipboardText()` 备份、事后恢复。
7. **严禁 import pyautogui**（污染 win32api 导致逻辑冲突）。临时脚本/截图固定文件名覆盖，用后不留堆积；
   不要再自己造临时 png（`ui_detect` 需要时自己管生自己删）。
8. **不要控制 PiDesktop/ChatAnyTime 自身的窗口**（截图和操作会与当前会话自相干扰），
   除非用户明确要求。
9. **高危动作先确认**：关闭窗口、发送消息、提交订单、删除文件等不可逆操作，先用
   ask_question 或文字向用户确认再执行。
10. 弹窗/对话框挡住目标时，先截图看清弹窗内容再决定点哪里。下拉/菜单是独立顶层窗口，
    内部已放行同进程窗口，但优先用 UIA 的 Select/Value 模式（不用猜坐标）。
11. **会话恢复类应用打开即带旧内容**：记事本/浏览器会自动恢复上次标签页，新开的
   窗口未必是空白的——输入前先核对窗口标题与实际内容，别把文本粘进用户的
   未保存文档；验证输入效果用 Ctrl+A → Ctrl+C → GetClipboardText 读回比对。

## 7. 常见任务配方（少踩坑的固定序列）

> 通用原则：能用 UIA/OCR 拿到控件就不要估坐标；每步之后看回执再决定下一步。

**在应用的输入框里输入并发送**

1. `computer_screenshot` → 看清输入框位置；能走 UIA 就 `uia.SetTextEl(window, text)`（免坐标、不抢输入法）。
2. 坐标路线：`computer_click` 点输入框（看回执命中/前台两项）→ `computer_type` 输入 →
   **读回比对**（Ctrl+A/C 后 `GetClipboardText()`）→ `computer_press` 发送键（Enter / ctrl+enter）。
3. **发送后必须验证结果出现在目标位置**（消息气泡/列表项），不能只看「已发送按键」。

**点击列表项/表格行**：先 OCR 或 UIA 拿该项的 bbox/rect（中心点即目标），再点；
点完后看回执的「变化」与截图确认选中态，不要连点两次。

**下拉选择**：优先控件自身的 Select/Value 模式；不行再展开后枚举顶层窗口找弹出层
（弹出菜单不在原窗口树里），点弹层里的目标项。

**多标签应用（浏览器/终端）**：操作前先核对窗口标题与实际内容；需要切标签用快捷键
（ctrl+tab）时先确认前台是目标窗口（看回执 `fg_ok`），否则快捷键会发到别的应用去。

**看不到的窗口**：先试 `GrabWindowBg`（不抢用户焦点）；全黑才改用 `GrabWindow`（会抢前台）。

**纯文本模型**：截图后用 `recognize_images` 读图（或 `ui_detect.py --json` 拿带坐标的元素列表，
比把整张图丢给视觉模型更省）。

## 8. 示例：向某窗口的输入框输入文本

```python
import sys, json
sys.path.insert(0, r"<本 SKILL.md 所在目录>")
import ljqCtrl

hwnd = ljqCtrl.FindWindow("记事本")          # 1. 探测
ljqCtrl.Activate(hwnd)                        # 2. 前台（失败会打 [Activate] ⚠️）
img = ljqCtrl.GrabWindow(hwnd)                # 3. 看屏（存图后 read / recognize_images）
img.save(r"<工作区>/.pidesktop/cu-shot.png")
assert img.info["cu_fg_ok"], f"前台不是目标窗口：{img.info['cu_fg_title']}"   # 图不可信就别用
print(json.dumps(ljqCtrl.ClientRectScreen(hwnd)))   # 4. 坐标基准（截图核对后填入 x, y）
# report = ljqCtrl.Click(x, y, hwnd=hwnd)      # 5. 点击输入框：读 report['verdict']/['advice']
#     → 命中不对/被拒绝就先重新截图，别急着重试
# ljqCtrl.type_text("你好")                     # 6. 输入
# ljqCtrl.Press('ctrl+a'); ljqCtrl.Press('ctrl+c')   # 7. 读回比对确认输入真的进去了
# print(repr(ljqCtrl.GetClipboardText()))
```

## 9. 来源与许可

`ljqCtrl.py` 裁剪自 [GenericAgent](https://github.com/) 的 `memory/ljqCtrl.py` +
`memory/ljqCtrlBg.py`（MIT License, Copyright (c) 2025 lsdefine）：去掉 numpy/opencv/
windows-capture 依赖，点击验证改用 PIL，剪贴板加锁重试，新增 ListWindows/type_text。
`ui_detect.py` 与 `test/selfcheck.py` 同样源自 GenericAgent（MIT）或为 PiDesktop 新增。
