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
  edit: "编辑文件",
  write: "写入文件",
  grep: "搜索内容",
  find: "查找文件",
  ls: "列出目录"
};

export function toolLabel(name: string): string {
  return toolLabels[name] ?? name;
}
