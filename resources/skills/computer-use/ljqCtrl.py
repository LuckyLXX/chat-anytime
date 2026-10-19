"""
PiDesktop computer-use skill — Windows 窗口探测与控制（最小集）

源自 GenericAgent 项目 memory/ljqCtrl.py 与 memory/ljqCtrlBg.py（MIT License,
Copyright (c) 2025 lsdefine），按 PiDesktop 最小集裁剪：仅保留窗口枚举、
前台/后台截图、鼠标点击、键盘输入、剪贴板输入，去除 numpy/cv2/windows-capture
依赖（点击验证改用 PIL ImageChops，后台截图走 PrintWindow）。

依赖: pip install pywin32 pillow
CRITICAL: 严禁在此工具链中 import pyautogui（会污染 win32api 导致逻辑冲突）。

坐标语义（先读这条）
- 本模块所有坐标（Click/Press/ClientOrigin/ClientRectScreen/截图内坐标）一律是
  **屏幕物理像素**。进程开头已调 SetProcessDPIAware()，所以 GetCursorPos / SetCursorPos /
  mouse_event / ClientToScreen 都是物理像素，100% 与 150% 缩放下都直接可用。
- dpi_scale 在 DPI-aware 进程内**恒等于 1.0**（它是「逻辑/物理」比，只有在进程**非**
  DPI-aware 时才有信息量）。它只用于换算**外部来源的逻辑坐标**（例如字体度量、某 SDK
  返回的 DIP 坐标）：物理 = 逻辑 × dpi_scale。**不要**用它去除截图坐标或客户区坐标——
  那等于什么都没做，只会让人误以为做过换算。

Quick Reference:
- dpi_scale: float（本进程内恒 1.0；见上「坐标语义」）
- ListWindows(visible_only=True) -> [{hwnd,title,class,rect,visible}]
- FindWindow(name, exact=False, class_name=None) -> hwnd
- RootWindow(hwnd) -> 顶层窗口句柄（命中校验用）
- Foreground() -> {hwnd,title,class}（当前前台窗口）
- Activate(hwnd, verify=True): 稳定切换前台（先恢复最小化，假 Alt 键骗过前台锁），
  切换后核对 GetForegroundWindow，不一致打印 [Activate] 警告
- GrabWindowBest(hwnd_or_title) -> PIL Image（**截图默认用它**：后台优先，不激活、
  不受遮挡；窗口最小化会先恢复；后台帧失败/全黑才回退前台截图；
  img.info['cu_mode'] = 'background' | 'foreground'，img.info['cu_restored'] 表示是否恢复过）
- GrabWindow(hwnd_or_title) -> PIL Image（前台客户区截图，自动 Activate；
  img.info['cu_fg_ok'] 报告截图时前台是否就是目标窗口）
- GrabWindowBg(hwnd_or_title) -> PIL Image（PrintWindow 后台截图，不激活不打扰；
  用 PW_CLIENTONLY|PW_RENDERFULLCONTENT，DWM 合成窗口（Chromium/Electron）也能截；
  真的全黑才是该窗口不支持）
- ClientOrigin(hwnd_or_title) -> (x, y)（客户区原点的屏幕物理坐标）
- Click(x, y, check=True, double=False, hwnd=None) -> 报告 dict：
  命中窗口校验 + 客户区变化（屏幕轮询，遮挡时用后台渲染帧复核；
  report['client_change_source'] 说明结论来自哪一路）+ 光标处前台校验；
  读 report['verdict'] 与 report['advice']，**无像素变化不等于点歪**
- ForegroundGuard(hwnd, action='输入') -> None 或拒绝报告 dict（切不到前台就不注入按键）
- Press(cmd): 组合键（如 'ctrl+v'、'alt+tab'、'enter'；'win'/'cmd'/'return'/'delete' 有别名）
- SetClipboardText(text) / TryGetClipboardText() / type_text(text): 剪贴板 + ctrl+v 输入文本
  （TryGetClipboardText 在剪贴板是图片/文件时返回 None，不抛异常）
- IsMinimized(hwnd) -> bool
- ScreenCapAt(x, y, r=100) -> PIL Image（物理坐标周边截图）
"""
import ctypes
import time

import win32api
import win32clipboard
import win32con
import win32gui
import win32process

# 逻辑/物理坐标比。SetProcessDPIAware 之后进程坐标系即物理像素，所以本值恒为 1.0，
# 仅用于把「外部来源的逻辑坐标」换算成物理坐标（见文件头「坐标语义」）。
dpi_scale = 1

try:
    from PIL import Image, ImageChops, ImageGrab
except ImportError:
    Image = ImageChops = ImageGrab = None  # type: ignore[assignment]

ctypes.windll.user32.SetProcessDPIAware()

# 全屏抓图 / 后台渲染帧的虚拟桌面原点（多屏时副屏可能落在负坐标）：
# ImageGrab.grab(all_screens=True) 的 (0,0) 是虚拟桌面左上角，不是主屏左上角，
# 所以「自己按屏幕坐标裁」必须先减掉这个偏移（Pillow 只在传 bbox 时替你换算）。
def _virtual_origin():
    return (int(win32api.GetSystemMetrics(win32con.SM_XVIRTUALSCREEN)),
            int(win32api.GetSystemMetrics(win32con.SM_YVIRTUALSCREEN)))

# PrintWindow 标志位（见 _grab_printwindow：只用 CLIENTONLY 会让 DWM 合成窗口全黑）
PW_CLIENTONLY = 0x00000001
PW_RENDERFULLCONTENT = 0x00000002

_hdc = ctypes.windll.user32.GetDC(0)
swidth = ctypes.windll.gdi32.GetDeviceCaps(_hdc, 118)   # DESKTOPHORZRES（物理）
sheight = ctypes.windll.gdi32.GetDeviceCaps(_hdc, 117)  # DESKTOPVERTRES（物理）
ctypes.windll.user32.ReleaseDC(0, _hdc)
cwidth = win32api.GetSystemMetrics(win32con.SM_CXSCREEN)   # 逻辑
cheight = win32api.GetSystemMetrics(win32con.SM_CYSCREEN)  # 逻辑
dpi_scale = cwidth / swidth

