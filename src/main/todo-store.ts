import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Todo, TodoStatus } from "../shared/protocol.js";

/**
 * JSON-backed Todo store (atomic tmp+rename). Lives at
 * `<agentDir>/pidesktop-todos.json`. Both the agent (via customTools) and the
 * UI (via the `todo.*` commands) mutate through this store; every mutation
 * fires `onChanged` so the runtime can broadcast the fresh list to the
 * renderer.
 */

interface TodoFile {
  todos: Todo[];
}

export interface TodoStore {
  list(): Todo[];
  create(title: string, notes?: string): Todo;
  update(id: string, patch: { title?: string; notes?: string; status?: TodoStatus }): Todo | undefined;
  remove(id: string): boolean;
}

function normalizeTodo(value: unknown): Todo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const todo = value as Record<string, unknown>;
  if (typeof todo.id !== "string" || typeof todo.title !== "string" || typeof todo.status !== "string") return undefined;
  const now = Date.now();
  return {
    id: todo.id,
    title: todo.title,
    status: todo.status as TodoStatus,
    ...(typeof todo.notes === "string" && todo.notes ? { notes: todo.notes } : {}),
    createdAt: typeof todo.createdAt === "number" ? todo.createdAt : now,
    updatedAt: typeof todo.updatedAt === "number" ? todo.updatedAt : now,
    ...(typeof todo.completedAt === "number" ? { completedAt: todo.completedAt } : {})
  };
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

  function commit(mutate: (todos: Todo[]) => void): void {
    const file = readFile();
    mutate(file.todos);
    writeFile(file);
    onChanged();
  }

  return {
    list(): Todo[] {
      return readFile().todos.sort((left, right) => left.createdAt - right.createdAt);
    },
    create(title: string, notes?: string): Todo {
      const now = Date.now();
      const todo: Todo = {
        id: randomUUID(),
        title: title.trim(),
        status: "pending",
        ...(notes?.trim() ? { notes: notes.trim() } : {}),
        createdAt: now,
        updatedAt: now
      };
      commit((todos) => { todos.push(todo); });
      return todo;
    },
    update(id: string, patch: { title?: string; notes?: string; status?: TodoStatus }): Todo | undefined {
      let updated: Todo | undefined;
      commit((todos) => {
        const index = todos.findIndex((todo) => todo.id === id);
        if (index < 0) return;
        const current = todos[index]!;
        const next: Todo = { ...current, updatedAt: Date.now() };
        if (typeof patch.title === "string" && patch.title.trim()) next.title = patch.title.trim();
        if (patch.notes !== undefined) {
          if (patch.notes.trim()) next.notes = patch.notes.trim();
          else delete next.notes;
        }
        if (patch.status && patch.status !== current.status) {
          next.status = patch.status;
          if (patch.status === "completed") next.completedAt = Date.now();
          else delete next.completedAt;
        }
        todos[index] = next;
        updated = next;
      });
      return updated;
    },
    remove(id: string): boolean {
      let removed = false;
      commit((todos) => {
        const index = todos.findIndex((todo) => todo.id === id);
        if (index >= 0) { todos.splice(index, 1); removed = true; }
      });
      return removed;
    }
  };
}
