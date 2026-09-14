"""
UIA 控件树探测与免坐标操作（computer-use skill 资产）

依赖: pip install uiautomation（纯 comtypes 封装 Windows UIAutomation COM）
配合同目录 ljqCtrl.py：坐标回退点击、窗口定位共用。

Quick Reference:
- Tree(window, depth=8, query=None) -> [{role,name,value,rect,enabled,auto_id,depth}]
- Find(window, name=None, control_type=None, depth=12) -> [控件摘要 dict]
- ClickEl(window, name=None, control_type=None, index=0) -> 免坐标点击
    （Invoke/Select/Toggle 模式优先；无模式控件回退 BoundingRectangle 中心
    物理坐标走 ljqCtrl.Click——需要 ljqCtrl 同目录可用）
- SetTextEl(window, text, name=None) -> ValuePattern.SetValue 写文本
- GetValue(window, name=None) -> 读控件当前值

坑（GA SOP 沉淀 + 实测）：
- 游戏窗口禁用 UIA（反作弊）；某窗口 UIA 无效则后续不用，降级截图路线
- Electron/Chromium 窗口的 UIA 树依赖无障碍树，未激活时可能拿不到——
  先 Activate 再试一次
- 输出 rect 一律物理像素（进程已 SetProcessDPIAware，与 ljqCtrl 坐标系一致）
"""
import ctypes
import json
import sys
from pathlib import Path

ctypes.windll.user32.SetProcessDPIAware()

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import ljqCtrl
except ImportError:
    ljqCtrl = None

import uiautomation as auto

auto.uiautomation.SetGlobalSearchTimeout(1.0)

_MAX_TREE_NODES = 300
_MAX_FIND_RESULTS = 20


def _root(window):
    if isinstance(window, int) or str(window).isdigit():
        ctrl = auto.ControlFromHandle(int(window))
        if ctrl is None:
            raise RuntimeError(f"无效窗口句柄: {window}")
        return ctrl
    return auto.ControlFromHandle(ljqCtrl.FindWindow(str(window))) if ljqCtrl else auto.WindowControl(searchDepth=1, Name=str(window))


def _name_matches(ctrl, name, exact):
    if name is None:
        return True
    if exact:
        return (ctrl.Name or "") == name
    return name.lower() in (ctrl.Name or "").lower()

def _type_matches(ctrl, control_type):
    """控件类型匹配：'ListItem' 与 'ListItemControl' 视为相同（去掉 Control 后缀归一化）。"""
    if control_type is None:
        return True
    want = str(control_type).lower().removesuffix("control")
    have = ctrl.ControlTypeName.lower().removesuffix("control")
    return want == have

def _summary(ctrl, depth=0):
    rect = ctrl.BoundingRectangle
    value_pattern = ctrl.GetPattern(auto.PatternId.ValuePattern)
    return {
        "role": ctrl.ControlTypeName,
        "name": (ctrl.Name or "")[:60],
        "value": (value_pattern.Value if value_pattern else None) or None,
        "enabled": bool(ctrl.IsEnabled),
        "rect": [rect.left, rect.top, rect.right, rect.bottom],
        "auto_id": (ctrl.AutomationId or "")[:60],
        "depth": depth,
    }


def _walk(ctrl, depth, max_depth, out, query=None):
    if len(out) >= _MAX_TREE_NODES or depth > max_depth:
        return
    info = _summary(ctrl, depth)
    if query is None or query.lower() in info["name"].lower() or query.lower() in info["role"].lower():
        out.append(info)
    child = ctrl.GetFirstChildControl()
    while child is not None:
        _walk(child, depth + 1, max_depth, out, query)
        child = child.GetNextSiblingControl()


def Tree(window, depth=8, query=None):
    """枚举控件树（≤300 节点）。query 按名称/角色子串过滤（保留祖先链跳过）。"""
    out = []
    _walk(_root(window), 0, depth, out, query)
    return out


def Find(window, name=None, control_type=None, depth=12, exact=False):
    """按名称子串/控件类型查找控件，返回摘要列表（≤20 条）。"""
    results = []
    def visit(ctrl, d):
        if len(results) >= _MAX_FIND_RESULTS or d > depth:
            return
        if name is not None or control_type is not None:
            ok = _name_matches(ctrl, name, exact) and _type_matches(ctrl, control_type)
            if ok and d > 0:
                results.append(_summary(ctrl, d))
        child = ctrl.GetFirstChildControl()
        while child is not None:
            visit(child, d + 1)
            child = child.GetNextSiblingControl()
    visit(_root(window), 0)
    return results