HwndLike = (int, str)

def _resolve_hwnd(hwnd_or_name):
    if isinstance(hwnd_or_name, int):
        if not win32gui.IsWindow(hwnd_or_name):
            raise RuntimeError(f"invalid hwnd: {hwnd_or_name!r}")
        return hwnd_or_name
    return FindWindow(str(hwnd_or_name))

# ---------------------------------------------------------------- 窗口枚举

def ListWindows(visible_only: bool = True):
    """枚举顶层窗口。visible_only=False 时包含无标题的隐藏窗口。"""
    rows = []
    def each(hwnd, _):
        title = win32gui.GetWindowText(hwnd)
        vis = win32gui.IsWindowVisible(hwnd)
        if (vis or not visible_only) and (title or not visible_only):
            rows.append({
                "hwnd": int(hwnd),
                "title": title,
                "class": win32gui.GetClassName(hwnd),
                "rect": tuple(map(int, win32gui.GetWindowRect(hwnd))),
                "visible": bool(vis),
            })
        return True
    win32gui.EnumWindows(each, None)
    return rows

def FindWindowMatches(name: str, class_name=None, visible_only: bool = True, limit: int = 8):
    """按标题找窗口，返回**候选列表**（不静默选第一个）。

    排序：**精确同名优先**，其次子串匹配；同组内保持 EnumWindows 的 z-order。
    为什么：标题子串命中多个窗口很常见（"微信" 同时命中主窗口与聊天窗口、同名多开的
    浏览器），旧实现静默取第一个，工具层和模型都无从发现「可能操作错了窗口」。

    返回 `[{hwnd, title, class, exact}]`，找不到返回空列表。
    """
    needle = str(name).lower()
    exact_rows, partial_rows = [], []
    for row in ListWindows(visible_only):
        title = row["title"] or ""
        if class_name is not None and row["class"] != class_name:
            continue
        if title == name:
            exact_rows.append({**row, "exact": True})
        elif needle and needle in title.lower():
            partial_rows.append({**row, "exact": False})
    return (exact_rows + partial_rows)[:limit]

def FindWindow(name: str, exact: bool = False, class_name=None, visible_only: bool = True) -> int:
    """按标题（默认子串、大小写不敏感；**精确同名优先**）或类名找窗口，返回 hwnd。

    找不到抛 RuntimeError。需要知道是否有多候选请用 `FindWindowMatches`
    （工具层靠它把「同名多窗口」告诉模型）。
    """
    rows = FindWindowMatches(name, class_name=class_name, visible_only=visible_only)
    if exact:
        rows = [r for r in rows if r["exact"]]
    if not rows:
        raise RuntimeError(f"window not found: {name!r}")
    return int(rows[0]["hwnd"])

def Foreground():
    """当前前台窗口信息。操作后核对它可发现焦点被抢/丢失。

    注意：前台句柄可能是 0 或已失效（桌面切换、窗口刚关），这时读标题/类名会抛
    pywintypes.error。前台查询是**诊断路径**，它自己不能成为异常源——拿不到就
    返回空字符串（`ForegroundGuard` 靠 hwnd 比较判断失败，不靠标题）。
    """
    hwnd = win32gui.GetForegroundWindow() or 0
    if not hwnd or not win32gui.IsWindow(hwnd):
        return {"hwnd": int(hwnd), "title": "", "class": ""}
    try:
        return {"hwnd": int(hwnd), "title": win32gui.GetWindowText(hwnd), "class": win32gui.GetClassName(hwnd)}
    except Exception:
        return {"hwnd": int(hwnd), "title": "", "class": ""}

# ---------------------------------------------------------------- 前台/坐标

def Activate(hwnd, verify: bool = True):
    """稳定切换前台窗口。绕过 Windows 前台锁限制。

    verify=True 时切换后核对 GetForegroundWindow（Windows 会拒绝后台进程的
    前台请求，也可能被其他窗口抢回）——不一致只**告警**不招错，因为很多场景
    仍可继续操作（例如目标窗口本来就已在前台，只是不是 hwnd）。"""
    if isinstance(hwnd, str):
        hwnd = _resolve_hwnd(hwnd)
    if ctypes.windll.user32.IsIconic(hwnd):          # 最小化先恢复
        ctypes.windll.user32.ShowWindow(hwnd, 9)      # SW_RESTORE
    # 发假 Alt-up 骗过前台锁
    ctypes.windll.user32.keybd_event(0x12, 0, 2, 0)   # VK_MENU up
    time.sleep(0.02)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        ctypes.windll.user32.BringWindowToTop(hwnd)
        ctypes.windll.user32.SetFocus(hwnd)
    time.sleep(0.15)
    if verify:
        fg = win32gui.GetForegroundWindow()
        if fg != hwnd:
            print(f"[Activate] ⚠️ 前台切换未生效：想要 hwnd={hwnd}（{safe_title(hwnd)!r}），"
                  f"实际前台 hwnd={fg}（{safe_title(fg)!r}）——后续键盘/点击可能落到别的窗口")
            return False
    return True

activate = Activate

def ForegroundGuard(hwnd, action="输入"):
    """把目标窗口切到前台并核对；**切不到就返回拒绝报告（不执行任何键鼠注入）**。

    为什么必须拒绝而不是只告警：键盘事件（type_text / Press）走的是「当前前台窗口」，
    Activate 被 Windows 前台锁拒绝或被其他窗口抢回时，文本会粘进用户正在写的文档，
    Ctrl+W / Alt+F4 这类快捷键会作用在别的应用上。鼠标点击有 WindowFromPoint 守卫，
    键盘没有等价兜底，所以在这里补上。返回 None = 已在前台，可以继续。
    """
    if isinstance(hwnd, str):
        hwnd = _resolve_hwnd(hwnd)
    Activate(hwnd)
    fg = Foreground()
    if fg["hwnd"] == hwnd:
        return None
    advice = (
        f"**未{action}**：目标窗口 hwnd={hwnd}（{safe_title(hwnd)!r}）没能切到前台，"
        f"当前前台是 hwnd={fg['hwnd']}（{fg['title']!r}）——继续输入/按键会落到这个窗口里。"
        f"先把目标窗口点一下切到前台再试，或重新 computer_windows 核对 hwnd/标题。"
    )
    print(f"[Guard] refused_foreground | 未{action}：前台是 hwnd={fg['hwnd']}（{fg['title']!r}），"
          f"目标 hwnd={hwnd}（{safe_title(hwnd)!r}）")
    print(f"[Guard] 建议：{advice}")
    return {
        "ok": False,
        "refused": True,
        "error": advice,
        "verdict": "refused_foreground",
        "advice": advice,
        "title": safe_title(hwnd),
        "fg_hwnd": int(fg["hwnd"]),
        "fg_title": fg["title"],
    }

