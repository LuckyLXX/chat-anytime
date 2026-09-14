"""
PiDesktop computer-use skill — Windows 窗口探测与控制（最小集）

源自 GenericAgent 项目 memory/ljqCtrl.py 与 memory/ljqCtrlBg.py（MIT License,
Copyright (c) 2025 lsdefine），按 PiDesktop 最小集裁剪：仅保留窗口枚举、
前台/后台截图、鼠标点击、键盘输入、剪贴板输入，去除 numpy/cv2/windows-capture
依赖（点击验证改用 PIL ImageChops，后台截图走 PrintWindow）。

依赖: pip install pywin32 pillow
CRITICAL: 严禁在此工具链中 import pyautogui（会污染 win32api 导致逻辑冲突）。

Quick Reference:
- dpi_scale: float（逻辑 = 物理 × dpi_scale；100% 缩放 = 1.0）
- ListWindows(visible_only=True) -> [{hwnd,title,class,rect,visible}]
- FindWindow(name, exact=False, class_name=None) -> hwnd
- Foreground() -> {hwnd,title,class}（当前前台窗口）
- Activate(hwnd): 稳定切换前台（先恢复最小化，假 Alt 键骗过前台锁）
- GrabWindow(hwnd_or_title) -> PIL Image（前台客户区截图，自动 Activate）
- GrabWindowBg(hwnd_or_title, timeout=3) -> PIL Image（PrintWindow 后台截图，
  不激活窗口、不动鼠标，best-effort：GPU 合成内容可能截黑，截黑就改用 GrabWindow）
- ClientOrigin(hwnd_or_title) -> (x, y)（客户区原点的屏幕物理坐标）
- Click(x, y, check=True): 物理坐标点击；check=True 自动比对前后像素变化并
  报告前台窗口变化，0% 变化说明点歪，必须停下诊断
- Press(cmd): 组合键（如 'ctrl+v'、'alt+tab'、'enter'）
- SetClipboardText(text) / type_text(text): 剪贴板 + ctrl+v 输入文本
- ScreenCapAt(x, y, r=100) -> PIL Image（物理坐标周边截图）
"""
import ctypes
import time

import win32api
import win32clipboard
import win32con
import win32gui

dpi_scale = 1

try:
    from PIL import Image, ImageChops, ImageGrab
except ImportError:
    Image = ImageChops = ImageGrab = None  # type: ignore[assignment]

ctypes.windll.user32.SetProcessDPIAware()

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

def FindWindow(name: str, exact: bool = False, class_name=None, visible_only: bool = True) -> int:
    """按标题（默认子串、大小写不敏感）或类名找窗口，返回 hwnd。找不到抛 RuntimeError。"""
    needle = str(name).lower()
    for row in ListWindows(visible_only):
        title = row["title"] or ""
        ok = (title == name) if exact else (needle in title.lower())
        if ok and (class_name is None or row["class"] == class_name):
            return int(row["hwnd"])
    raise RuntimeError(f"window not found: {name!r}")

def Foreground():
    """当前前台窗口信息。操作后核对它可发现焦点被抢/丢失。"""
    hwnd = win32gui.GetForegroundWindow()
    return {"hwnd": int(hwnd), "title": win32gui.GetWindowText(hwnd), "class": win32gui.GetClassName(hwnd)}

# ---------------------------------------------------------------- 前台/坐标

def Activate(hwnd):
    """稳定切换前台窗口。绕过 Windows 前台锁限制。"""
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

activate = Activate

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

def GrabWindow(hwnd):
    """前台客户区截图（先 Activate，约 0.4s）。传 hwnd(int) 或窗口标题(str)。
    只截客户区（不含标题栏边框），截图内坐标用 ClientOrigin 换算屏幕物理坐标。"""
    if ImageGrab is None:
        raise RuntimeError("Pillow 未安装: pip install pillow")
    hwnd = _resolve_hwnd(hwnd)
    Activate(hwnd)
    time.sleep(0.25)
    left, top = win32gui.ClientToScreen(hwnd, (0, 0))
    cr = win32gui.GetClientRect(hwnd)  # (0, 0, w, h)
    bbox = (left, top, left + cr[2], top + cr[3])
    bbox = tuple(int(v / dpi_scale) for v in bbox)
    return ImageGrab.grab(bbox)

