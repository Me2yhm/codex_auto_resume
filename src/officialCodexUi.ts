import * as vscode from "vscode";
import {
  CodexTurnStartOverrides,
  CodexUiIpcClient,
  readCodexUiIpcVersions,
} from "./codexUiIpc";

export async function sendTurnThroughOfficialCodexUi(
  threadId: string,
  prompt: string,
  output: vscode.OutputChannel,
  logPrefix: string,
  overrides: CodexTurnStartOverrides = {},
): Promise<boolean> {
  await surfaceOfficialCodexThread(threadId, output, logPrefix);

  const versions = readCodexUiIpcVersions(output);
  const ipc = new CodexUiIpcClient(output);
  try {
    await ipc.connect();
    let ownerClientId: string | undefined;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      ownerClientId = await ipc.discoverOwner(threadId, versions.ownerDiscovery);
      output.appendLine(`[${logPrefix}] owner discovery ${attempt}/5: ${ownerClientId ?? "<none>"}`);
      if (ownerClientId) break;
      await delay(1_000);
    }
    if (!ownerClientId) return false;
    await ipc.startTurn(threadId, prompt, versions, ownerClientId, overrides);
    return true;
  } finally {
    ipc.dispose();
  }
}


export async function trySendTurnThroughExistingOfficialOwner(
  threadId: string,
  prompt: string,
  output: vscode.OutputChannel,
  logPrefix: string,
  overrides: CodexTurnStartOverrides = {},
): Promise<boolean> {
  let ownerClientId: string | undefined;
  let ipc: CodexUiIpcClient | undefined;

  try {
    const versions = readCodexUiIpcVersions(output);
    ipc = new CodexUiIpcClient(output);
    await ipc.connect();
    ownerClientId = await ipc.discoverOwner(threadId, versions.ownerDiscovery);
    output.appendLine(
      `[${logPrefix}] silent owner discovery: ${ownerClientId ?? "<none>"}`,
    );
    if (!ownerClientId) return false;
    await ipc.startTurn(threadId, prompt, versions, ownerClientId, overrides);
    return true;
  } catch (error) {
    if (ownerClientId) throw error;
    output.appendLine(
      `[${logPrefix}] silent owner discovery unavailable: ${(error as Error).message}; trying the direct writer path`,
    );
    return false;
  } finally {
    ipc?.dispose();
  }
}

export async function surfaceOfficialCodexThread(
  threadId: string,
  output: vscode.OutputChannel,
  logPrefix: string,
): Promise<void> {
  output.appendLine(`[${logPrefix}] surfacing official Codex thread ${threadId}`);

  try {
    await vscode.commands.executeCommand("chatgpt.openSidebar", { threadId });
  } catch (error) {
    output.appendLine(
      `[${logPrefix}] chatgpt.openSidebar(threadId) failed: ${(error as Error).message}; falling back to plain openSidebar`,
    );
    await vscode.commands.executeCommand("chatgpt.openSidebar");
  }

  try {
    const route = vscode.Uri.file(`/local/${threadId}`).with({
      scheme: "openai-codex",
      authority: "route",
    });
    await vscode.commands.executeCommand("vscode.openWith", route, "chatgpt.conversationEditor");
    output.appendLine(`[${logPrefix}] mounted target thread through chatgpt.conversationEditor`);
  } catch (error) {
    output.appendLine(
      `[${logPrefix}] exact-thread custom editor mount unavailable: ${(error as Error).message}; continuing with sidebar owner discovery`,
    );
  }

  await delay(1_500);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