def safe_title(hwnd) -> str:
    """标题读取不怕失效句柄（枚举结果可能已过去几百毫秒）。"""
    try:
        return win32gui.GetWindowText(int(hwnd))
    except Exception:
        return ""

def RootWindow(hwnd) -> int:
    """取顶层窗口句柄（GA_ROOT=2）。命中校验用：WindowFromPoint 返回的是最深的
    子窗口/控件句柄，必须升到根窗口才能与 ListWindows 的 hwnd 比较。"""
    try:
        return int(win32gui.GetAncestor(int(hwnd), 2) or hwnd)
    except Exception:
        return int(hwnd)

def WindowAt(x, y) -> int:
    """屏幕物理坐标 (x, y) 处**最顶层**的窗口（根窗口）。返回 0 表示无窗口/桌面。"""
    try:
        h = win32gui.WindowFromPoint((int(x), int(y)))
    except Exception:
        return 0
    return RootWindow(h) if h else 0

def WindowPid(hwnd) -> int:
    """窗口所属进程 id（0 表示取不到）。用来识别「同一个应用的弹出层」。"""
    try:
        return int(win32process.GetWindowThreadProcessId(int(hwnd))[1])
    except Exception:
        return 0

def SameApp(a, b) -> bool:
    """两个窗口句柄是否属于同一个进程。

    为什么需要它：下拉菜单、弹出对话框、tooltip、右键菜单都是**独立顶层窗口**，
    它们不属于目标 hwnd，但点击它们仍是这个应用的正当操作——命中校验必须放行
    同进程窗口，否则会把「点自己应用的菜单」误判成「点到别的应用」。
    """
    if not a or not b:
        return False
    if a == b:
        return True
    pa, pb = WindowPid(a), WindowPid(b)
    return bool(pa) and pa == pb

def ClientOrigin(hwnd_or_name):
    """客户区原点的屏幕坐标（DPI-aware 进程 → 物理像素）。"""
    return tuple(map(int, win32gui.ClientToScreen(_resolve_hwnd(hwnd_or_name), (0, 0))))

def ClientSize(hwnd_or_name):
    left, top, right, bottom = win32gui.GetClientRect(_resolve_hwnd(hwnd_or_name))
    return int(right - left), int(bottom - top)

def ClientRectScreen(hwnd_or_name):
    """客户区的屏幕物理矩形 (l, t, r, b)。截图内坐标 → 屏幕坐标一律以此原点换算。"""
    x, y = ClientOrigin(hwnd_or_name)
    w, h = ClientSize(hwnd_or_name)
    return x, y, x + w, y + h

# ---------------------------------------------------------------- 截图

# ---------------------------------------------------------------- 截图

def _grab_screen(bbox=None):
    """屏幕抓图（物理像素坐标）。

    `all_screens=True`：Pillow 在 Windows 上默认只抓主显示器，坐标超出主屏（副屏、
    或虚拟桌面原点为负）时会拿到错位像素；实测本机单屏下两者逐像素相同（无回归），
    所以这里总是开——它让多屏环境不易静默取错区域。
    """
    if ImageGrab is None:
        raise RuntimeError("Pillow 未安装: pip install pillow")
    if bbox is None:
        return ImageGrab.grab(all_screens=True)
    return ImageGrab.grab(tuple(int(v) for v in bbox), all_screens=True)

def GrabWindow(hwnd):
    """前台客户区截图（先 Activate，约 0.4s）。传 hwnd(int) 或窗口标题(str)。

    只截客户区（不含标题栏边框），截图内坐标用 ClientOrigin 换算屏幕物理坐标。
    返回的 PIL Image 在 `img.info` 里带截图现场信息（工具层靠它做回执校验）：
    `cu_fg_ok`（截图时前台是否就是目标窗口）/ `cu_fg_hwnd` / `cu_fg_title` /
    `cu_client_origin` / `cu_client_size`。

    **为什么必须校验前台**：本函数只截「目标客户区那块屏幕区域」，它不知道屏幕
    上盖着谁——目标窗口没抢到前台时（Activate 被前台锁拒绝、被其他窗口抢回），
    拿到的就是**别的窗口的画面**而且什么都不报错。实测：目标矩形被别的窗口覆盖时
    对该矩形的 ImageGrab 返回遮挡窗口的像素。所以前台不一致时打印警告并在 info
    里标记 `cu_fg_ok=False`，让调用方（或模型）知道这张图不可信。
    """
    if ImageGrab is None:
        raise RuntimeError("Pillow 未安装: pip install pillow")
    hwnd = _resolve_hwnd(hwnd)
    Activate(hwnd)
    time.sleep(0.25)
    left, top = win32gui.ClientToScreen(hwnd, (0, 0))
    cr = win32gui.GetClientRect(hwnd)  # (0, 0, w, h)
    bbox = (left, top, left + cr[2], top + cr[3])
    fg = win32gui.GetForegroundWindow()
    fg_ok = fg == hwnd
    if not fg_ok:
        print(f"[GrabWindow] ⚠️ 截图时前台不是目标窗口：想要 hwnd={hwnd}（{safe_title(hwnd)!r}），"
              f"实际前台 hwnd={fg}（{safe_title(fg)!r}）——这张图可能不是你想要的，"
              f"先核对窗口标题或重新 Activate 后再截")
    img = _grab_screen(bbox)
    img.info.update({
        "cu_hwnd": hwnd,
        "cu_title": safe_title(hwnd),
        "cu_fg_hwnd": int(fg),
        "cu_fg_title": safe_title(fg),
        "cu_fg_ok": fg_ok,
        "cu_client_origin": (int(left), int(top)),  # 注意：物理像素，尚未做 dpi 处理
        "cu_client_size": (int(cr[2]), int(cr[3])),
        "cu_bbox": tuple(int(v) for v in bbox),
    })
    return img


