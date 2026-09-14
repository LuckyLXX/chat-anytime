#!/usr/bin/env python3
"""
UI元素视觉检测 - 截图 → 控件 bbox + 文本（computer-use skill 资产）

源自 GenericAgent memory/ui_detect.py（MIT, Copyright (c) 2025 lsdefine），
按 PiDesktop 移植改造为双档依赖：
- 必需（开箱可用）：rapidocr-onnxruntime —— 全图 OCR，返回文本元素
  [{bbox:[x1,y1,x2,y2], type:'text', label, confidence}]，覆盖大多数
  定位需求（按钮/菜单/输入框都有文字）
- 可选（增强）：ultralytics + OmniParser-2.0 icon_detect YOLO 权重 ——
  额外检测无文字图标（type:'icon'，label=None 可交给 VLM 识别）
  权重放 <skill目录>/weights/icon_detect/model.pt，从 OmniParser-2.0 下载

用法（脚本内）:
  from ui_detect import detect
  elements = detect("screenshot.png")     # PIL.Image 或路径
用法（CLI）:
  python ui_detect.py shot.png --json     # JSON 输出（Agent 友好）

坐标注意：bbox 是截图内坐标；转屏幕物理坐标 =
  ljqCtrl.ClientRectScreen(hwnd) 左上角 + bbox 中心（见 SKILL.md）。
"""
from pathlib import Path
from PIL import Image, ImageDraw
import json
import urllib.request
import subprocess
import sys
import time

DEFAULT_MODEL = str(Path(__file__).resolve().parent / "weights" / "icon_detect" / "model.pt")

try:
    from rapidocr_onnxruntime import RapidOCR
    _ocr = RapidOCR()
except ImportError:
    _ocr = None

_YOLO = None
_YOLO_PORT = 31876


def _yolo_available():
    """YOLO 图标检测是否可用（ultralytics + 权重文件都在）。"""
    if not Path(DEFAULT_MODEL).exists():
        return False
    try:
        import ultralytics  # noqa: F401
        return True
    except ImportError:
        return False


def _yolo_local(image_path, conf=0.25):
    global _YOLO
    if _YOLO is None:
        from ultralytics import YOLO
        _YOLO = YOLO(DEFAULT_MODEL)
    res = _YOLO(image_path, conf=conf, verbose=False)
    boxes = []
    for r in res:
        for b in r.boxes:
            x1, y1, x2, y2 = map(int, b.xyxy[0].cpu().numpy())
            boxes.append([x1, y1, x2, y2, float(b.conf[0])])
    return boxes


def _ping_yolo_daemon():
    try:
        return urllib.request.urlopen(f"http://127.0.0.1:{_YOLO_PORT}/ping", timeout=0.1).read() == b"ui_detect_yolo"
    except Exception:
        return False


