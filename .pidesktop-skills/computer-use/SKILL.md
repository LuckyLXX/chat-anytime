---
name: 电脑控制
description: 当用户想让你操作桌面上的其他应用窗口（打开/切换程序、点击按钮、填写输入框、敲键盘快捷键、读取屏幕内容、对屏幕截图识别）时使用。通过 Windows 原生 win32 API 控制本机任意窗口：窗口枚举、前后台截图、鼠标点击（带效果验证）、键盘输入。当前任务只涉及内置浏览器标签页时优先用 browser_* 工具，不要用本 skill。
---

# 电脑控制（computer use）

控制本机任意桌面窗口。能力分两层，**优先用内置工具，工具不够再写脚本**：

1. **内置 `computer_*` 工具**（推荐，结构化 + 权限门 + 截图直返图片）：
   `computer_windows`（枚举窗口）→ `computer_screenshot`（截图，坐标就用截图坐标系）→
   `computer_click`（点击，自动激活+像素验证）/ `computer_type`（输入文本）/
   `computer_press`（组合键）。标准节奏：枚举 → 截图看清 → 点击/输入 → 再截图验证，
   一步一验证，不要在未知状态下连续多步。
2. **本 skill 的 `ljqCtrl.py`**（长尾操作，用 bash/powershell 写 python 调用）：
   UIA 控件树探测、模板找图、后台消息级控制、WGC 后台截图等工具未覆盖的场景。
   调用方式见第 1 节。

**一律物理坐标**、**操作前先激活窗口**、**一步一验证**。

## 0. 环境自检（首次使用必做）

```bash
python -c "import win32gui, win32api, win32clipboard, PIL; print('ok')"
```

报 ImportError 就先装依赖：`pip install pywin32 pillow`（基础四件，勿装 pyautogui/opencv）。
可选增强：`pip install uiautomation`（UIA 控件树，第 3 节）、
`pip install rapidocr-onnxruntime`（视觉检测 OCR，第 4 节）。
`python` 不存在时先向用户说明并请求安装 Python 3.10+。

## 1. 写脚本调用 ljqCtrl（长尾场景）

把 `ljqCtrl.py` 所在目录（即本 SKILL.md 所在目录，read 时你知道路径）加进 sys.path：

```python
import sys
sys.path.insert(0, r"<本 SKILL.md 所在目录>")   # 例如 D:\ws\.pidesktop-skills\computer-use
import ljqCtrl
```

推荐写法：把整段脚本写进固定文件 `<工作区>/.pidesktop/cu-run.py`（覆盖写，避免堆积），然后
`python <工作区>/.pidesktop/cu-run.py` 执行；bash 工具也支持 heredoc 一次性执行。
脚本里用 `print()` 输出 JSON 摘要，方便自己核对。

## 2. API 速查

| API | 说明 |
|---|---|
| `ljqCtrl.ListWindows()` | 枚举可见顶层窗口 → `[{hwnd,title,class,rect,visible}]`，**永远第一步** |
| `ljqCtrl.FindWindow(标题子串)` | 找窗口 → hwnd；找不到抛错 |
| `ljqCtrl.Foreground()` | 当前前台窗口 `{hwnd,title,class}` |
| `ljqCtrl.Activate(hwnd)` | 切前台（自动恢复最小化）。**操作/前台截图前必调** |
| `ljqCtrl.ClientRectScreen(hwnd)` | 客户区屏幕物理矩形 `(l,t,r,b)`，**坐标换算唯一基准** |
| `ljqCtrl.GrabWindow(hwnd)` | 前台客户区截图（自动 Activate）→ PIL Image |
| `ljqCtrl.GrabWindowBg(hwnd)` | 后台截图（PrintWindow，不激活不打扰）；Electron/浏览器类窗口会截黑，见避坑 3 |
| `ljqCtrl.Click(x, y)` | 物理坐标点击，自动报告像素变化与前台变化 |
| `ljqCtrl.Press('ctrl+v')` | 组合键（键名见文件内 VK_CODE 表） |
| `ljqCtrl.type_text(text)` | 剪贴板+ctrl+v 输入文本（先点击目标输入框） |
| `ljqCtrl.ScreenCapAt(x, y)` | 物理坐标周边 ±100px 截图（验证点击效果用） |
| `ljqCtrl.dpi_scale` | 逻辑=物理×dpi_scale；外部来源的**逻辑**坐标要 `÷dpi_scale` 转物理 |

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
 Select/Value 模式，不行再枚举全部窗口找弹出层；③ 游戏窗口禁用 UIA（反作弊），
某窗口无效则降级截图路线；④ Electron/Chromium 窗口的树依赖无障碍，拿不到就
 Activate 后重试，仍不行用第 4 节视觉检测。

## 4. 视觉检测（ui_detect.py，截图定位控件）

依赖 `pip install rapidocr-onnxruntime`（开箱可用：全图 OCR 文本元素）。
可选增强：`pip install ultralytics` + OmniParser-2.0 icon_detect YOLO 权重放
 `<skill目录>/weights/icon_detect/model.pt`（额外检测无文字图标）。