def _grab_printwindow(hwnd, size, flags=PW_CLIENTONLY | PW_RENDERFULLCONTENT):
    """PrintWindow 截到 (w, h) 位图。

    flags 默认 3 = PW_CLIENTONLY(1) | PW_RENDERFULLCONTENT(2)：
    - **只给 PW_CLIENTONLY(1) 时，DWM 合成窗口（Chromium/Electron/浏览器/UWP）
      会返回全黑帧**，而 PrintWindow 照样返回 1——「ret 真」不能当成功判据。
    - PW_RENDERFULLCONTENT 让它去拿 DWM 合成结果，实测 Electron/Chromium/Qt/Tk/
      终端类窗口都能截到真实内容。
    - 位图从**客户区左上角**开始（不是窗口左上角）；传客户区尺寸即可直接得到
      客户区图像，不要按 GetWindowRect 的偏移去裁（实测那样裁会整体错位）。
    返回 (ok, image)：ok 只表示调用没抛异常，**全黑帧也算 ok**，调用方要自己看内容。
    """
    import win32ui
    w, h = size
    hdc = win32gui.GetWindowDC(hwnd)
    src = win32ui.CreateDCFromHandle(hdc)
    mem = src.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    bmp.CreateCompatibleBitmap(src, w, h)
    old = mem.SelectObject(bmp)
    try:
        ok = bool(ctypes.windll.user32.PrintWindow(hwnd, mem.GetSafeHdc(), flags))
        info, bits = bmp.GetInfo(), bmp.GetBitmapBits(True)
        image = Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]), bits, "raw", "BGRX", 0, 1).copy()
        return image, ok
    finally:
        mem.SelectObject(old)
        win32gui.DeleteObject(bmp.GetHandle())
        mem.DeleteDC()
        src.DeleteDC()
        win32gui.ReleaseDC(hwnd, hdc)

def GrabWindowBg(hwnd_or_name, flags=PW_CLIENTONLY | PW_RENDERFULLCONTENT):
    """后台客户区截图（PrintWindow，不激活窗口、不动鼠标）。

    默认 flags=3（含 PW_RENDERFULLCONTENT），DWM 合成窗口（Chromium/Electron/
    浏览器/UWP）同样能截到内容——**「截黑」不是窗口类别的宿命，而是 flags 用错**
    （历史版本的避坑清单写反了：只给 PW_CLIENTONLY 时 Chromium/Electron 才全黑，
    而那时原生窗口恰好正常，于是被误记成「Electron 必须前台截」）。
    真的拿到全黑帧时才是该窗口不支持后台截图：改用 GrabWindow（前台）。
    返回 PIL Image（`img.info['cu_bg']=True`）。
    """
    hwnd = _resolve_hwnd(hwnd_or_name)
    w, h = ClientSize(hwnd)
    if min(w, h) <= 0:
        raise RuntimeError(f"empty client area for hwnd={hwnd}")
    image, ok = _grab_printwindow(hwnd, (w, h), flags)
    if not ok:
        raise RuntimeError("PrintWindow failed（目标窗口可能不支持后台截图，改用 GrabWindow）")
    image.info.update({"cu_hwnd": hwnd, "cu_title": safe_title(hwnd), "cu_bg": True, "cu_client_size": (w, h)})
    return image

grab_window_bg = GrabWindowBg

# 后台帧「空白」判定：DWM 合成窗口在 flags 用错时会返回全黑帧且 PrintWindow 仍返回 1，
# 所以不能让返回值当成功判据；这里再看内容有没有灰度层次（真实 UI 至少有一两个灰度值）。
BG_BLANK_MAX_LEVEL = 2

def _is_blank(img) -> bool:
    """全黑/近全黑帧（后台截图不受支持或内容尚未渲染）。"""
    try:
        return int(img.convert("L").getextrema()[1]) <= BG_BLANK_MAX_LEVEL
    except Exception:
        return False

def _crop(img, box):
    """按 (l, t, r, b) 裁剪，越界自动收进图像内；无效区域返回 None。"""
    if img is None or box is None:
        return None
    left, top, right, bottom = (int(v) for v in box)
    left, top = max(0, left), max(0, top)
    right, bottom = min(img.size[0], right), min(img.size[1], bottom)
    if right <= left or bottom <= top:
        return None
    return img.crop((left, top, right, bottom))

def _crop_screen(img, box):
    """按**屏幕物理坐标**裁剪全屏抓图（自动扣掉多屏虚拟桌面原点）。"""
    if img is None or box is None:
        return None
    vx, vy = _virtual_origin()
    left, top, right, bottom = box
    return _crop(img, (left - vx, top - vy, right - vx, bottom - vy))

def _client_rect(hwnd):
    """客户区屏幕矩形；窗口最小化/尺寸为 0 时返回 None。"""
    if hwnd is None:
        return None
    try:
        w, h = ClientSize(hwnd)
        if min(w, h) <= 0:
            return None
        left, top = ClientOrigin(hwnd)
        return (left, top, left + w, top + h)
    except Exception:
        return None

def _client_grab_bg(hwnd):
    """当前后台渲染帧（PrintWindow）。不受遮挡影响，用于变化判定的复核。

    失败 / 全黑 / 最小化时返回 None——调用方据此退回屏幕读数，绝不能把 None 当
    「没有变化」。
    """
    if hwnd is None:
        return None
    try:
        w, h = ClientSize(hwnd)
        if min(w, h) <= 0:
            return None
        image, ok = _grab_printwindow(hwnd, (w, h))
        if not ok or _is_blank(image):
            return None
        return image
    except Exception:
        return None

def IsMinimized(hwnd) -> bool:
    """窗口是否最小化（最小化窗口的客户区尺寸是 0，截图前得先恢复）。"""
    try:
        return bool(ctypes.windll.user32.IsIconic(int(hwnd)))
    except Exception:
        return False

