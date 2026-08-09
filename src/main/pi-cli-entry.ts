import { runPiCliHost } from "./pi-cli-host.js";

function exitAfterFlush(code: number): void {
  process.exitCode = code;
  // Electron's run-as-node mode may tear down without honoring only
  // process.exitCode. Flush both pipes before explicitly exiting so the last
  // JSON frame and diagnostic are not truncated.
  process.stdout.write("", () => {
    process.stderr.write("", () => process.exit(code));
  });
}

void runPiCliHost().then((code) => {
  exitAfterFlush(code);
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exitAfterFlush(1);
});
