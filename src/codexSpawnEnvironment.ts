import * as fs from "fs/promises";
import * as path from "path";
import type * as vscode from "vscode";

export const CODEX_NETWORK_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_CA_CERTIFICATE",
] as const;

export interface CodexNetworkEnvironmentSource {
  pid: number;
  ppid?: number;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

export interface CodexSpawnEnvironment {
  environment: NodeJS.ProcessEnv;
  sourcePid?: number;
  inheritedKeys: string[];
}

export async function resolveCodexSpawnEnvironment(
  codexCommand: string,
  output: Pick<vscode.OutputChannel, "appendLine">,
): Promise<CodexSpawnEnvironment> {
  const environment: NodeJS.ProcessEnv = { ...process.env };

  if (process.platform !== "linux") {
    return { environment, inheritedKeys: [] };
  }

  try {
    const sources = await discoverCodexNetworkEnvironmentSources(codexCommand);
    const source = chooseCodexNetworkEnvironmentSource(sources, process.pid);
    if (!source) {
      output.appendLine(
        "[rpc] no official Codex sibling with network proxy environment was found; using the extension-host environment",
      );
      return { environment, inheritedKeys: [] };
    }

    const inheritedKeys: string[] = [];
    for (const key of CODEX_NETWORK_ENV_KEYS) {
      const value = source.environment[key];
      if (!value) continue;
      environment[key] = value;
      inheritedKeys.push(key);
    }

    if (inheritedKeys.length > 0) {
      output.appendLine(
        `[rpc] inherited official Codex network environment from sibling pid ${source.pid}: ${inheritedKeys.join(", ")} (values redacted)`,
      );
    }

    return {
      environment,
      sourcePid: source.pid,
      inheritedKeys,
    };
  } catch (error) {
    output.appendLine(
      `[rpc] could not inspect official Codex sibling network environment: ${(error as Error).message}; using the extension-host environment`,
    );
    return { environment, inheritedKeys: [] };
  }
}

export async function discoverCodexNetworkEnvironmentSources(
  codexCommand: string,
  procRoot = "/proc",
): Promise<CodexNetworkEnvironmentSource[]> {
  const entries = await fs.readdir(procRoot, { withFileTypes: true });
  const sources: CodexNetworkEnvironmentSource[] = [];
  const normalizedCommand = path.resolve(codexCommand);

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;

    const processDir = path.join(procRoot, entry.name);
    try {
      const [cmdlineBuffer, environBuffer, status] = await Promise.all([
        fs.readFile(path.join(processDir, "cmdline")),
        fs.readFile(path.join(processDir, "environ")),
        fs.readFile(path.join(processDir, "status"), "utf8"),
      ]);

      const args = parseNullSeparated(cmdlineBuffer);
      if (args.length === 0 || !args.includes("app-server")) continue;
      if (path.resolve(args[0]) !== normalizedCommand) continue;

      const environment = parseEnvironment(environBuffer);
      if (!CODEX_NETWORK_ENV_KEYS.some((key) => Boolean(environment[key]))) continue;

      sources.push({
        pid,
        ppid: parseParentPid(status),
        args,
        environment,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Processes can disappear while /proc is being scanned, and hardened
      // systems may deny individual entries. Neither should break monitoring.
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") continue;
      throw error;
    }
  }

  return sources;
}

export function chooseCodexNetworkEnvironmentSource(
  sources: CodexNetworkEnvironmentSource[],
  extensionHostPid: number,
): CodexNetworkEnvironmentSource | undefined {
  return [...sources].sort((a, b) => {
    const scoreDifference =
      codexNetworkSourceScore(b, extensionHostPid) -
      codexNetworkSourceScore(a, extensionHostPid);
    if (scoreDifference !== 0) return scoreDifference;
    return b.pid - a.pid;
  })[0];
}

export function parseEnvironment(buffer: Buffer): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const entry of parseNullSeparated(buffer)) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

function parseNullSeparated(buffer: Buffer): string[] {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((value) => value.length > 0);
}

function parseParentPid(status: string): number | undefined {
  const match = /^PPid:\s*(\d+)$/m.exec(status);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function codexNetworkSourceScore(
  source: CodexNetworkEnvironmentSource,
  extensionHostPid: number,
): number {
  let score = 0;
  if (source.ppid === extensionHostPid) score += 1_000;
  if (source.args.includes("--analytics-default-enabled")) score += 100;
  if (source.args.some((arg) => arg.includes("features.code_mode_host=true"))) score += 50;
  if (source.environment.HTTP_PROXY || source.environment.http_proxy) score += 10;
  if (source.environment.HTTPS_PROXY || source.environment.https_proxy) score += 10;
  return score;
}