def _grab_printwindow(hwnd, size):
    import win32ui
    w, h = size
    hdc = win32gui.GetWindowDC(hwnd)
    src = win32ui.CreateDCFromHandle(hdc)
    mem = src.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    bmp.CreateCompatibleBitmap(src, w, h)
    old = mem.SelectObject(bmp)
    try:
        ok = bool(ctypes.windll.user32.PrintWindow(hwnd, mem.GetSafeHdc(), 1))  # PW_CLIENTONLY
        info, bits = bmp.GetInfo(), bmp.GetBitmapBits(True)
        image = Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]), bits, "raw", "BGRX", 0, 1).copy()
        return image, ok
    finally:
        mem.SelectObject(old)
        win32gui.DeleteObject(bmp.GetHandle())
        mem.DeleteDC()
        src.DeleteDC()
        win32gui.ReleaseDC(hwnd, hdc)

def GrabWindowBg(hwnd_or_name, timeout: float = 3.0):
    """后台客户区截图（PrintWindow，不激活窗口、不动鼠标）。
    best-effort：GPU 合成内容（Electron/Chromium/游戏）可能截黑或残缺——
    截黑说明该窗口不支持，改用 GrabWindow（前台）。返回 PIL Image。"""
    hwnd = _resolve_hwnd(hwnd_or_name)
    w, h = ClientSize(hwnd)
    if min(w, h) <= 0:
        raise RuntimeError(f"empty client area for hwnd={hwnd}")
    image, ok = _grab_printwindow(hwnd, (w, h))
    if not ok:
        raise RuntimeError("PrintWindow failed（目标窗口可能不支持后台截图，改用 GrabWindow）")
    return image

grab_window_bg = GrabWindowBg

def ScreenCapAt(x, y, r=100):
    """以物理坐标 (x, y) 为中心 ±r 的屏幕截图 → PIL Image。"""
    return ImageGrab.grab((int(x - r), int(y - r), int(x + r), int(y + r)))

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

def Click(x, y=None, check=True):
    """物理坐标点击。支持 Click(x, y) 或 Click((x, y))。
    check=True：比对点击前后该点周边像素变化 + 前台窗口变化并打印报告。
    无变化（点歪）必须停下诊断坐标换算，禁止盲目重试。"""
    if y is None:
        x, y = int(x[0]), int(x[1])
    x, y = int(x), int(y)
    if check:
        before, fg_before = ScreenCapAt(x, y), win32gui.GetForegroundWindow()
    SetCursorPos((x, y))
    MouseClick()
    if not check:
        return None
    time.sleep(0.5)
    after = ScreenCapAt(x, y)
    changed = _pixels_changed(before, after)
    fg_after = win32gui.GetForegroundWindow()
    fg_title = win32gui.GetWindowText(fg_after)
    fg_changed = fg_before != fg_after
    status = "有像素变化" if changed else "⚠️ 0% 变化（可能点歪，停下诊断）"
    print(f"[Click check] {status} | fg: \"{fg_title}\" {'⚠️ CHANGED' if fg_changed else ''}")
    return after

click = Click

# ---------------------------------------------------------------- 键盘

