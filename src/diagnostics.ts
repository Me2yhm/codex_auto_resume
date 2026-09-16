import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

interface CommandContribution {
  command?: string;
  title?: string;
  category?: string;
}

interface CodexPackageJson {
  version?: string;
  main?: string;
  extensionKind?: unknown;
  contributes?: { commands?: CommandContribution[] };
}

export async function diagnoseOfficialCodex(output: vscode.OutputChannel): Promise<void> {
  output.show(true);
  output.appendLine("=== Official Codex extension diagnostics ===");

  const extension = vscode.extensions.getExtension("openai.chatgpt");
  if (!extension) {
    output.appendLine("openai.chatgpt: NOT INSTALLED");
    return;
  }

  const packageJson = extension.packageJSON as CodexPackageJson;

  output.appendLine(`id: ${extension.id}`);
  output.appendLine(`version: ${packageJson.version ?? "unknown"}`);
  output.appendLine(`extensionPath: ${extension.extensionPath}`);
  output.appendLine(`main: ${packageJson.main ?? "unknown"}`);
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
  printCommands(
    output,
    "Registered command IDs containing codex/chatgpt/openai:",
    registered.filter((id) => /codex|chatgpt|openai/i.test(id)),
  );
  printCommands(
    output,
    "Registered command IDs that look like submit/send/chat actions:",
    registered.filter((id) => /submit|send|acceptinput|chat\./i.test(id)),
  );

  inspectInstalledBundle(extension.extensionPath, packageJson.main, output);

  output.appendLine("=== End diagnostics ===");
}

function printCommands(output: vscode.OutputChannel, title: string, commands: string[]): void {
  output.appendLine(`\n${title}`);
  const sorted = [...new Set(commands)].sort((a, b) => a.localeCompare(b));
  if (sorted.length === 0) {
    output.appendLine("  (none)");
    return;
  }
  for (const id of sorted) output.appendLine(`  ${id}`);
}

function inspectInstalledBundle(extensionPath: string, main: string | undefined, output: vscode.OutputChannel): void {
  output.appendLine("\nInstalled Codex bundle inspection:");
  if (!main) {
    output.appendLine("  package.json has no main entry; skipping bundle scan.");
    return;
  }

  const mainPath = path.resolve(extensionPath, main);
  output.appendLine(`  mainPath: ${mainPath}`);
  if (!fs.existsSync(mainPath)) {
    output.appendLine("  main bundle does not exist.");
    return;
  }

  let source: string;
  try {
    source = fs.readFileSync(mainPath, "utf8");
  } catch (error) {
    output.appendLine(`  failed to read bundle: ${(error as Error).message}`);
    return;
  }

  const probes = [
    "chatgpt.addToThread",
    "chatgpt.addFileToThread",
    "turn/start",
    "submit",
    "sendMessage",
    "postMessage",
  ];

  for (const probe of probes) {
    const indexes = findOccurrences(source, probe, 4);
    output.appendLine(`\n  probe ${JSON.stringify(probe)}: ${indexes.length} occurrence(s) shown`);
    if (indexes.length === 0) continue;
    for (const index of indexes) {
      const start = Math.max(0, index - 240);
      const end = Math.min(source.length, index + probe.length + 360);
      const snippet = source
        .slice(start, end)
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s{2,}/g, " ");
      output.appendLine(`    @${index}: ${snippet}`);
    }
  }
}

function findOccurrences(source: string, needle: string, limit: number): number[] {
  const results: number[] = [];
  let from = 0;
  while (results.length < limit) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    results.push(index);
    from = index + needle.length;
  }
  return results;
}
