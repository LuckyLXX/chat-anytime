import { describe, expect, it } from "vitest";
import { guessCodeLanguage, isPlainTextLabel, languageFromClassName, resolveCodeLanguage } from "./code-language";

describe("code language resolution", () => {
  it("resolves plain ids and the aliases models actually write", () => {
    // hljs 自己已认的 id / 别名（ts、typescript 都是合法入参）原样返回
    expect(resolveCodeLanguage("ts")).toBe("ts");
    expect(resolveCodeLanguage("typescript")).toBe("typescript");
    // 我们自己的别名表把非 hljs 写法归一
    expect(resolveCodeLanguage("sh")).toBe("bash");
    expect(resolveCodeLanguage("shell")).toBe("bash");
    expect(resolveCodeLanguage("ps1")).toBe("powershell");
    expect(resolveCodeLanguage("pwsh")).toBe("powershell");
    // common 子集里没有的语言由 code-language 自己注册（模型真在用）
    expect(resolveCodeLanguage("dockerfile")).toBe("dockerfile");
    expect(resolveCodeLanguage("env")).toBe("properties");
    expect(resolveCodeLanguage("jsonc")).toBe("jsonc");
    // 标记语言别名：工具条显示作者写的 html，高亮走 xml 语法
    expect(resolveCodeLanguage("html")).toBe("xml");
    expect(resolveCodeLanguage("vue")).toBe("xml");
  });

  it("keeps unknown languages and plain-text labels out of highlighting", () => {
    expect(resolveCodeLanguage("acceptance-report")).toBe("");
    expect(resolveCodeLanguage("")).toBe("");
    expect(resolveCodeLanguage(undefined)).toBe("");
    // ```text / ```log 是作者明说「纯文本」，既不猜也不着色
    expect(resolveCodeLanguage("text")).toBe("");
    expect(isPlainTextLabel("text")).toBe(true);
    expect(isPlainTextLabel("log")).toBe(true);
    expect(isPlainTextLabel("")).toBe(false);
    expect(isPlainTextLabel("ts")).toBe(false);
  });

  it("reads the class-name variants models put on <code>", () => {
    expect(languageFromClassName("language-js")).toBe("js");
    expect(languageFromClassName("lang-js")).toBe("js");
    expect(languageFromClassName("hljs language-python")).toBe("python");
    expect(languageFromClassName("highlight-source-go")).toBe("go");
    expect(languageFromClassName("brush: sql")).toBe("sql");
    // 裸类名本身就是语言名时也认
    expect(languageFromClassName("js")).toBe("js");
    // GitHub 的裸 hljs 类名不含语言信息
    expect(languageFromClassName("hljs")).toBe("");
    expect(languageFromClassName(undefined)).toBe("");
  });

  it("guesses only the unmistakable shapes", () => {
    expect(guessCodeLanguage("$ grep exposure ~/.pi/agent/mcp.json\n  \"exposure\": \"hidden\",")).toBe("bash");
    expect(guessCodeLanguage("#!/bin/bash\nset -e\necho hi")).toBe("bash");
    expect(guessCodeLanguage("PS C:\\dev> npm run build")).toBe("powershell");
    expect(guessCodeLanguage('{\n  "name": "chat-anytime",\n  "version": "1.10.0"\n}')).toBe("json");
    expect(guessCodeLanguage("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b")).toBe("diff");
    expect(guessCodeLanguage("SELECT id, name FROM sessions WHERE id = 1;")).toBe("sql");
    expect(guessCodeLanguage("<!DOCTYPE html>\n<html><body>x</body></html>")).toBe("xml");
  });

  it("never guesses on prose, logs or near-miss shapes", () => {
    // 真实样本：之前 highlightAuto 会把这三类判成 scss / perl / kotlin
    expect(guessCodeLanguage("Test Files  262 passed (262)\n     Tests  2973 passed (2973)\n  ✓ built in 22.35s")).toBe("");
    expect(guessCodeLanguage("这是一段中文说明文字，没有代码内容。\n第二行也是普通文字。")).toBe("");
    expect(guessCodeLanguage("Note that this change only affects the renderer process.")).toBe("");
    // 带注释的 JSONC parse 不过，不硬猜
    expect(guessCodeLanguage('{\n  "a": 1 // 注释\n}')).toBe("");
    // 片段式 HTML 不猜（气泡正文里到处都是标签，猜成 xml 只会满屏错色）
    expect(guessCodeLanguage('<div class="card">标题</div>')).toBe("");
    // jQuery 风格 `$(...)` 不是 shell 提示符
    expect(guessCodeLanguage("$(document).ready(function () {\n  run();\n});")).toBe("");
  });
});
