/// <reference types="vite/client" />

import type { DesktopApi } from "../../shared/protocol";

declare global {
  interface Window {
    piDesktop: DesktopApi;
  }
}

export {};