VK_CODE = {'backspace': 0x08, 'tab': 0x09, 'clear': 0x0C, 'enter': 0x0D, 'shift': 0x10, 'ctrl': 0x11, 'alt': 0x12, 'pause': 0x13, 'caps_lock': 0x14, 'esc': 0x1B, 'escape': 0x1B, 'space': 0x20, 'page_up': 0x21, 'page_down': 0x22, 'end': 0x23, 'home': 0x24, 'left_arrow': 0x25, 'up_arrow': 0x26, 'right_arrow': 0x27, 'down_arrow': 0x28, 'select': 0x29, 'print': 0x2A, 'execute': 0x2B, 'print_screen': 0x2C, 'ins': 0x2D, 'del': 0x2E, 'help': 0x2F, '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34, '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39, 'a': 0x41, 'b': 0x42, 'c': 0x43, 'd': 0x44, 'e': 0x45, 'f': 0x46, 'g': 0x47, 'h': 0x48, 'i': 0x49, 'j': 0x4A, 'k': 0x4B, 'l': 0x4C, 'm': 0x4D, 'n': 0x4E, 'o': 0x4F, 'p': 0x50, 'q': 0x51, 'r': 0x52, 's': 0x53, 't': 0x54, 'u': 0x55, 'v': 0x56, 'w': 0x57, 'x': 0x58, 'y': 0x59, 'z': 0x5A, 'numpad_0': 0x60, 'numpad_1': 0x61, 'numpad_2': 0x62, 'numpad_3': 0x63, 'numpad_4': 0x64, 'numpad_5': 0x65, 'numpad_6': 0x66, 'numpad_7': 0x67, 'numpad_8': 0x68, 'numpad_9': 0x69, 'multiply_key': 0x6A, 'add_key': 0x6B, 'separator_key': 0x6C, 'subtract_key': 0x6D, 'decimal_key': 0x6E, 'divide_key': 0x6F, 'F1': 0x70, 'F2': 0x71, 'F3': 0x72, 'F4': 0x73, 'F5': 0x74, 'F6': 0x75, 'F7': 0x76, 'F8': 0x77, 'F9': 0x78, 'F10': 0x79, 'F11': 0x7A, 'F12': 0x7B, 'num_lock': 0x90, 'scroll_lock': 0x91, 'left_shift': 0xA0, 'right_shift': 0xA1, 'left_control': 0xA2, 'right_control': 0xA3, 'left_menu': 0xA4, 'right_menu': 0xA5, 'browser_back': 0xA6, 'browser_forward': 0xA7, 'browser_refresh': 0xA8, 'browser_stop': 0xA9, 'browser_search': 0xAA, 'browser_favorites': 0xAB, 'browser_start_and_home': 0xAC, 'volume_mute': 0xAD, 'volume_down': 0xAE, 'volume_up': 0xAF, 'next_track': 0xB0, 'previous_track': 0xB1, 'stop_media': 0xB2, 'play/pause_media': 0xB3, 'start_mail': 0xB4, 'select_media': 0xB5, 'start_application_1': 0xB6, 'start_application_2': 0xB7, '+': 0xBB, ',': 0xBC, '-': 0xBD, '.': 0xBE, '/': 0xBF, '`': 0xC0, ';': 0xBA, '[': 0xDB, '\\': 0xDC, ']': 0xDD, "'": 0xDE}
VK_CODE = {k.lower(): v for k, v in VK_CODE.items()}

def Press(cmd, staytime=0):
    """组合键，如 Press('ctrl+v') / Press('enter') / Press(['ctrl', 'shift', 't'])。"""
    if type(cmd) is list:
        cmds = [str(x).lower() for x in cmd]
    else:
        cmds = cmd.lower().split('+')
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

def type_text(text):
    """向当前前台焦点输入文本：剪贴板 + ctrl+v（先点击目标输入框）。
    会覆盖用户剪贴板内容——执行前如有需要先 GetClipboardText 备份。"""
    SetClipboardText(text)
    time.sleep(0.05)
    Press('ctrl+v')

# ---------------------------------------------------------------- 自检

if __name__ == "__main__":
    print(f"physical: {swidth}x{sheight} | logical: {cwidth}x{cheight} | dpi_scale: {dpi_scale}")
    print(f"foreground: {Foreground()}")
    rows = ListWindows()
    print(f"visible windows: {len(rows)}")
    for row in rows[:10]:
        print(f"  hwnd={row['hwnd']:<8} class={row['class'][:24]:<24} title={row['title'][:40]}")
    print("ljqCtrl ready")
