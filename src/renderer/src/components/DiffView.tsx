import { type ReactNode } from "react";

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-remove";
  return "diff-context";
}

export function DiffView({ patch }: { patch: string }): ReactNode {
  return (
    <pre className="diff-view">
      {patch.split("\n").map((line, index) => (
        <span className={lineClass(line)} key={`${index}-${line.slice(0, 20)}`}>{line || " "}{"\n"}</span>
      ))}
    </pre>
  );
}