def GrabWindowBest(hwnd_or_name):
    """截图首选入口：**后台优先**（不激活、不抢焦点、不受遮挡），必要时回退前台。

    为什么默认后台：前台截图（GrabWindow）截的是「目标客户区那块屏幕区域」，
    它不知道屏幕上盖着谁——被遮挡时拿到的是遮挡窗口的画面，而且每次都要抢焦点
    （本机实测 461ms vs 32ms）。PrintWindow 拿的是窗口自己的渲染结果，遮挡无关。

    回退条件：PrintWindow 抛错、返回全黑帧（该窗口不支持后台截图）、或窗口最小化
    （最小化时客户区尺寸为 0，先 SW_RESTORE；恢复后仍按后台截，尽量不抢焦点）。

    img.info：`cu_mode` = 'background' | 'foreground'，`cu_restored` = 是否从最小化恢复。
    """
    hwnd = _resolve_hwnd(hwnd_or_name)
    restored = False
    if IsMinimized(hwnd):
        ctypes.windll.user32.ShowWindow(hwnd, 9)   # SW_RESTORE
        restored = True
        time.sleep(0.2)                            # 等窗口真正画出内容
    try:
        image = GrabWindowBg(hwnd)
        if _is_blank(image):
            raise RuntimeError("background frame is blank")
        image.info.update({"cu_mode": "background", "cu_restored": restored, "cu_fg_ok": True})
        return image
    except Exception:
        image = GrabWindow(hwnd)
        image.info.update({"cu_mode": "foreground", "cu_restored": restored})
        return image

def ScreenCapAt(x, y, r=100):
    """以物理坐标 (x, y) 为中心 ±r 的屏幕截图 → PIL Image。"""
    return _grab_screen((int(x - r), int(y - r), int(x + r), int(y + r)))

# ---------------------------------------------------------------- 鼠标

def MouseDown():
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0)

def MouseUp():
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0)

def MouseClick(staytime=0.05):
    MouseDown(); time.sleep(staytime)
    MouseUp(); time.sleep(0.05)

def MouseDClick(staytime=0.05):
    MouseDown(); MouseUp()
    MouseDown(); MouseUp()
    time.sleep(0.05)

def SetCursorPos(z):
    """移动鼠标到物理坐标 z=(x, y)。"""
    win32api.SetCursorPos(tuple(int(v) for v in z))
    time.sleep(0.05)

def _pixels_changed(im1, im2) -> bool:
    if im1.size != im2.size:
        return True
    return ImageChops.difference(im1, im2).getbbox() is not None

# 客户区变化判定阈值：见 Click docstring（本机连续两帧基噪 ~0.0001，取 10× 余量）。
CLICK_CHANGE_RATIO = 0.001

# 点击后的等待策略：旧实现固定 sleep 0.5s（每次点击都付），改为轮询——大多数重绘
# 一两帧就能看到；真的没有视觉回馈的控件仍走满预算（结论不变，只是那一类慢一点）。
CLICK_SETTLE_MS = 500
CLICK_POLL_MS = 40
CLICK_FIRST_DELAY_MS = 60

def _diff_ratio(im1, im2) -> float:
    """0~1：两图逐像素（灰阶）不同像素占比。用来区分「真的重绘」与「截图噪声」。"""
    if im1.size != im2.size:
        return 1.0
    a, b = im1.convert("L"), im2.convert("L")
    total = a.size[0] * a.size[1]
    if total == 0:
        return 0.0
    # 差图直方图的 0 号桶 = 相同像素数
    same = ImageChops.difference(a, b).histogram()[0]
    return 1.0 - same / total

def _client_grab(hwnd):
    """当前屏幕上的目标客户区图像（不激活，纯读数）。

    注意：这仍然是「屏幕读数」，受遮挡影响——所以 Click 的像素变化项只是**弱信号**，
    真正的强信号是命中校验（落在哪个窗口上）与前台校验（底下露出来的是谁）。
    """
    cr = win32gui.GetClientRect(hwnd)
    if min(cr[2], cr[3]) <= 0:
        return None
    left, top = win32gui.ClientToScreen(hwnd, (0, 0))
    return _grab_screen((int(left), int(top), int(left + cr[2]), int(top + cr[3])))

