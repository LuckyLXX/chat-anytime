import type { SessionRunStatus, ThinkingLevel } from "./protocol.js";

export const thinkingLevelLabels: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高"
};

export const sessionRunStatusLabels: Record<SessionRunStatus, string> = {
  running: "执行中",
  completed: "执行完成",
  failed: "执行失败"
};

const toolLabels: Record<string, string> = {
  read: "读取文件",
  bash: "执行命令",
  powershell: "执行 PowerShell",
  edit: "编辑文件",
  write: "写入文件",
  grep: "搜索内容",
  find: "查找文件",
  ls: "列出目录",
  ask_question: "向用户提问",
  todo_write: "更新任务清单",
  memory_write: "写入长期记忆",
  memory_read: "读取长期记忆",
  memory_list: "列出长期记忆",
  memory_search: "检索长期记忆",
  memory_delete: "删除长期记忆",
  recognize_images: "识别图片",
  browser_navigate: "浏览器导航",
  browser_snapshot: "浏览器页面快照",
  browser_click: "浏览器点击",
  browser_type: "浏览器输入",
  browser_press: "浏览器按键",
  browser_scroll: "浏览器滚动",
  browser_eval: "浏览器执行脚本",
  browser_screenshot: "浏览器截图",
  browser_wait: "浏览器等待",
  browser_get: "浏览器读取信息",
  browser_select: "浏览器下拉选择",
  browser_upload: "浏览器上传文件",
  browser_screenshot_full: "浏览器整页截图",
  browser_tabs: "浏览器标签页"
};

export function toolLabel(name: string): string {
  return toolLabels[name] ?? name;
}
