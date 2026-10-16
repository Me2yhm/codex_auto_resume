import type * as vscode from "vscode";

/** Diagnostics may contain upstream errors; never echo URLs or credential values. */
export function redactDiagnostic(message: string): string {
  return message
    .replace(/\b((?:set-)?cookie|authorization)\s*:\s*[^\r\n]+/gi, "$1: [redacted]")
    .replace(/\b(?:https?|socks(?:4|5)?h?):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b([a-z0-9_]*(?:token|api_?key|secret|password)|authorization|cookie|set-cookie)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1=[redacted]");
}

/** Preserve the VS Code channel's receiver and lifecycle for every method. */
export function redactedOutputChannel(output: vscode.OutputChannel): vscode.OutputChannel {
  const textMethods = new Set(["append", "appendLine", "replace"]);
  return new Proxy(output, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (textMethods.has(String(property))) return (message: string) => value.call(target, redactDiagnostic(message));
      return value.bind(target);
    },
  });
}