```python
from ui_detect import detect
els = detect("shot.png")   # 或 PIL Image；返回 [{bbox,type:'text'|'icon',label,confidence}]
```

CLI：`python ui_detect.py shot.png --json`。**附送 OCR 不要单独再跑**。
坐标换算：`bbox 中心 + ljqCtrl.ClientRectScreen(hwnd) 左上角` → 屏幕物理坐标。

## 5. 标准工作流（每一步都要验证）

1. **探测**：`ListWindows()` 找目标窗口（按 title 子串/class 匹配），核对 hwnd。
2. **看屏**：`GrabWindow(hwnd)` 截图存 `<工作区>/.pidesktop/cu-shot.png`（固定名覆盖）。
   然后看清内容：多模态对话模型直接用 read 工具读该图片；文本模型调用
   `recognize_images` 工具传 `files=[".pidesktop/cu-shot.png"]`。
3. **算坐标**：截图内坐标 → 屏幕物理坐标 = `ClientRectScreen(hwnd)` 的 `(l,t)` + 截图内坐标。
   注意截图坐标系即物理像素。
4. **操作**：`Activate(hwnd)` → `Click(x, y)`（或点击输入框后 `type_text`）。
   `Click` 自带验证：读 `[Click check]` 输出。
5. **验证**：短暂等待后再 `GrabWindow` 截图对比，或看 Click check 报告。状态不明就回到第 2 步。

节奏纪律：新界面**先探测后操作**；一轮只做一个决策动作，读实际输出再决定下一步；
不要在未知状态下把多步操作写进一个脚本连跑。

## 6. 避坑清单（来自真实踩坑，违反必出错）

1. **一律物理坐标**：Click/SetCursorPos/截图坐标系都是物理像素。从 UIA/其他工具拿到
   逻辑坐标时 `÷ ljqCtrl.dpi_scale`。
2. **坐标换算只用 ClientToScreen 体系**（`ClientRectScreen`）。**禁止** `GetWindowRect`/
   DWM 窗口矩形 + 截图坐标——它们含标题栏边框阴影，必然错位。
3. **后台截图截黑规则**：窗口 class 为 `Chrome_WidgetWin_1`（Electron/Chromium/浏览器）
   及游戏窗口，`GrabWindowBg` 截出来是黑的——这类窗口必须用 `GrabWindow`（前台）。
   原生应用（微信/记事本/资源管理器等）后台截图正常。
4. **Click 后 0% 像素变化 = 点歪了**：立即停下诊断坐标（多为换算错误），禁止盲目重试。
   前台窗口意外变化（fg CHANGED）也要先看新窗口是什么再继续。
5. **输入文本前必须先点击输入框**（拿到焦点），否则 type_text 会粘到别处。
   type_text 会覆盖用户剪贴板，需要保留就先 `GetClipboardText()` 备份、事后恢复。
6. **严禁 import pyautogui**（污染 win32api 导致逻辑冲突）。临时脚本/截图固定文件名覆盖，用后不留堆积。
7. **不要控制 PiDesktop/ChatAnyTime 自身的窗口**（截图和操作会与当前会话自相干扰），
   除非用户明确要求。
8. **高危动作先确认**：关闭窗口、发送消息、提交订单、删除文件等不可逆操作，先用
   ask_question 或文字向用户确认再执行。
9. 弹窗/对话框挡住目标时，先截图看清弹窗内容再决定点哪里。
10. **会话恢复类应用打开即带旧内容**：记事本/浏览器会自动恢复上次标签页，新开的
   窗口未必是空白的——输入前先核对窗口标题与实际内容，别把文本粘进用户的
   未保存文档；验证输入效果用 Ctrl+A → Ctrl+C → GetClipboardText 读回比对。

## 7. 示例：向某窗口的输入框输入文本

```python
import sys, json
sys.path.insert(0, r"<本 SKILL.md 所在目录>")
import ljqCtrl

hwnd = ljqCtrl.FindWindow("记事本")          # 1. 探测
ljqCtrl.Activate(hwnd)                        # 2. 前台
img = ljqCtrl.GrabWindow(hwnd)                # 3. 看屏（存图后 read / recognize_images）
img.save(r"<工作区>/.pidesktop/cu-shot.png")
print(json.dumps(ljqCtrl.ClientRectScreen(hwnd)))   # 4. 坐标基准（截图核对后填入 x, y）
# ljqCtrl.Click(x, y)                          # 5. 点击输入框（看 [Click check]）
# ljqCtrl.type_text("你好")                     # 6. 输入
```

## 8. 来源与许可

`ljqCtrl.py` 裁剪自 [GenericAgent](https://github.com/) 的 `memory/ljqCtrl.py` +
`memory/ljqCtrlBg.py`（MIT License, Copyright (c) 2025 lsdefine）：去掉 numpy/opencv/
windows-capture 依赖，点击验证改用 PIL，剪贴板加锁重试，新增 ListWindows/type_text。
视觉检测（YOLO+OCR 定位控件）与后台消息级控制为后续扩展，本 skill 未包含。
