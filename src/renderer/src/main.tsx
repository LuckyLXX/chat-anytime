import React from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
import { App } from "./App";
import "./styles.css";

/**
 * 演示 API 只在浏览器（无 Electron preload）里使用。做成动态 import，桌面端
 * 首包不再包含 80KB+ 的 mock 数据与命令分支；桌面启动少解析一个模块。
 */
async function boot(): Promise<void> {
  if (import.meta.env.DEV) {
    void import("./lib/perf-telemetry").then((module) => module.startPerfTelemetry()).catch(() => undefined);
  }
  if (!window.piDesktop) {
    const { createDemoApi } = await import("./demo-api");
    window.piDesktop = createDemoApi();
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void boot();
