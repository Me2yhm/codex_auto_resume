import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export async function addTextToOfficialCodexThread(
  text: string,
  output: vscode.OutputChannel,
): Promise<vscode.Uri> {
  const dir = path.join(os.homedir(), ".codex", ".tmp");
  const dirUri = vscode.Uri.file(dir);
  await vscode.workspace.fs.createDirectory(dirUri);

  const fileName = `codex-auto-resume-${Date.now()}-${Math.random().toString(16).slice(2)}.md`;
  const fileUri = vscode.Uri.file(path.join(dir, fileName));
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(text));

  const document = await vscode.workspace.openTextDocument(fileUri);
  const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  const lastLine = Math.max(0, document.lineCount - 1);
  const end = document.lineAt(lastLine).range.end;
  editor.selection = new vscode.Selection(new vscode.Position(0, 0), end);

  output.appendLine(`[bridge] injecting test text through chatgpt.addToThread using ${fileUri.fsPath}`);
  await vscode.commands.executeCommand("chatgpt.addToThread");
  return fileUri;
}

export async function tryNativeChatSubmit(output: vscode.OutputChannel): Promise<void> {
  output.appendLine("[bridge] executing workbench.action.chat.submit");
  await vscode.commands.executeCommand("workbench.action.chat.submit");
}
