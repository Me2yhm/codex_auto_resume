import * as vscode from "vscode";
import { AutoResumeController } from "./autoResumeController";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Codex Auto Resume");
  const controller = new AutoResumeController(context, output);

  context.subscriptions.push(
    output,
    controller,
    vscode.commands.registerCommand("codexAutoResume.enable", () => controller.enable()),
    vscode.commands.registerCommand("codexAutoResume.disable", () => controller.disable()),
    vscode.commands.registerCommand("codexAutoResume.status", () => controller.showStatus()),
    vscode.commands.registerCommand("codexAutoResume.resumeNow", () => controller.resumeNow()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexAutoResume")) {
        void controller.start();
      }
    }),
  );

  await controller.start();
}

export function deactivate(): void {
  // Disposables registered in ExtensionContext are cleaned up by VS Code.
}
