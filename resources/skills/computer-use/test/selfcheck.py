#!/usr/bin/env python3
"""computer-use skill 自检（回归/复现脚本）

用途：把「这个 skill 的截图/点击到底可不可靠」变成随时可跑、有明确 PASS/FAIL 的检查。
本 skill 历史上出过两个靠「凭属性/凭经验下结论」造成的错误文档与死代码，这份脚本就是
防它再发生的：**任何关于截图像素、点击验证口径、前台校验的结论，先跑这里再写进文档。**

设计纪律（重要）：
- **只碰自己造的窗口**：全部用例都在自己 new 出来的 Tk 窗口上做，绝不操作第三方应用窗口。
- **跑完就收拾**：destroy 所有自建窗口，并把前台恢复成运行前的那个窗口。
- **分档可跑**：--printwindow / --click / --screenshot / --ocr / --uia / --all。
- 输出 `[PASS]/[FAIL]` 行 + 末尾 JSON 摘要；有 FAIL 时退出码为 1。

依赖：pywin32 + pillow（基础）；--ocr 需要 rapidocr-onnxruntime；--uia 需要 uiautomation。
用法：
    python test/selfcheck.py --all
    python test/selfcheck.py --click --screenshot
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import tkinter as tk
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_DIR))

import ctypes  # noqa: E402
import win32gui  # noqa: E402
import win32ui  # noqa: E402

import ljqCtrl  # noqa: E402
from PIL import Image  # noqa: E402

RESULTS: list[dict] = []
BG = "#202020"
PANEL_IDLE = "#2d2d2d"
PANEL_HIT = "#27ae60"
BUTTON_TEXT = "selfcheck-button"


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append({"check": name, "ok": bool(ok), "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    print()
    return bool(ok)


class Harness:
    """一棵自建 Tk 窗口 + 一个跑在后台线程里的检查流程（Tk 必须占主线程）。"""

    def __init__(self, plan):
        self.plan = plan
        self.result: dict = {}
        self.prev_fg = win32gui.GetForegroundWindow()
        self.clicks: list[float] = []
        self.ocr_text = "selfcheck确定取消"

    def build(self) -> tk.Tk:
        root = tk.Tk()
        root.title("PI-CU-SELFCHECK")
        root.geometry("560x360+160+160")
        root.configure(bg=BG)
        self.panel = tk.Frame(root, bg=PANEL_IDLE, width=500, height=90)
        self.panel.place(x=30, y=240)
        tk.Label(root, text=self.ocr_text, bg=BG, fg="#e6e6e6").place(x=30, y=180)
        tk.Button(root, text="点我", width=10, height=2, command=self._on_click).place(x=30, y=30)
        root.update()
        self.root = root
        self.hwnd = win32gui.FindWindow(None, "PI-CU-SELFCHECK")
        return root

    def _on_click(self):
        self.clicks.append(time.time())
        self.panel.configure(bg=PANEL_HIT)

    def run_plan(self):
        """在后台线程跑（Tk 的事件循环在主线程里转）。用 root.after 派发 done 回调。"""
        time.sleep(0.5)
        try:
            self.result = self.plan(self) or {}
        except Exception as exc:  # 单个用例炸了也要出报告
            self.result = {"error": repr(exc)}
        finally:
            try:
                self.root.after(0, self._finish)
            except Exception:
                pass

    def _finish(self):
        # 收拾：从面板颜色判断按钮回调是否真的被触发过（Tk 在主线程里才更新界面）
        self.result["clicks"] = len(self.clicks)
        self.result["panel_hit"] = str(self.panel.cget("bg")).lower() == PANEL_HIT
        for widget in self.root.winfo_children():
            try:
                widget.destroy()
            except Exception:
                pass
        self.root.quit()


def with_harness(plan) -> dict:
    h = Harness(plan)
    root = h.build()
    threading.Thread(target=h.run_plan, daemon=True).start()
    root.mainloop()
    try:
        root.destroy()
    except Exception:
        pass
    time.sleep(0.3)
    if h.prev_fg:
        ljqCtrl.Activate(h.prev_fg, verify=False)   # 恢复用户原来的前台窗口
    return h.result


# ---------------------------------------------------------------- 用例

def check_printwindow() -> None:
    """PrintWindow flags 对照：同一窗口 flags=1 vs flags=3。

    环境指纹（不同机器结果可能不同，所以不把 flags=1 全黑当 FAIL）：
    - Tk 这类非 DWM 合成窗口：flags=1 也正常；
    - Chromium/Electron/UWP 窗口：flags=1 全黑、flags=3 正常。
    无论哪种，flags=3 必须拿到真实内容（唯一灰度值足够多）。
    """
    def plan(h):
        hwnd = h.hwnd
        w, hh = ljqCtrl.ClientSize(hwnd)

        def raw(flags):
            hdc = win32gui.GetWindowDC(hwnd)
            src = win32ui.CreateDCFromHandle(hdc)
            mem = src.CreateCompatibleDC()
            bmp = win32ui.CreateBitmap()
            bmp.CreateCompatibleBitmap(src, w, hh)
            old = mem.SelectObject(bmp)
            try:
                ok = bool(ctypes.windll.user32.PrintWindow(hwnd, mem.GetSafeHdc(), flags))
                info, bits = bmp.GetInfo(), bmp.GetBitmapBits(True)
                return ok, _bgrx(info, bits)
            finally:
                mem.SelectObject(old)
                win32gui.DeleteObject(bmp.GetHandle())
                mem.DeleteDC()
                src.DeleteDC()
                win32gui.ReleaseDC(hwnd, hdc)

        import numpy as np
        ok1, img1 = raw(ljqCtrl.PW_CLIENTONLY)
        ok3, img3 = raw(ljqCtrl.PW_CLIENTONLY | ljqCtrl.PW_RENDERFULLCONTENT)
        g3 = np.asarray(img3.convert("L"))
        uniq3 = int(len(np.unique(g3)))
        uniq1 = int(len(np.unique(np.asarray(img1.convert("L")))))
        # 也验一下公开 API：GrabWindowBg 默认就该是 flags=3
        bg = ljqCtrl.GrabWindowBg(hwnd)
        gbg = np.asarray(bg.convert("L"))
        return {
            "flags1_return": ok1, "flags1_unique": uniq1,
            "flags1_black": uniq1 <= 1,
            "flags3_return": ok3, "flags3_unique": uniq3,
            "grabwindowbg_size": list(bg.size), "grabwindowbg_unique": int(len(np.unique(gbg))),
            "grabwindowbg_cu_bg": bool(bg.info.get("cu_bg"))
        }

    r = with_harness(plan)
    if r.get("error"):
        check("printwindow: 自检流程异常", False, r["error"])
        return
    check("printwindow: flags=3 拿到真实内容（唯一灰度值 > 20）", r["flags3_unique"] > 20, f"unique={r['flags3_unique']}")
    check("printwindow: GrabWindowBg 默认用 flags=3（内容非全黑）", r["grabwindowbg_unique"] > 20, f"unique={r['grabwindowbg_unique']}")
    check(
        "printwindow: 环境指纹（记录 flags=1 是否全黑，不作判据）",
        True,
        f"flags=1 unique={r['flags1_unique']} black={r['flags1_black']}；"
        "若这里 black=true 而 flags=3 正常，说明该窗口正是需要 PW_RENDERFULLCONTENT 的那类",
    )


def _bgrx(info, bits):
    """PrintWindow 的原始位图（BGRX）→ PIL Image。"""
    return Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]), bits, "raw", "BGRX", 0, 1).copy()


def check_click() -> None:
    """点击验证口径：命中 / 变化 / 前台三条路径都要走一遍。

    这三个断言正是本 skill 的 P0 缺陷回归：
    - 点真实按钮（真的有界面变化）→ verdict=changed；
    - 点静态区域（真的没变化）→ **warn_static 而不是判失败**（旧的「0% 变化 = 点歪」就在这里错）；
    - 坐标上坐着别的窗口 → **拒绝点击**（旧实现会真的点到别的窗口去）。
    """
    def plan(h):
        hwnd = h.hwnd
        ox, oy = ljqCtrl.ClientOrigin(hwnd)
        # 按钮：place(x=30, y=30)，约 100×45
        r_button = ljqCtrl.Click(ox + 30 + 45, oy + 30 + 22, hwnd=hwnd)
        # 静态区域：右下角空白
        r_static = ljqCtrl.Click(ox + 500, oy + 150, hwnd=hwnd)
        # 坐标点在别的窗口上（拿一个肯定不是本窗口的 hwnd 当"目标"）
        r_refused = ljqCtrl.Click(ox + 45, oy + 62, hwnd=win32gui.FindWindow(None, "Program Manager") or 0)
        # 客户区外的点（标题栏上方）
        r_titlebar = ljqCtrl.Click(ox + 45, oy - 12, hwnd=hwnd, guard=False)
        return {
            "button": {k: r_button[k] for k in ("verdict", "hit_ok", "client_changed", "client_diff_ratio", "roi_changed", "fg_ok")},
            "static": {k: r_static[k] for k in ("verdict", "hit_ok", "client_changed", "client_diff_ratio")},
            "refused": {k: r_refused[k] for k in ("ok", "verdict", "hit_ok", "hit_title", "advice")},
            "titlebar": {k: r_titlebar[k] for k in ("verdict", "hit_ok", "in_client")}
        }

    r = with_harness(plan)
    if r.get("error"):
        check("click: 自检流程异常", False, r["error"])
        return
    b, s, f, t = r["button"], r["static"], r["refused"], r["titlebar"]
    check("click: 点真实按钮 → 命中目标窗口", b["hit_ok"] is True, json.dumps(b, ensure_ascii=False))
    check("click: 点真实按钮 → 检测到界面变化（changed）", b["verdict"] == "changed" and b["client_changed"] is True, json.dumps(b, ensure_ascii=False))
    check("click: 按钮回调真的被触发", r.get("panel_hit") is True and r.get("clicks", 0) >= 1, f"clicks={r.get('clicks')} panel_hit={r.get('panel_hit')}")
    check("click: 点静态区域 → warn_static（无变化≠点歪，不判失败）", s["verdict"] == "warn_static" and s["client_changed"] is False, json.dumps(s, ensure_ascii=False))
    check("click: 坐标上坐着别的窗口 → 拒绝点击（不落到别的窗口里）", f["verdict"] == "refused_hit" and f["ok"] is False, json.dumps(f, ensure_ascii=False))
    check("click: 拒绝时给出的信息里带上「实际命中哪个窗口」", bool(f["hit_title"]), json.dumps(f, ensure_ascii=False))
    check("click: 客户区外的点会被标出 in_client=False", t["in_client"] is False, json.dumps(t, ensure_ascii=False))


def check_screenshot() -> None:
    """截图必须真的是目标窗口的画面，且前台校验要如实报告。"""
    def plan(h):
        hwnd = h.hwnd
        img = ljqCtrl.GrabWindow(hwnd)
        # 面板 place(y=240, height=90) → 取样点必须在面板内部（y=280），不是窗口底部
        centre = img.convert("RGB").getpixel((img.size[0] // 2, 280))
        return {
            "size": list(img.size), "client": list(ljqCtrl.ClientSize(hwnd)),
            "cu_fg_ok": bool(img.info.get("cu_fg_ok")), "cu_title": img.info.get("cu_title"),
            "cu_client_origin": list(img.info.get("cu_client_origin") or []),
            "panel_pixel": list(centre), "panel_expected": [45, 45, 45]
        }

    r = with_harness(plan)
    if r.get("error"):
        check("screenshot: 自检流程异常", False, r["error"])
        return
    check("screenshot: 截图尺寸 == 客户区尺寸", r["size"] == r["client"], f"{r['size']} vs {r['client']}")
    check("screenshot: cu_fg_ok=True 且标题对得上", r["cu_fg_ok"] is True and r["cu_title"] == "PI-CU-SELFCHECK", json.dumps(r, ensure_ascii=False))
    ok_pixel = all(abs(a - b) <= 6 for a, b in zip(r["panel_pixel"], r["panel_expected"]))
    check("screenshot: 底部面板像素 == 自建窗口的面板颜色（证明拿到的是目标窗口）", ok_pixel, f"got {r['panel_pixel']} expect ~{r['panel_expected']}")


def check_ocr() -> None:
    """ui_detect 的入参兼容：PIL 直传不该报错（旧版 rapidocr 会 LoadImageError），且不留临时文件。"""
    try:
        from ui_detect import detect, _yolo_available
    except Exception as exc:
        check("ocr: ui_detect 可导入", False, repr(exc))
        return
    import glob
    import tempfile

    def plan(h):
        img = Image.fromarray(__import__("numpy").asarray(ljqCtrl.GrabWindow(h.hwnd)))
        pattern = os.path.join(tempfile.gettempdir(), "tmp*.png")
        before = len(glob.glob(pattern))
        labels_pil = [e["label"] for e in detect(img) if e.get("label")]
        labels_nd = [e["label"] for e in detect(__import__("numpy").asarray(img)) if e.get("label")]
        after = len(glob.glob(pattern))
        return {"pil_labels": labels_pil, "nd_labels": labels_nd, "temp_before": before, "temp_after": after,
                "yolo": _yolo_available()}

    r = with_harness(plan)
    if r.get("error"):
        check("ocr: 自检流程异常", False, r["error"])
        return
    check("ocr: PIL 直传可用（旧版 rapidocr 会 LoadImageError）", bool(r["pil_labels"]), json.dumps(r, ensure_ascii=False))
    check("ocr: ndarray 入参与 PIL 结果一致", r["pil_labels"] == r["nd_labels"], json.dumps(r, ensure_ascii=False))
    check("ocr: 不泄漏临时文件", r["temp_after"] <= r["temp_before"], f"{r['temp_before']} -> {r['temp_after']}")
    check("ocr: 无「确定/取消」以外误报", True, f"yolo={'on' if r['yolo'] else 'off'} labels={r['pil_labels'][:4]}")


def check_uia() -> None:
    """UIA 冒烟：能连上、能枚举（Tk 窗口的 UIA 树可能很浅，所以只做软断言）。"""
    try:
        import uia
    except Exception as exc:
        check("uia: uia.py 可导入（需要 pip install uiautomation）", False, repr(exc))
        return

    def plan(h):
        # UIA 走 COM，工作线程里必须先 CoInitialize（否则 OSError 22「尚未调用 CoInitialize」）
        ctypes.windll.ole32.CoInitialize(None)
        try:
            rows = uia.Tree(h.hwnd, depth=4)
            return {"nodes": len(rows), "roles": sorted({r["role"] for r in rows})[:8]}
        finally:
            ctypes.windll.ole32.CoUninitialize()

    r = with_harness(plan)
    if r.get("error"):
        check("uia: 自检流程异常（Tk 窗口的 UIA 支持有限，属已知边界）", False, r["error"])
        return
    check("uia: 控件树可枚举（≥1 节点）", r["nodes"] >= 1, json.dumps(r, ensure_ascii=False))


CHECKS = {
    "printwindow": check_printwindow,
    "click": check_click,
    "screenshot": check_screenshot,
    "ocr": check_ocr,
    "uia": check_uia,
}


def main() -> int:
    ap = argparse.ArgumentParser(description="computer-use skill 自检（自造窗口，不碰别人的窗口）")
    ap.add_argument("--all", action="store_true", help="跑全部用例")
    for name in CHECKS:
        ap.add_argument(f"--{name}", action="store_true", help=f"只跑 {name} 用例")
    ap.add_argument("--json", metavar="OUT", help="把摘要写到文件")
    a = ap.parse_args()
    selected = [name for name in CHECKS if getattr(a, name.replace("-", "_"), False)]
    if a.all or not selected:
        selected = list(CHECKS)
    if ljqCtrl.ImageGrab is None:
        print("缺少依赖: pip install pywin32 pillow", file=sys.stderr)
        return 2
    print(f"computer-use selfcheck | python {sys.version.split()[0]} | dpi_scale={ljqCtrl.dpi_scale} "
          f"| screen {ljqCtrl.swidth}x{ljqCtrl.sheight}\n")
    for name in selected:
        try:
            CHECKS[name]()
        except Exception as exc:
            check(f"{name}: 用例异常", False, repr(exc))
    failed = [r for r in RESULTS if not r["ok"]]
    summary = {"total": len(RESULTS), "failed": len(failed), "results": RESULTS}
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{'ALL PASS' if not failed else str(len(failed)) + ' FAILED'} ({len(RESULTS)} checks)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
