import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export function resolveCodexExecutable(output: vscode.OutputChannel): string {
  const configured = vscode.workspace
    .getConfiguration("codexAutoResume")
    .get<string>("codexCommand", "")
    .trim();

  if (configured) return configured;

  const chatgpt = vscode.extensions.getExtension("openai.chatgpt");
  if (!chatgpt) {
    throw new Error("Official Codex VS Code extension (openai.chatgpt) is not installed.");
  }

  const platformDir = process.platform === "win32"
    ? "windows-x86_64"
    : process.platform === "darwin"
      ? process.arch === "arm64" ? "macos-aarch64" : "macos-x86_64"
      : process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64";

  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  const candidate = path.join(chatgpt.extensionPath, "bin", platformDir, executable);

  if (!fs.existsSync(candidate)) {
    throw new Error(`Bundled Codex executable not found at ${candidate}`);
  }

  output.appendLine(`Using Codex executable: ${candidate}`);
  return candidate;
}
