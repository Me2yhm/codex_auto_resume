import * as vscode from "vscode";

interface CommandContribution {
  command?: string;
  title?: string;
  category?: string;
}

export async function diagnoseOfficialCodex(output: vscode.OutputChannel): Promise<void> {
  output.show(true);
  output.appendLine("=== Official Codex extension diagnostics ===");

  const extension = vscode.extensions.getExtension("openai.chatgpt");
  if (!extension) {
    output.appendLine("openai.chatgpt: NOT INSTALLED");
    return;
  }

  const packageJson = extension.packageJSON as {
    version?: string;
    extensionKind?: unknown;
    contributes?: { commands?: CommandContribution[] };
  };

  output.appendLine(`id: ${extension.id}`);
  output.appendLine(`version: ${packageJson.version ?? "unknown"}`);
  output.appendLine(`extensionPath: ${extension.extensionPath}`);
  output.appendLine(`isActive before diagnose: ${extension.isActive}`);
  output.appendLine(`declared extensionKind: ${JSON.stringify(packageJson.extensionKind ?? null)}`);

  const contributed = packageJson.contributes?.commands ?? [];
  output.appendLine("\nContributed commands from openai.chatgpt package.json:");
  if (contributed.length === 0) {
    output.appendLine("  (none declared)");
  } else {
    for (const item of contributed) {
      output.appendLine(`  ${item.command ?? "<missing-id>"} :: ${item.title ?? "<missing-title>"}`);
    }
  }

  try {
    const api = extension.isActive ? extension.exports : await extension.activate();
    output.appendLine("\nExtension exports:");
    if (api === undefined || api === null) {
      output.appendLine("  (no public exports)");
    } else if (typeof api === "object") {
      const keys = Object.keys(api as Record<string, unknown>);
      output.appendLine(keys.length > 0 ? `  keys: ${keys.join(", ")}` : "  (object with no enumerable keys)");
    } else {
      output.appendLine(`  type: ${typeof api}`);
    }
  } catch (error) {
    output.appendLine(`\nFailed to activate/read exports: ${(error as Error).message}`);
  }

  const registered = await vscode.commands.getCommands(true);
  const relevant = registered
    .filter((id) => /codex|chatgpt|openai/i.test(id))
    .sort((a, b) => a.localeCompare(b));

  output.appendLine("\nRegistered command IDs containing codex/chatgpt/openai:");
  if (relevant.length === 0) {
    output.appendLine("  (none)");
  } else {
    for (const id of relevant) output.appendLine(`  ${id}`);
  }

  output.appendLine("=== End diagnostics ===");
}
