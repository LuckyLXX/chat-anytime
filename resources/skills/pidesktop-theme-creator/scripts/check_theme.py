#!/usr/bin/env python3
"""校验 PiDesktop 主题的覆盖度、可移植性与颜色对比度。"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Iterable


EXPECTED_VARIABLES = (
    "--chat-bg-image", "--chat-bg-opacity", "--chat-bg-size", "--chat-bg-repeat", "--chat-bg-position",
    "--surface", "--surface-muted", "--surface-raised", "--surface-conversation", "--surface-sidebar",
    "--surface-sidebar-tabs", "--surface-sidebar-hover", "--surface-sidebar-active", "--surface-sidebar-badge",
    "--surface-input", "--surface-footer", "--surface-detail", "--surface-button-hover", "--preview-surface",
    "--blockquote-surface", "--panel-bg", "--text", "--text-muted", "--text-sidebar-active", "--text-on-accent", "--on-accent",
    "--text-on-user-bubble", "--avatar-user-text", "--avatar-assistant-text", "--link", "--border",
    "--border-strong", "--border-message", "--border-assistant", "--blockquote-border", "--user-bubble-border",
    "--accent-border", "--accent", "--accent-hover", "--accent-soft", "--accent-text", "--focus-ring", "--selection-bg",
    "--selection-text", "--success", "--success-soft", "--success-border", "--completed-border", "--warning",
    "--warning-soft", "--danger", "--danger-soft", "--danger-border", "--danger-text", "--blue",
    "--user-bubble", "--ai-bubble", "--avatar-user", "--avatar-assistant", "--tool-bubble-bg",
    "--tool-bubble-border", "--code-surface", "--code-text", "--inline-code-surface", "--inline-code-text",
    "--syntax-keyword", "--syntax-string", "--syntax-number", "--syntax-comment", "--syntax-title",
    "--syntax-meta", "--diff-add-text", "--diff-remove-text", "--diff-hunk-text", "--diff-meta-text",
    "--user-action-border", "--user-action-surface", "--overlay", "--shadow-sm", "--shadow-md", "--shadow-lg",
    "--scrollbar-track", "--scrollbar-thumb", "--scrollbar-thumb-hover",
)

CONTRAST_PAIRS = (
    ("--text", "--surface", 4.5, "正文文本"),
    ("--text-muted", "--surface", 4.5, "次要文本"),
    ("--text-sidebar-active", "--surface-sidebar-active", 3.0, "侧栏选中项"),
    ("--text-on-accent", "--accent", 4.5, "强调色控件"),
    ("--text-on-accent", "--accent-hover", 4.5, "强调色悬停控件"),
    ("--accent-text", "--accent-soft", 4.5, "强调内容"),
    ("--accent-text", "--surface", 4.5, "强调状态图标"),
    ("--text-on-user-bubble", "--user-bubble", 4.5, "用户气泡"),
    ("--avatar-user-text", "--avatar-user", 3.0, "用户头像"),
    ("--avatar-assistant-text", "--avatar-assistant", 3.0, "助手头像"),
    ("--link", "--surface", 4.5, "链接"),
    ("--inline-code-text", "--inline-code-surface", 4.5, "行内代码"),
    ("--code-text", "--code-surface", 4.5, "代码文本"),
    ("--syntax-keyword", "--code-surface", 3.0, "关键字语法"),
    ("--syntax-string", "--code-surface", 3.0, "字符串语法"),
    ("--syntax-number", "--code-surface", 3.0, "数字语法"),
    ("--syntax-comment", "--code-surface", 3.0, "注释语法"),
    ("--syntax-title", "--code-surface", 3.0, "标题语法"),
    ("--syntax-meta", "--code-surface", 3.0, "元信息语法"),
    ("--danger-text", "--danger-soft", 4.5, "危险状态"),
    ("--diff-add-text", "--success-soft", 4.5, "Diff 新增"),
    ("--diff-remove-text", "--danger-soft", 4.5, "Diff 删除"),
    ("--diff-hunk-text", "--accent-soft", 4.5, "Diff 定位行"),
    ("--diff-meta-text", "--accent-soft", 4.5, "Diff 元信息"),
)

COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
RULE_RE = re.compile(r"([^{}]+)\{([^{}]*)\}", re.DOTALL)
DECL_RE = re.compile(r"(--[-\w]+)\s*:\s*([^;]+);")
VAR_RE = re.compile(r"var\(\s*(--[-\w]+)(?:\s*,\s*([^)]*))?\)")
HEX_RE = re.compile(r"#([\da-f]{3,8})\b", re.IGNORECASE)
URL_RE = re.compile(r"url\(\s*(['\"]?)([^'\")]+)\1\s*\)", re.IGNORECASE)
STRUCTURAL_TYPE_RE = re.compile(r"theme\s+type\s*[:=]\s*structural", re.IGNORECASE)
LAYER_NAME_RE = re.compile(r"^--pi-(?:layer|overlay)-([a-z0-9][a-z0-9-]*)$")

# Stable theme-hook contract mirrored from the PiDesktop renderer (see the
# repository's AGENTS.md theme bullet and docs/theme-guide.md).
KNOWN_PANES = frozenset({
    "sidebar", "topbar", "workspace", "work-area", "conversation", "timeline", "composer",
    "task-panel", "memory-panel", "preview", "terminal", "ssh", "ssh-files",
    "question-panel", "settings-dialog", "permission-dialog",
    "landing", "turn-minimap", "markdown-outline",
    "design", "design-toolbar", "design-tools", "design-canvas", "design-layers", "design-inspector",
    "gallery-menu", "gallery-wall",
    "automation-settings", "automation-dialog",
    "agent-settings", "general-settings",
    "model-settings",
    "resource-settings",
    "appearance-settings",
    "subagent-settings",
    "hooks-settings",
    "usage-settings",
})
KNOWN_ROLES = frozenset({"user", "assistant", "extension"})
KNOWN_CONTROLS = frozenset({
    "new-session", "settings", "workspace-open", "preview-toggle", "task-panel-toggle", "memory-toggle",
    "send", "stop", "attach", "queue-edit", "queue-send-now", "queue-remove", "access-mode", "plan-toggle",
    "model-select", "thinking-select", "thinking-expand", "context-usage", "browser-pick", "browser-download-toggle",
    "copy", "edit", "regenerate", "share", "pane-maximize", "pane-close",
    "automation-open", "automation-run", "automation-toggle", "automation-runs-tab", "preview-outline-toggle",
    "ssh-open", "ssh-host-create", "ssh-host-save", "ssh-host-delete", "ssh-host-connect", "ssh-trust-fingerprint", "ssh-group-create", "ssh-group-save",
    "ssh-files-toggle", "ssh-upload", "ssh-download", "ssh-transfer-cancel",
    "gallery-toggle", "gallery-publish", "gallery-run", "gallery-develop", "gallery-open-wall", "gallery-remove",
    "computer-toggle", "design-toggle", "design-send-ai", "design-export", "design-undo", "design-redo",
    "design-tool-select", "design-tool-frame", "design-tool-rect", "design-tool-text", "design-layer-lock",
    "agent-new", "agent-save", "settings-version", "jev-test", "jev-expand", "capability-switch",
    "model-provider-add",
    "model-provider-delete",
    "model-save",
    "model-refresh",
    "model-add",
    "model-thinking-levels",
    "model-thinking-panel",
    "resource-reload",
    "mcp-add",
    "mcp-save",
    "command-add",
    "command-save",
    "appearance-import-css",
    "appearance-import-theme",
    "appearance-clear-css",
    "appearance-save-theme",
    "appearance-save",
    "subagent-add",
    "subagent-save",
    "hooks-enable",
    "hooks-add",
    "hooks-save",
    "hooks-trust",
    "hooks-run-log",
    "hooks-template",
    "usage-agent-filter",
})
KNOWN_ROW_KINDS = frozenset({"workspace", "session", "agent"})
KNOWN_NODE_KINDS = frozenset({"thinking", "tool-call", "text"})
KNOWN_NODE_STATES = frozenset({"running", "completed", "error", "aborted"})
KNOWN_COMPOSER_ZONES = frozenset({"queue", "plan", "attachments", "error", "input", "footer", "stats", "popup"})
KNOWN_LAYER_KINDS = frozenset({"layer", "overlay"})
KNOWN_UI_STATES = frozenset({
    "data-ui-settings-open", "data-ui-workspace-open", "data-ui-chat-empty",
    "data-ui-generating", "data-ui-preview-open", "data-ui-preview-fullscreen",
    "data-ui-permission-pending", "data-ui-question-pending", "data-ui-attachments",
    "data-ui-split-open", "data-ui-design-open", "data-ui-sidebar-collapsed",
    # 话题列表多选模式（批量归档 / 恢复 / 删除），2026-09-28 新增。
    "data-ui-session-multiselect",
})
# 带值（非布尔）的 <html> 状态钩子：存在性之外允许匹配具体取值。
VALUE_UI_STATES = {
    # 侧栏视图：源码取值为 topics | files | archived（archived = 已归档话题屏；
    # agents 是侧栏分页 sidebarTab，不是本属性）。
    "data-ui-sidebar-view": frozenset({"topics", "files", "archived"}),
    "data-ui-density": frozenset({"compact", "comfortable", "relaxed"}),
    "data-ui-radius": frozenset({"square", "small", "medium", "round"}),
    "data-ui-motion": frozenset({"off"}),
}
# 需要取值的钩子 -> 合法取值集合（与 AGENTS.md 的公开契约同步）。
# 未登记的 data-control（rail-topics / rail-search / rail-agents / sidebar-collapse /
# sidebar-expand 等）是侧栏折叠窄条上的实现细节，不在契约内，主题不要依赖。
VALUE_HOOK_ATTRS = {
    "pane": KNOWN_PANES,
    "role": KNOWN_ROLES,
    "control": KNOWN_CONTROLS,
    "row-kind": KNOWN_ROW_KINDS,
    "node-kind": KNOWN_NODE_KINDS,
    "node-state": KNOWN_NODE_STATES,
    "composer-zone": KNOWN_COMPOSER_ZONES,
    "layer-kind": KNOWN_LAYER_KINDS,
}
# 存在性（布尔）钩子：出现即真，不带值匹配。
BOOLEAN_HOOK_ATTRS = frozenset({"row-active", "row-expanded"})
HOOK_ATTR_RE = re.compile(
    r"\[\s*data-(pane|role|control|row-kind|row-active|row-expanded|node-kind|node-state|composer-zone|layer-kind|theme-layer|ui-[a-z-]+)"
    r"(?:\s*([~^|$*]?=)\s*(?:\"([\w-]*)\"|'([\w-]*)'|([\w-]*)))?"
    r"\s*\]"
)


def strip_comments(css: str) -> str:
    return COMMENT_RE.sub("", css)


def selector_modes(selector: str) -> tuple[str, ...]:
    lowered = selector.lower()
    dark = bool(re.search(r"(?:data-theme-effective|data-theme|theme)[^{}]*[=:][\s\"']*dark|\.theme-dark|:not\(\.theme-light\)", lowered))
    light = bool(re.search(r"(?:data-theme-effective|data-theme)[^{}]*[=:][\s\"']*light|\.theme-light", lowered))
    if dark and not light:
        return ("dark",)
    if light and not dark:
        return ("light",)
    return ("light", "dark")


def parse_variables(css: str) -> dict[str, dict[str, str]]:
    variables = {"light": {}, "dark": {}}
    for match in RULE_RE.finditer(strip_comments(css)):
        selector = match.group(1).strip()
        declarations = dict(DECL_RE.findall(match.group(2)))
        if not declarations:
            continue
        modes = selector_modes(selector)
        is_generic = modes == ("light", "dark")
        for mode in modes:
            for name, value in declarations.items():
                # A generic root rule is a fallback. Mode-specific rules win
                # even when a formatter placed the generic rule later.
                if is_generic:
                    variables[mode].setdefault(name, value.strip())
                else:
                    variables[mode][name] = value.strip()
    return variables


def parse_channel(value: str) -> float | None:
    value = value.strip()
    if value.endswith("%"):
        try:
            return max(0.0, min(255.0, float(value[:-1]) * 2.55))
        except ValueError:
            return None
    try:
        return max(0.0, min(255.0, float(value)))
    except ValueError:
        return None


def parse_alpha(value: str) -> float | None:
    value = value.strip()
    if value.endswith("%"):
        try:
            return max(0.0, min(1.0, float(value[:-1]) / 100.0))
        except ValueError:
            return None
    try:
        return max(0.0, min(1.0, float(value)))
    except ValueError:
        return None


def parse_color(value: str) -> tuple[float, float, float, float] | None:
    hex_match = HEX_RE.search(value)
    if hex_match:
        digits = hex_match.group(1)
        if len(digits) in (3, 4):
            digits = "".join(char * 2 for char in digits)
        if len(digits) not in (6, 8):
            return None
        channels = tuple(int(digits[index:index + 2], 16) / 255.0 for index in range(0, 6, 2))
        alpha = int(digits[6:8], 16) / 255.0 if len(digits) == 8 else 1.0
        return (*channels, alpha)

    function = re.search(r"rgba?\(([^)]*)\)", value, re.IGNORECASE)
    if not function:
        return None
    parts = [part for part in re.split(r"\s*[,/]\s*|\s+", function.group(1).strip()) if part]
    if len(parts) < 3:
        return None
    channels = [parse_channel(part) for part in parts[:3]]
    if any(channel is None for channel in channels):
        return None
    alpha = parse_alpha(parts[3]) if len(parts) > 3 else 1.0
    if alpha is None:
        return None
    red, green, blue = (float(channel) / 255.0 for channel in channels)
    return (red, green, blue, alpha)


def resolve_value(name: str, mode: str, variables: dict[str, dict[str, str]], stack: tuple[str, ...] = ()) -> str | None:
    if name in stack:
        return None
    raw = variables[mode].get(name)
    if raw is None:
        return None

    def replace(match: re.Match[str]) -> str:
        variable = match.group(1)
        fallback = match.group(2)
        resolved = resolve_value(variable, mode, variables, (*stack, name))
        if resolved is not None:
            return resolved
        return fallback.strip() if fallback else match.group(0)

    resolved = VAR_RE.sub(replace, raw).strip()
    return resolved if resolved != raw or not VAR_RE.search(raw) else None


def composite(color: tuple[float, float, float, float], background: tuple[float, float, float, float]) -> tuple[float, float, float]:
    alpha = color[3] + background[3] * (1.0 - color[3])
    if alpha <= 0:
        return (0.0, 0.0, 0.0)
    return tuple((color[index] * color[3] + background[index] * background[3] * (1.0 - color[3])) / alpha for index in range(3))


def resolve_color(name: str, mode: str, variables: dict[str, dict[str, str]], background_name: str | None = None) -> tuple[float, float, float] | None:
    value = resolve_value(name, mode, variables)
    if value is None:
        return None
    parsed = parse_color(value)
    if parsed is None:
        return None
    if parsed[3] >= 1.0 or background_name is None:
        return parsed[:3]
    background_value = resolve_color(background_name, mode, variables)
    if background_value is None:
        return None
    return composite(parsed, (*background_value, 1.0))


def channel_luminance(channel: float) -> float:
    return channel / 12.92 if channel <= 0.03928 else ((channel + 0.055) / 1.055) ** 2.4


def contrast(first: tuple[float, float, float], second: tuple[float, float, float]) -> float:
    first_luminance = sum(weight * channel_luminance(channel) for weight, channel in zip((0.2126, 0.7152, 0.0722), first))
    second_luminance = sum(weight * channel_luminance(channel) for weight, channel in zip((0.2126, 0.7152, 0.0722), second))
    lighter, darker = max(first_luminance, second_luminance), min(first_luminance, second_luminance)
    return (lighter + 0.05) / (darker + 0.05)


def check_contrast(variables: dict[str, dict[str, str]], partial: bool = False) -> list[str]:
    errors: list[str] = []
    for mode in ("light", "dark"):
        for foreground, background, target, label in CONTRAST_PAIRS:
            if partial and not (foreground in variables[mode] and background in variables[mode]):
                # 结构主题叠加在内置 token 基底之上；只检查主题实际重定义的组合。
                continue
            foreground_color = resolve_color(foreground, mode, variables, background)
            background_color = resolve_color(background, mode, variables)
            if foreground_color is None or background_color is None:
                errors.append(f"{mode}: 无法解析 {foreground} / {background}（{label}）")
                continue
            value = contrast(foreground_color, background_color)
            if value < target:
                errors.append(f"{mode}: {foreground} 在 {background} 上为 {value:.2f}:1，需要 {target:.1f}:1（{label}）")
    return errors


def declared_layer_names(css: str) -> set[str]:
    return {
        match_object.group(1)
        for rule in RULE_RE.finditer(strip_comments(css))
        for declared, _value in DECL_RE.findall(rule.group(2))
        if (match_object := LAYER_NAME_RE.match(declared))
    }


def check_layers(css: str) -> list[str]:
    errors: list[str] = []
    for match in RULE_RE.finditer(strip_comments(css)):
        for name, _value in DECL_RE.findall(match.group(2)):
            if name.startswith(("--pi-layer-", "--pi-overlay-")) and not LAYER_NAME_RE.match(name):
                errors.append(f"装饰层名必须为小写 [a-z0-9-]：{name}")
    return errors


def check_hooks(css: str, layer_names: set[str]) -> list[str]:
    """按契约名单校验 data-pane / data-role / data-control / data-* 行级与分区钩子、
    data-ui-* 状态钩子、data-theme-layer 装饰层引用，拼写错误无法静默失效。"""
    errors: list[str] = []
    reported: set[str] = set()
    for match in HOOK_ATTR_RE.finditer(strip_comments(css)):
        kind = match.group(1)
        matcher = match.group(2)
        value = next((group for group in match.groups()[2:] if group is not None), None)
        token = f"{kind}:{value}:{bool(matcher)}"
        if token in reported:
            continue
        reported.add(token)
        if kind in VALUE_HOOK_ATTRS:
            known = VALUE_HOOK_ATTRS[kind]
            if not matcher or not value:
                errors.append(f"[data-{kind}] 钩子必须带取值；合法取值：{', '.join(sorted(known))}")
            elif value not in known:
                errors.append(f"未知的 data-{kind} 取值 \"{value}\"；合法取值：{', '.join(sorted(known))}")
        elif kind in BOOLEAN_HOOK_ATTRS:
            if matcher:
                errors.append(f"[data-{kind}] 为存在性钩子，不要匹配具体值")
        elif kind.startswith("ui-"):
            attribute = f"data-{kind}"
            if attribute in VALUE_UI_STATES:
                allowed = VALUE_UI_STATES[attribute]
                if not matcher or not value:
                    errors.append(f"[{attribute}] 为带值状态钩子，必须匹配取值：{', '.join(sorted(allowed))}")
                elif value not in allowed:
                    errors.append(f"未知的 [{attribute}] 取值 \"{value}\"；合法取值：{', '.join(sorted(allowed))}")
            else:
                if attribute not in KNOWN_UI_STATES:
                    errors.append(f"未知的状态钩子 [{attribute}]；合法钩子：{', '.join(sorted(KNOWN_UI_STATES))}")
                elif matcher:
                    errors.append(f"[{attribute}] 为存在性钩子，不要匹配具体值")
        elif kind == "theme-layer":
            if not matcher or not value:
                errors.append("[data-theme-layer] 钩子必须带取值（装饰层名）")
            elif value not in layer_names:
                errors.append(f'data-theme-layer="{value}" 未声明对应的 --pi-layer-<name> / --pi-overlay-<name> 装饰层')
    return errors


def check_pitfalls(css: str) -> list[str]:
    """结构主题常见陷阱的启发式警告（不阻断通过）。"""
    warnings: list[str] = []
    stripped = strip_comments(css)
    for match in RULE_RE.finditer(stripped):
        selector = match.group(1).strip()
        declarations = match.group(2)
        if re.search(r"\[data-pane=[^\]]+\]\s*>\s*\*", selector) and \
                re.search(r"(?:^|;)\s*position\s*:", declarations):
            warnings.append(
                f"{selector}: 对区域内全体子项设置 position 会把绝对定位浮层"
                "（附件预览/错误条/菜单）改成流内元素——只对排布分区或明确的流内子项抬层级"
            )
        if "[data-pane=\"composer\"]" in selector and "::" not in selector:
            min_match = re.search(r"min-height\s*:\s*(\d+)", declarations)
            if min_match and float(min_match.group(1)) > 160:
                warnings.append(
                    "composer: 大 min-height 会让网格 minmax(32px, 1fr) 行吃满富余空间"
                    "（textarea 与工具栏之间出现空白）；输入框应保持内容驱动"
                )
        # 区域作用域覆写 --panel-bg 而未按面声明 --panel-bg-*：新契约下该面
        # 不生效（旧契约才生效），是"面板色块错误"的经典来源。
        pane_match = re.search(r"\[data-pane=\"([a-z-]+)\"\]", selector)
        if pane_match and re.search(r"(?:^|;)\s*--panel-bg\s*:", declarations):
            pane = pane_match.group(1)
            # 只有这五面在壁纸模式下读 --panel-bg-* 分解 token。其余区域（含
            # question-panel / task-panel / memory-panel —— 它们读 --surface）
            # 覆写 --panel-bg 只会波及区域内读该 token 的子控件。
            expected = {
                "sidebar": "--panel-bg-sidebar",
                "topbar": "--panel-bg-topbar",
                "composer": "--panel-bg-composer",
                "settings-dialog": "--panel-bg-dialog",
                "permission-dialog": "--panel-bg-dialog",
                "preview": "--panel-bg-preview",
            }.get(pane)
            if expected and not re.search(rf"{expected}\s*:", declarations):
                warnings.append(
                    f"[data-pane=\"{pane}\"] 仅覆写了 --panel-bg：壁纸模式下该面底色读 "
                    f"{expected}（应同时/改用该面 token）；若仅兼容旧包请双值同声明"
                )
            elif expected is None:
                warnings.append(
                    f"[data-pane=\"{pane}\"] 覆写 --panel-bg 影响区域内所有读该 token 的"
                    "子控件底色；该区域在壁纸模式下无对应面 token（question-panel / task-panel /"
                    " memory-panel 的面底色走 --surface），请确认确有把握"
                )
    return warnings


def check_border_image(css: str, css_path: Path, allow_missing: bool) -> list[str]:
    """border-image-slice 数值必须落在素材尺寸内（Pillow 读取图片尺寸）。"""
    errors: list[str] = []
    try:
        from PIL import Image  # noqa: PLC0415
    except ImportError:
        return errors
    for match in RULE_RE.finditer(strip_comments(css)):
        declarations = match.group(2)
        slice_match = re.search(r"border-image-slice\s*:\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s+fill)?", declarations, re.IGNORECASE)
        source_match = re.search(r"border-image-source\s*:\s*url\(\s*(['\"]?)([^'\")]+)\1\s*\)", declarations, re.IGNORECASE)
        if not slice_match or not source_match:
            continue
        reference = source_match.group(2).strip()
        if re.match(r"(?:data:|https?:|file:|blob:|#|var\()", reference, re.IGNORECASE):
            continue
        image_path = css_path.parent / reference
        if allow_missing or not image_path.is_file():
            continue
        try:
            with Image.open(image_path) as image:
                width, height = image.size
        except Exception:  # noqa: BLE001 - 非图片文件跳过
            continue
        top, right, bottom, left = (float(part) for part in slice_match.groups())
        if left + right > width:
            errors.append(f"{reference}: border-image-slice 左右 {left}+{right} 超出素材宽度 {width}")
        if top + bottom > height:
            errors.append(f"{reference}: border-image-slice 上下 {top}+{bottom} 超出素材高度 {height}")
    return errors


def check_assets(css: str, css_path: Path, allow_missing: bool) -> list[str]:
    errors: list[str] = []
    for match in URL_RE.finditer(strip_comments(css)):
        reference = match.group(2).strip()
        if not reference or reference.lower() in ("none",) or re.match(r"(?:data:|https?:|file:|blob:|#|var\()", reference, re.IGNORECASE):
            continue
        if "base64" in reference.lower():
            errors.append("壁纸/图片 URL 内嵌了 base64 数据；请在 CSS 中保留相对路径并单独导入图片文件")
        elif not allow_missing and not (css_path.parent / reference).is_file():
            errors.append(f"相对路径资产不存在：{reference}")
    return errors


def check_theme(path: Path, allow_missing_assets: bool) -> tuple[list[str], list[str]]:
    css = path.read_text(encoding="utf-8")
    # The type marker lives in a header comment, so match the raw text (comment
    # stripping would remove it).
    structural = bool(STRUCTURAL_TYPE_RE.search(css))
    variables = parse_variables(css)
    errors: list[str] = []
    if structural:
        errors.extend(check_contrast(variables, partial=True))
    else:
        for mode in ("light", "dark"):
            missing = [name for name in EXPECTED_VARIABLES if name not in variables[mode]]
            if missing:
                errors.append(f"{mode}: 缺少 {len(missing)} 个变量：{', '.join(missing)}")
        errors.extend(check_contrast(variables))
    errors.extend(check_layers(css))
    errors.extend(check_hooks(css, declared_layer_names(css)))
    errors.extend(check_border_image(css, path, allow_missing_assets))
    if re.search(r"color-mix\s*\(", css, re.IGNORECASE):
        errors.append("主题使用了 color-mix()；请输出最终的 rgb()/rgba()/hex 值以保证内嵌 Chromium 兼容")
    errors.extend(check_assets(css, path, allow_missing_assets))
    return errors, check_pitfalls(css)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="校验一份 PiDesktop 主题 CSS 文件。")
    parser.add_argument("theme", type=Path, help="主题 CSS 路径")
    parser.add_argument("--allow-missing-assets", action="store_true", help="相对路径壁纸文件不在 CSS 旁时不报错")
    args = parser.parse_args(argv)

    if not args.theme.is_file():
        print(f"[错误] CSS 文件不存在：{args.theme}", file=sys.stderr)
        return 2
    try:
        errors, warnings = check_theme(args.theme, args.allow_missing_assets)
    except UnicodeDecodeError as error:
        print(f"[错误] CSS 必须为 UTF-8 编码：{error}", file=sys.stderr)
        return 2
    for warning in warnings:
        print(f"[警告] {warning}")
    if errors:
        for error in errors:
            print(f"[错误] {error}")
        return 1
    if STRUCTURAL_TYPE_RE.search(args.theme.read_text(encoding="utf-8")):
        print(f"[通过] {args.theme}: 结构主题，已定义颜色对对比度、装饰层名与可移植性检查全部通过")
    else:
        print(f"[通过] {args.theme}: 每种模式 {len(EXPECTED_VARIABLES)} 个变量，对比度与可移植性检查全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
