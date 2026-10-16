import * as vscode from "vscode";
import { AutoResumeController } from "./autoResumeController";
import { diagnoseOfficialCodex } from "./diagnostics";
import { redactedOutputChannel } from "./diagnosticRedaction";
import { QuotaPrimerController } from "./quotaPrimerController";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = redactedOutputChannel(vscode.window.createOutputChannel("Codex Auto Resume"));
  const controller = new AutoResumeController(context, output);
  const quotaPrimer = new QuotaPrimerController(context, output);

  context.subscriptions.push(
    output,
    controller,
    quotaPrimer,
    vscode.commands.registerCommand("codexAutoResume.enable", () => controller.enable()),
    vscode.commands.registerCommand("codexAutoResume.disable", () => controller.disable()),
    vscode.commands.registerCommand("codexAutoResume.status", () => controller.showStatus()),
    vscode.commands.registerCommand("codexAutoResume.inspectRecoveryInput", () => controller.inspectRecoveryInput()),
    vscode.commands.registerCommand("codexAutoResume.reviewRecoveryInput", () => controller.reviewRecoveryInput()),
    vscode.commands.registerCommand("codexAutoResume.resumeNow", () => controller.resumeNow()),
    vscode.commands.registerCommand("codexAutoResume.testOfficialSubmitBridge", () => controller.testOfficialSubmitBridge()),
    vscode.commands.registerCommand("codexAutoResume.testOfficialUiIpcBridge", () => controller.testOfficialUiIpcBridge()),
    vscode.commands.registerCommand("codexAutoResume.diagnoseOfficialCodex", () => diagnoseOfficialCodex(output)),
    vscode.commands.registerCommand("codexAutoResume.quotaPrimer.enable", () => quotaPrimer.enable()),
    vscode.commands.registerCommand("codexAutoResume.quotaPrimer.disable", () => quotaPrimer.disable()),
    vscode.commands.registerCommand("codexAutoResume.quotaPrimer.status", () => quotaPrimer.showStatus()),
    vscode.commands.registerCommand("codexAutoResume.quotaPrimer.primeNow", () => quotaPrimer.primeNow()),
    vscode.commands.registerCommand("codexAutoResume.quotaPrimer.resetThread", () => quotaPrimer.resetPrimerThread()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexAutoResume")) {
        void controller.start();
        void quotaPrimer.start();
      }
    }),
  );

  await controller.start();
  await quotaPrimer.start();
}

export function deactivate(): void {
  // Disposables registered in ExtensionContext are cleaned up by VS Code.
}