def Click(x, y=None, check=True, double=False, hwnd=None, guard=True):
    """屏幕物理坐标点击。支持 Click(x, y) 或 Click((x, y))。

    **点击前守卫（guard=True 且给了 hwnd）**：先看这个坐标上真正躺着哪个顶层窗口。
    若不是目标窗口、也不属于目标窗口的同一进程（同进程放行是因为下拉菜单/弹出
    对话框都是独立顶层窗口，属于该应用的正当目标），就**不点下去**，直接返回
    `ok=False, verdict='refused_hit'`。理由：屏幕上这个位置坐的是别的应用，点下去
    就是**在用户的别的窗口里乱点**（实践：坐标越界的 computer_click 曾真的点到
    用户的浏览器）。修好坐标或先把目标窗口调到前台再点。急用时显式 `guard=False`。

    check=True 时做三件套验证并返回**报告 dict**（同时打一行 `[Click check] …`
    方便不接返回值的脚本/工具层收集）：

    1. **命中校验**（强信号）：WindowFromPoint + GA_ROOT 看这个坐标上真正躺着哪个
       顶层窗口，与 hwnd（若给）比对 → `hit_ok`；同时算 `in_client`（客户端坐标
       是否落在目标客户区矩形内），用于区分「坐标算错了」与「被别的窗口盖住了」。

    2. **变化校验**（弱信号）：点前后客户区像素差 → `client_changed` /
       `client_diff_ratio`；再叠加光标处 ±100 局部对比 `roi_changed`。
       `client_changed` 用的阈值是 **diff_ratio > 0.001（千分之一面积）** —— 实测本机
       连续两帧基噪 ~0.0001（Edge 0.00012 / ChatAnyTime 0.000113 / 终端 0），
       阈值留 10× 余量就不会把截图噪声当成点击生效，而真的重绘（如改色板）达
       0.2~0.6。
       **无变化不等于点歪**：静态区域/无回馈控件本身就是无变化；反过来动画/视频/
       闪烁光标会让「有变化」恒真，所以这一项只作参考，不作判据。
    3. **前台校验**（强信号）：`fg_title_after` / `fg_ok`。焦点被其他窗口抢走时
       后续键盘输入会落到别处，这是必须让调用方知道的。

    返回 dict 字段：ok / verdict（changed | refused_hit | warn_static | warn_hit |
    warn_client | warn_foreground）/ advice / error（仅 refused_hit）/ screen /
    hit_hwnd / hit_title / hit_ok / in_client / client_changed / client_diff_ratio /
    roi_changed / fg_before / fg_after / fg_title_after / fg_ok。

    verdict 优先级：命中不在目标窗口（warn_hit）> 点不在客户区内（warn_client）>
    前台被抢（warn_foreground）> 无任何变化（warn_static）> 有变化（changed）。
    `in_client=False` 只能说明「坐标不像这张截图的客户区坐标」，不能否定非客户区
    点击（标题栏/滚动条也是合法目标），所以它只在对不上命中窗口时用作诊断信息。
    """
    if y is None:
        x, y = int(x[0]), int(x[1])
    x, y = int(x), int(y)
    hwnd = _resolve_hwnd(hwnd) if hwnd is not None else None
    if hwnd is not None:
        ox, oy = win32gui.ClientToScreen(hwnd, (0, 0))
        cw, ch = ClientSize(hwnd)
        in_client = ox <= x < ox + cw and oy <= y < oy + ch
    else:
        ox = oy = None
        in_client = None

    hit = WindowAt(x, y)
    before = after = None
    fg_before = fg_after = None
    if hwnd is not None and guard and not SameApp(hit, hwnd):
        advice = (f"**未点击**：坐标 ({x}, {y}) 上的顶层窗口是 hwnd={hit}（{safe_title(hit)!r}），"
                  f"既不是目标 hwnd={hwnd}（{safe_title(hwnd)!r}）也不属于它的进程——"
                  f"点下去就是在别的窗口里乱点。先重新 computer_screenshot 核对坐标，"
                  f"或先把目标窗口调到前台；确认无误可用 guard=False 强制点击。")
        print(f"[Click check] refused_hit | 未点击：该坐标上是 hwnd={hit}（{safe_title(hit)!r}），"
              f"目标 hwnd={hwnd}（{safe_title(hwnd)!r}）")
        print(f"[Click check] 建议：{advice}")
        return {
            "ok": False,
            "refused": True,
            "error": advice,
            "verdict": "refused_hit",
            "advice": advice,
            "screen": [x, y],
            "hit_hwnd": hit,
            "hit_title": safe_title(hit),
            "hit_ok": False,
            "in_client": in_client,
        }
    if check:
        # 一次全屏抓图，客户区与光标邻域都从这一张裁（旧实现为这两处各抓两次屏幕）。
        before = _grab_screen()
        fg_before = win32gui.GetForegroundWindow()
        client_rect = _client_rect(hwnd) if hwnd is not None else None
        client_before = _crop_screen(before, client_rect) if client_rect else None
        roi_before = _crop_screen(before, (x - 100, y - 100, x + 100, y + 100))
        bg_before = _client_grab_bg(hwnd) if hwnd is not None else None
    SetCursorPos((x, y))
    if double:
        MouseDClick()
    else:
        MouseClick()
    if not check:
        # 不验证时保持旧行为：仍回一份点击后局部切图（部分历史脚本拿它存图）
        return ScreenCapAt(x, y)
    time.sleep(CLICK_FIRST_DELAY_MS / 1000)

    fg_after = win32gui.GetForegroundWindow()
    fg_title_after = safe_title(fg_after)
    hit_title = safe_title(hit) if hit else ""
    hit_ok = (hwnd is None) or (hit == hwnd)

    # 变化探测：先轮询屏幕（便宜，常见情况首帧就有变化），没看到再用后台渲染帧复核。
    # 屏幕读数会被遮挡影响（实测同一次重绘：被遮住时只测出 1.3%，后台帧 81%），
    # 所以「无变化」这个结论必须由后台帧确认，否则会把「已生效」误报成「没反应」。
    screen_ratio = None
    after = None
    deadline = time.monotonic() + CLICK_SETTLE_MS / 1000
    while True:
        after = _grab_screen()
        if client_before is not None:
            after_client = _crop_screen(after, _client_rect(hwnd))
            if after_client is not None and after_client.size == client_before.size:
                screen_ratio = _diff_ratio(client_before, after_client)
                if screen_ratio > CLICK_CHANGE_RATIO:
                    break
        if time.monotonic() >= deadline:
            break
        time.sleep(CLICK_POLL_MS / 1000)

    roi_after = _crop_screen(after, (x - 100, y - 100, x + 100, y + 100)) if after is not None else None
    try:
        roi_changed = _pixels_changed(roi_before, roi_after) if roi_before is not None and roi_after is not None else None
    except Exception:
        roi_changed = None

    client_changed = None
    client_diff_ratio = None
    change_source = None
    if client_before is not None:
        if screen_ratio is not None and screen_ratio > CLICK_CHANGE_RATIO:
            client_changed, client_diff_ratio, change_source = True, screen_ratio, "screen"
        else:
            bg_after = _client_grab_bg(hwnd)
            bg_ratio = None
            if bg_before is not None and bg_after is not None and bg_after.size == bg_before.size:
                bg_ratio = _diff_ratio(bg_before, bg_after)
            if bg_ratio is not None and bg_ratio > CLICK_CHANGE_RATIO:
                client_changed, client_diff_ratio, change_source = True, bg_ratio, "printwindow"
            else:
                client_changed = False
                client_diff_ratio = screen_ratio
    fg_ok = hwnd is None or fg_after == hwnd

    if not hit_ok:
        verdict = "warn_hit"
        same_app = SameApp(hit, hwnd)
        advice = (f"点击坐标上的顶层窗口是 hwnd={hit}（{hit_title!r}），不是目标 "
                  f"hwnd={hwnd}（{safe_title(hwnd)!r}）：坐标算错了或被其他窗口遮住，"
                  f"重新截图核对（ListWindows 看 hwnd/标题，别猜）。")
        if same_app:
            advice += " 不过它属于目标窗口的同一进程（弹出层/对话框/菜单），通常是正常操作。"
        elif in_client:
            advice += " 该点确实在目标客户区矩形内，那就是被遮挡——先把目标窗口调到前台再点。"
    elif in_client is False:
        verdict = "warn_client"
        advice = (f"点击落在了目标窗口上，但屏幕点 ({x}, {y}) **不在它的客户区内**"
                  f"（客户区原点 ({ox}, {oy})，尺寸 {ClientSize(hwnd)}）——说明传进来的 x/y "
                  f"不是这张截图的客户区坐标（可能把屏幕坐标、窗口含边框坐标或旧截图的"
                  f"坐标混了）。重新 computer_screenshot 一张，用那张图的坐标系重新算。")
    elif not fg_ok:
        verdict = "warn_foreground"
        advice = (f"点击落到了目标窗口上，但前台是 hwnd={fg_after}（{fg_title_after!r}）："
                  f"后续键盘输入会落到这个窗口，需要键盘时先 Activate 目标窗口。")
    elif client_changed is False and roi_changed is False:
        verdict = "warn_static"
        advice = ("点击后屏幕与后台渲染对比都没有变化——这可能**正常**（静态区域/无视觉"
                  "回馈的控件），也可能点歪。判断依据优先看回执里的命中窗口与前台；需要"
                  "确认效果就重新截图看界面状态（例如文本是否出现、选中态是否变化），或在"
                  "目标控件上用 UIA/OCR 重新定位。**不要盲目重复点击。**")
    elif client_changed is False:
        verdict = "changed"
        advice = ("光标局部有变化，但目标客户区整体无变化——若预期点完后界面应有变化，"
                  "建议截图确认；否则忽略。")
    elif change_source == "printwindow":
        verdict = "changed"
        advice = ("屏幕像素对比没有发现变化，但后台渲染帧确认界面已经改变（目标窗口可能被"
                  "遮挡或没有重绘到屏幕上）——看起来生效了；关键动作仍建议重新截图确认。")
    else:
        verdict = "changed"
        advice = "点击落到了目标窗口且界面有重绘，看起来生效了；关键动作仍建议截图确认。"

    report = {
        "ok": True,
        "double": bool(double),
        "screen": [x, y],
        "verdict": verdict,
        "advice": advice,
        "hit_hwnd": hit,
        "hit_title": hit_title,
        "hit_ok": bool(hit_ok),
        "in_client": in_client,
        "client_changed": client_changed,
        "client_diff_ratio": round(client_diff_ratio, 4) if client_diff_ratio is not None else None,
        "client_change_source": change_source,
        "roi_changed": roi_changed,
        "fg_before": int(fg_before) if fg_before else 0,
        "fg_after": int(fg_after),
        "fg_title_after": fg_title_after,
        "fg_ok": bool(fg_ok),
    }
    bits = [f"命中 {'✓' if hit_ok else '⚠️ ' + str(hit_title)!r}",
            f"客户区 {'✓' if in_client in (True, None) else '⚠️ 点不在客户区内'}",
            f"变化 {'有' if client_changed else '无' if client_changed is not None else '未测'}"
            f"(整体 {client_diff_ratio if client_diff_ratio is not None else '?'})"
            f"/{'有' if roi_changed else '无' if roi_changed is not None else '未测'}(局部)",
            f"fg: {fg_title_after!r}{'' if fg_ok else ' ⚠️ CHANGED'}"]
    print(f"[Click check] {verdict} | " + " | ".join(bits))
    if verdict != "changed":
        print(f"[Click check] 建议：{advice}")
    return report

