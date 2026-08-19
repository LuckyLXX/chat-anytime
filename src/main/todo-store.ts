import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Todo, TodoStatus } from "../shared/protocol.js";

/**
 * JSON-backed Todo store (atomic tmp+rename), session-scoped at
 * `chatanytime-sessions/<agentId>/todos/<sessionId>.json`. dsh 式整表替换
 * 语义：清单归模型单一所有，`todo_write` 每次整体覆盖，UI 只读渲染；
 * 每次写入触发 `onChanged` 把最新列表广播给渲染端。
 */

interface TodoFile {
  todos: Todo[];
}

export interface TodoStore {
  list(): Todo[];
  replaceAll(items: readonly Todo[]): void;
}

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

/**
 * 读取时归一化磁盘形状。接受当前 `{content, status}`；也接受旧版
 * `{id, title, notes?, status}`（title/notes 合并进 content），让既有会话
 * 文件与 legacy 全局文件迁移后仍可读。
 */
function normalizeTodo(value: unknown): Todo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const todo = value as Record<string, unknown>;
  const status = STATUSES.find((candidate) => candidate === todo.status);
  if (!status) return undefined;
  if (typeof todo.content === "string" && todo.content.trim()) {
    return { content: todo.content.trim(), status };
  }
  if (typeof todo.title === "string" && todo.title.trim()) {
    const notes = typeof todo.notes === "string" && todo.notes.trim() ? `（${todo.notes.trim()}）` : "";
    return { content: `${todo.title.trim()}${notes}`, status };
  }
  return undefined;
}

/**
 * One-time upgrade from the pre-session-scoped global file: seed a fresh
 * session-scoped store from it, then rename the legacy file so its todos are
 * never inherited by a second session. No-op when the legacy file is missing
 * or corrupt, or the session already has its own todo file.
 */
export function migrateLegacyTodoFile(targetPath: string, legacyPath: string): void {
  try {
    if (existsSync(targetPath)) return;
    const raw = readFileSync(legacyPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { todos?: unknown }).todos)) return;
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, raw, "utf8");
    renameSync(legacyPath, `${legacyPath}.migrated`);
  } catch {
    // missing/corrupt legacy file → nothing to migrate
  }
}

export function createTodoStore(filePath: string, onChanged: () => void): TodoStore {
  function readFile(): TodoFile {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { todos?: unknown }).todos)) {
        const todos = (parsed as { todos: unknown[] }).todos.map(normalizeTodo).filter((todo): todo is Todo => Boolean(todo));
        return { todos };
      }
    } catch {
      // missing/corrupt file → start empty
    }
    return { todos: [] };
  }

  function writeFile(file: TodoFile): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tempPath, filePath);
  }

  return {
    list(): Todo[] {
      return readFile().todos;
    },
    replaceAll(items: readonly Todo[]): void {
      writeFile({ todos: items.map((item) => ({ content: item.content.trim(), status: item.status })) });
      onChanged();
    }
  };
}
