import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default {
  root: resolve("src/renderer"),
  plugins: [react()],
  server: { port: 5199, strictPort: true }
};