click = Click

# ---------------------------------------------------------------- 键盘

VK_CODE = {'backspace': 0x08, 'tab': 0x09, 'clear': 0x0C, 'enter': 0x0D, 'shift': 0x10, 'ctrl': 0x11, 'alt': 0x12, 'pause': 0x13, 'caps_lock': 0x14, 'esc': 0x1B, 'escape': 0x1B, 'space': 0x20, 'page_up': 0x21, 'page_down': 0x22, 'end': 0x23, 'home': 0x24, 'left_arrow': 0x25, 'up_arrow': 0x26, 'right_arrow': 0x27, 'down_arrow': 0x28, 'select': 0x29, 'print': 0x2A, 'execute': 0x2B, 'print_screen': 0x2C, 'ins': 0x2D, 'del': 0x2E, 'help': 0x2F, '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34, '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39, 'a': 0x41, 'b': 0x42, 'c': 0x43, 'd': 0x44, 'e': 0x45, 'f': 0x46, 'g': 0x47, 'h': 0x48, 'i': 0x49, 'j': 0x4A, 'k': 0x4B, 'l': 0x4C, 'm': 0x4D, 'n': 0x4E, 'o': 0x4F, 'p': 0x50, 'q': 0x51, 'r': 0x52, 's': 0x53, 't': 0x54, 'u': 0x55, 'v': 0x56, 'w': 0x57, 'x': 0x58, 'y': 0x59, 'z': 0x5A, 'numpad_0': 0x60, 'numpad_1': 0x61, 'numpad_2': 0x62, 'numpad_3': 0x63, 'numpad_4': 0x64, 'numpad_5': 0x65, 'numpad_6': 0x66, 'numpad_7': 0x67, 'numpad_8': 0x68, 'numpad_9': 0x69, 'multiply_key': 0x6A, 'add_key': 0x6B, 'separator_key': 0x6C, 'subtract_key': 0x6D, 'decimal_key': 0x6E, 'divide_key': 0x6F, 'F1': 0x70, 'F2': 0x71, 'F3': 0x72, 'F4': 0x73, 'F5': 0x74, 'F6': 0x75, 'F7': 0x76, 'F8': 0x77, 'F9': 0x78, 'F10': 0x79, 'F11': 0x7A, 'F12': 0x7B, 'num_lock': 0x90, 'scroll_lock': 0x91, 'left_shift': 0xA0, 'right_shift': 0xA1, 'left_control': 0xA2, 'right_control': 0xA3, 'left_menu': 0xA4, 'right_menu': 0xA5, 'browser_back': 0xA6, 'browser_forward': 0xA7, 'browser_refresh': 0xA8, 'browser_stop': 0xA9, 'browser_search': 0xAA, 'browser_favorites': 0xAB, 'browser_start_and_home': 0xAC, 'volume_mute': 0xAD, 'volume_down': 0xAE, 'volume_up': 0xAF, 'next_track': 0xB0, 'previous_track': 0xB1, 'stop_media': 0xB2, 'play/pause_media': 0xB3, 'start_mail': 0xB4, 'select_media': 0xB5, 'start_application_1': 0xB6, 'start_application_2': 0xB7, '+': 0xBB, ',': 0xBC, '-': 0xBD, '.': 0xBE, '/': 0xBF, '`': 0xC0, ';': 0xBA, '[': 0xDB, '\\': 0xDC, ']': 0xDD, "'": 0xDE}
VK_CODE = {k.lower(): v for k, v in VK_CODE.items()}