def _locate(window, name=None, control_type=None, index=0, exact=False):
    rows = Find(window, name=name, control_type=control_type)
    if not rows:
        raise RuntimeError(f"未找到控件: name={name!r} type={control_type!r}（先 Tree 看结构）")
    if index >= len(rows):
        raise RuntimeError(f"控件索引越界: index={index}，共 {len(rows)} 条")
    # Find 返回摘要，重新从树里拿活控件
    matches = []
    def visit(ctrl, d):
        if len(matches) > index or d > 12:
            return
        ok = _name_matches(ctrl, name, exact) and _type_matches(ctrl, control_type)
        if ok and d > 0:
            matches.append(ctrl)
        child = ctrl.GetFirstChildControl()
        while child is not None:
            visit(child, d + 1)
            child = child.GetNextSiblingControl()
    visit(_root(window), 0)
    return matches[index]


def ClickEl(window, name=None, control_type=None, index=0, exact=False):
    """免坐标点击：Invoke/Select/Toggle/ExpandCollapse 模式优先，
    无模式控件回退矩形中心物理坐标（ljqCtrl.Click，带像素验证）。返回动作描述。"""
    ctrl = _locate(window, name=name, control_type=control_type, index=index, exact=exact)
    for pattern, label in (
        (auto.PatternId.InvokePattern, "Invoke"),
        (auto.PatternId.SelectionItemPattern, "Select"),
        (auto.PatternId.TogglePattern, "Toggle"),
    ):
        p = ctrl.GetPattern(pattern)
        if p:
            if pattern == auto.PatternId.TogglePattern:
                p.Toggle()
            elif pattern == auto.PatternId.SelectionItemPattern:
                p.Select()
            else:
                p.Invoke()
            return f"UIA {label}: {ctrl.Name or ctrl.ControlTypeName}"
    # 回退：矩形中心物理坐标（BoundingRectangle 在 DPI-aware 进程是物理像素）
    if not ljqCtrl:
        raise RuntimeError("控件无 Invoke/Select/Toggle 模式，且 ljqCtrl 不可用无法坐标回退")
    rect = ctrl.BoundingRectangle
    cx, cy = (rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2
    ljqCtrl.Click(cx, cy)
    return f"坐标回退点击 ({cx}, {cy}): {ctrl.Name or ctrl.ControlTypeName}"


def SetTextEl(window, text, name=None, control_type="Edit", exact=False):
    """ValuePattern.SetValue 写文本（比键入快且不抢输入法焦点）。"""
    ctrl = _locate(window, name=name, control_type=control_type, exact=exact)
    p = ctrl.GetPattern(auto.PatternId.ValuePattern)
    if not p:
        raise RuntimeError(f"控件不支持 ValuePattern: {ctrl.ControlTypeName} {ctrl.Name!r}")
    p.SetValue(str(text))
    return f"已写入 {len(str(text))} 字符"


def GetValue(window, name=None, control_type=None, index=0, exact=False):
    """读控件当前值（ValuePattern → LegacyIAccessibleValue → Name 逐级回退）。"""
    ctrl = _locate(window, name=name, control_type=control_type, index=index, exact=exact)
    p = ctrl.GetPattern(auto.PatternId.ValuePattern)
    if p:
        return p.Value
    legacy = ctrl.GetPattern(auto.PatternId.LegacyIAccessiblePattern)
    if legacy:
        return legacy.DefaultAction or legacy.Description or ctrl.Name
    return ctrl.Name


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="UIA 控件树探测/操作")
    ap.add_argument("window", help="窗口标题子串或 hwnd")
    ap.add_argument("--tree", action="store_true", help="枚举控件树")
    ap.add_argument("--find", metavar="NAME", help="按名称子串查找")
    ap.add_argument("--click", metavar="NAME", help="免坐标点击指定控件")
    ap.add_argument("--settext", metavar="TEXT", help="向 Edit 控件写文本")
    ap.add_argument("--getvalue", metavar="NAME", help="读控件值")
    ap.add_argument("--depth", type=int, default=8)
    ap.add_argument("--index", type=int, default=0)
    a = ap.parse_args()
    if a.tree:
        print(json.dumps(Tree(a.window, depth=a.depth), ensure_ascii=False, indent=1))
    elif a.find:
        print(json.dumps(Find(a.window, name=a.find), ensure_ascii=False, indent=1))
    elif a.click:
        print(ClickEl(a.window, name=a.click, index=a.index))
    elif a.settext is not None:
        print(SetTextEl(a.window, a.settext))
    elif a.getvalue:
        print(GetValue(a.window, name=a.getvalue))
    else:
        rows = Tree(a.window, depth=4)
        print(json.dumps(rows[:40], ensure_ascii=False, indent=1))
