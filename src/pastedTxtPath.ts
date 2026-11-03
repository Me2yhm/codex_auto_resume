import * as path from "path";

/** Compare paths using the extension host's filesystem semantics. The
 * optional platform flavor allows Windows-only cases to be regression tested
 * on Linux CI without accessing a Windows filesystem. */
export function resolveOfficialPastedTxtPath(
  sourcePath: string,
  root: string,
  paths: path.PlatformPath = path,
): { filesystemPath: string; sessionDirectory: string; sessionId: string } | undefined {
  if (typeof sourcePath !== "string" || !paths.isAbsolute(sourcePath) ||
      sourcePath.includes("\u0000")) return undefined;

  // Windows accepts both slash styles even when the official Codex serializer
  // mixes them. Do not demand that the original attachment string already
  // equals path.resolve(...). However, never normalize away explicit ./ or
  // ../ components from an untrusted input.
  const segments = paths.sep === "\\" ? sourcePath.split(/[\\/]/) : sourcePath.split("/");
  if (segments.some(segment => segment === "." || segment === "..")) return undefined;

  const filesystemPath = paths.resolve(sourcePath);
  const relative = paths.relative(paths.resolve(root), filesystemPath);
  if (!relative || paths.isAbsolute(relative) || relative === ".." ||
      relative.startsWith(".." + paths.sep)) return undefined;
  const parts = relative.split(paths.sep);
  if (parts.length !== 2 ||
      !/^[a-f0-9-]{32,36}$/i.test(parts[0]) ||
      !/^[^\\/:\u0000]+\.txt$/i.test(parts[1])) return undefined;

  return {
    filesystemPath,
    sessionDirectory: paths.join(paths.resolve(root), parts[0]),
    sessionId: parts[0],
  };
}

/** A realpath may have different separators/casing from the serialized
 * attachment. It must still resolve to the SAME two-level managed file. */
export function realPastedTxtIsConfined(
  realRoot: string, realFile: string, sessionId: string, paths: path.PlatformPath = path,
): boolean {
  const relative = paths.relative(realRoot, realFile);
  if (!relative || paths.isAbsolute(relative)) return false;
  const parts = relative.split(paths.sep);
  return parts.length === 2 && parts[0].toLowerCase() === sessionId.toLowerCase() &&
    /^[^\\/:\u0000]+\.txt$/i.test(parts[1]);
}