# 常见别名：模型会说 'win+r' / 'cmd+c' / 'return' / 'delete'，而 VK 表里只有
# 'left_menu' / 'enter' / 'del' 这类 Win32 叫法。不给别名的话模型只能拿到
# `KeyError: 'win'`，既没提示也不知道该改成什么。
VK_ALIASES = {
    "win": 0x5B, "windows": 0x5B, "meta": 0x5B, "cmd": 0x5B, "command": 0x5B,
    "return": 0x0D, "delete": 0x2E, "pageup": 0x21, "pagedown": 0x22,
    "arrowleft": 0x25, "arrowup": 0x26, "arrowright": 0x27, "arrowdown": 0x28,
    "control": 0x11, "option": 0x12,
}
VK_CODE.update(VK_ALIASES)

def Press(cmd, staytime=0):
    """组合键，如 Press('ctrl+v') / Press('enter') / Press(['ctrl', 'shift', 't'])。"""
    if type(cmd) is list:
        cmds = [str(x).lower() for x in cmd]
    else:
        cmds = cmd.lower().split('+')
    unknown = [z for z in cmds if z not in VK_CODE]
    if unknown:
        raise RuntimeError(
            "unknown key name: %s（可用：字母/数字、enter、esc、tab、space、backspace、"
            "delete、方向键 up_arrow/down_arrow/left_arrow/right_arrow、home、end、"
            "page_up、page_down、F1–F12、ctrl、shift、alt、win；组合键写法如 'ctrl+shift+t'）"
            % ", ".join(repr(z) for z in unknown)
        )
    for z in cmds:
        win32api.keybd_event(VK_CODE[z], 0, 0, 0)
        time.sleep(staytime)
    for z in reversed(cmds):
        time.sleep(staytime)
        win32api.keybd_event(VK_CODE[z], 0, win32con.KEYEVENTF_KEYUP, 0)

press = Press

# ---------------------------------------------------------------- 剪贴板/文本输入

def _open_clipboard(retries: int = 6, delay: float = 0.1):
    """剪贴板是全局互斥资源，其他进程（剪贴板管理器等）短暂占用很常见，重试拿锁。"""
    last = None
    for _ in range(retries):
        try:
            win32clipboard.OpenClipboard()
            return
        except Exception as exc:  # pywintypes.error: 拒绝访问
            last = exc
            time.sleep(delay)
    raise RuntimeError(f"剪贴板被其他进程占用，多次重试失败: {last!r}")

def SetClipboardText(text):
    """写入系统剪贴板（Unicode 文本）。type_text 依赖它。"""
    _open_clipboard()
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, str(text))
    finally:
        win32clipboard.CloseClipboard()

def GetClipboardText():
    _open_clipboard()
    try:
        return win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT) or ""
    finally:
        win32clipboard.CloseClipboard()

def TryGetClipboardText(default=None):
    """读剪贴板文本；**剪贴板里是图片/文件等非文本时返回 default，不抛异常**。

    为什么需要它：用户刚截过图或复制过图片时剪贴板里没有 CF_UNICODETEXT，
    `GetClipboardData` 会直接抛 `TypeError: Specified clipboard format is not available`。
    `type_text` 的“先备份剪贴板”步骤在这种情况下会把整个输入操作弄失败——
    备份是增强，不该当先决条件。
    """
    try:
        if not win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
            return default
        return GetClipboardText()
    except Exception:
        return default

def type_text(text):
    """向当前前台焦点输入文本：剪贴板 + ctrl+v（先点击目标输入框）。
    会覆盖用户剪贴板内容——执行前如有需要先 GetClipboardText 备份。"""
    SetClipboardText(text)
    time.sleep(0.05)
    Press('ctrl+v')

# ---------------------------------------------------------------- 自检

def RunSelfCheck():
    """轻量自检：依赖 + 坐标体系 + 前后台截图一致性（不点鼠标、不动其他窗口）。
    完整自检见本目录 test/selfcheck.py。"""
    print(f"physical: {swidth}x{sheight} | logical: {cwidth}x{cheight} | dpi_scale: {dpi_scale}")
    print(f"foreground: {Foreground()}")
    rows = ListWindows()
    print(f"visible windows: {len(rows)}")
    for row in rows[:10]:
        print(f"  hwnd={row['hwnd']:<8} class={row['class'][:24]:<24} title={row['title'][:40]}")
    # 前台截图 vs 后台截图（同一窗口）——后台截图应等同于前台内容，
    # 否则就是该窗口不支持 PrintWindow（全黑）或自检环境异常。
    fg = Foreground()
    if fg["hwnd"] and Image is not None:
        try:
            front = GrabWindow(fg["hwnd"])
            back = GrabWindowBg(fg["hwnd"])
            same = _pixels_changed(front, back)
            print(f"  screenshot: front {front.size} vs back {back.size} -> "
                  f"{'内容一致' if not same else '⚠️ 内容不一致（检查 PrintWindow flags）'}\n"
                  f"  foreground check: cu_fg_ok={front.info.get('cu_fg_ok')} title={front.info.get('cu_title')!r}")
        except Exception as exc:
            print(f"  screenshot check skipped: {exc!r}")
    print("ljqCtrl ready")


if __name__ == "__main__":
    RunSelfCheck()