def _yolo(image_path, conf=0.25):
    """YOLO 检测 → list of [x1,y1,x2,y2,conf]；模型走跨进程 daemon cache，失败回退本地。"""
    if not _ping_yolo_daemon():
        kw = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if sys.platform == "win32" else {}
        subprocess.Popen([sys.executable, __file__, "--yolo-daemon"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)
        for _ in range(15):
            if _ping_yolo_daemon():
                break
            time.sleep(0.5)
    try:
        data = json.dumps({"path": str(image_path), "conf": conf}).encode("utf-8")
        req = urllib.request.Request(f"http://127.0.0.1:{_YOLO_PORT}/yolo", data=data, headers={"Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=3).read().decode("utf-8"))["boxes"]
    except Exception:
        return _yolo_local(image_path, conf)


def _ocr_full(image_path):
    """全图 OCR → list of [x1,y1,x2,y2,text,conf]"""
    if not _ocr:
        return []
    result, _ = _ocr(image_path)
    if not result:
        return []
    out = []
    for bbox, text, conf in result:
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        out.append([int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)), text, conf])
    return out


def _ocr_crops_batch(img, yolo_boxes):
    """批量 OCR：将所有 YOLO 框 crop 垂直拼接为一张图，一次 OCR，按 y 坐标映射回各 box。"""
    if not _ocr or not yolo_boxes:
        return {}
    crops, offsets = [], []
    max_w, y_cursor = 0, 0
    for idx, (x1, y1, x2, y2, _) in enumerate(yolo_boxes):
        crop = img.crop((x1, y1, x2, y2))
        w, h = crop.size
        max_w = max(max_w, w)
        crops.append(crop)
        offsets.append((y_cursor, x1, y1, idx))
        y_cursor += h
    if max_w == 0:
        return {}
    stitched = Image.new("RGB", (max_w, y_cursor), (255, 255, 255))
    for i, crop in enumerate(crops):
        stitched.paste(crop, (0, offsets[i][0]))
    result, _ = _ocr(stitched)
    if not result:
        return {}
    labels = {}
    for bbox, text, _ in result:
        cy = sum(p[1] for p in bbox) / len(bbox)
        for y_off, ox1, oy1, idx in offsets:
            h = yolo_boxes[idx][3] - yolo_boxes[idx][1]
            if y_off <= cy < y_off + h:
                old = labels.get(idx)
                labels[idx] = (old + " " + text) if old else text
                break
    return labels


def _iou(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / area_b if area_b > 0 else 0


def detect(image_path, mode="match", conf=0.25, iou_thresh=0.5):
    """统一检测入口，返回元素列表:
    [{'bbox':[x1,y1,x2,y2], 'type':'icon'|'text', 'label':str|None, 'confidence':float}]
    - YOLO 可用: match 模式（YOLO+全图OCR IoU 匹配，~1.2s）/ crop 模式（拼接 OCR，更准，~2.3s）
    - YOLO 不可用: 自动降级 OCR-only（只有 type:'text' 元素，无文字图标检不到）
    附送 OCR——不要单独再跑 OCR。"""
    if _ocr is None:
        raise RuntimeError("缺少依赖: pip install rapidocr-onnxruntime")
    if isinstance(image_path, Image.Image):
        import tempfile
        import os
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        image_path.save(tmp.name)
        image_path = tmp.name
    img = Image.open(image_path)

    yolo_boxes = []
    yolo_on = _yolo_available()
    if yolo_on:
        yolo_boxes = _yolo(image_path, conf)
    elements = []

    if not yolo_on:
        for ox1, oy1, ox2, oy2, text, oc in _ocr_full(image_path):
            elements.append({"bbox": [ox1, oy1, ox2, oy2], "type": "text", "label": text, "confidence": oc})
    elif mode == "crop":
        labels_map = _ocr_crops_batch(img, yolo_boxes)
        for idx, (x1, y1, x2, y2, c) in enumerate(yolo_boxes):
            elements.append({"bbox": [x1, y1, x2, y2], "type": "icon", "label": labels_map.get(idx), "confidence": c})
        for ox1, oy1, ox2, oy2, text, oc in _ocr_full(image_path):
            covered = any(_iou([x1, y1, x2, y2], [ox1, oy1, ox2, oy2]) > iou_thresh for x1, y1, x2, y2, _ in yolo_boxes)
            if not covered:
                elements.append({"bbox": [ox1, oy1, ox2, oy2], "type": "text", "label": text, "confidence": oc})
    else:
        ocr_items = _ocr_full(image_path)
        matched_ocr = set()
        for x1, y1, x2, y2, c in yolo_boxes:
            label = None
            for i, (ox1, oy1, ox2, oy2, text, oc) in enumerate(ocr_items):
                if _iou([x1, y1, x2, y2], [ox1, oy1, ox2, oy2]) > iou_thresh:
                    label = text
                    matched_ocr.add(i)
                    break
            elements.append({"bbox": [x1, y1, x2, y2], "type": "icon", "label": label, "confidence": c})
        for i, (ox1, oy1, ox2, oy2, text, oc) in enumerate(ocr_items):
            if i not in matched_ocr:
                elements.append({"bbox": [ox1, oy1, ox2, oy2], "type": "text", "label": text, "confidence": oc})
    return elements


def visualize_for_debug(image_path, elements, output_path=None):
    """调试可视化（用户要求时才用）。"""
    from PIL import ImageFont
    img = Image.open(image_path)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("msyh.ttc", 14)
    except Exception:
        font = ImageFont.load_default()
    for el in elements:
        x1, y1, x2, y2 = el["bbox"]
        color = "red" if el["type"] == "icon" else "blue"
        draw.rectangle([x1, y1, x2, y2], outline=color, width=2)
        tag = el.get("label") or f"{el['confidence']:.2f}"
        draw.text((x1, y1 - 16), tag[:15], fill=color, font=font)
    if output_path:
        img.save(output_path)
    return img


def _serve_yolo_daemon():
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class H(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path == "/ping":
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ui_detect_yolo")
            else:
                self.send_response(404)
                self.end_headers()

        def do_POST(self):
            try:
                d = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                body = json.dumps({"boxes": _yolo_local(d["path"], d.get("conf", 0.25))}).encode("utf-8")
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                body = json.dumps({"error": repr(e)}).encode("utf-8")
                self.send_response(500)
                self.end_headers()
                self.wfile.write(body)

    s = HTTPServer(("127.0.0.1", _YOLO_PORT), H)
    s.timeout = 60
    s.last = time.time()
    while time.time() - s.last < 3600:
        s.handle_request()


if __name__ == "__main__":
    if "--yolo-daemon" in sys.argv:
        _serve_yolo_daemon()
        sys.exit(0)
    import argparse
    ap = argparse.ArgumentParser(description="截图 UI 元素检测（OCR 必需 / YOLO 可选）")
    ap.add_argument("image", help="截图文件路径")
    ap.add_argument("--json", action="store_true", help="JSON 输出")
    ap.add_argument("--mode", choices=["match", "crop"], default="match")
    ap.add_argument("--visualize", metavar="OUT", help="输出标注图")
    a = ap.parse_args()
    els = detect(a.image, mode=a.mode)
    if a.visualize:
        visualize_for_debug(a.image, els, a.visualize)
        els = [{**el} for el in els]
    if a.json:
        print(json.dumps({"count": len(els), "yolo": _yolo_available(), "elements": els}, ensure_ascii=False, indent=1))
    else:
        print(f"检测到 {len(els)} 个元素（YOLO: {'on' if _yolo_available() else 'off（仅文本）'}）")
        for el in els[:20]:
            x1, y1, x2, y2 = el["bbox"]
            print(f"  [{el['type']}] ({x1},{y1})-({x2},{y2}) {el['label'] or ''}")
