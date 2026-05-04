export const platform = process.platform;
export const isWindows = platform === "win32";
export const isDarwin = platform === "darwin";
export const isLinux = platform === "linux";

export function normalizePlatform(p) {
  const v = String(p || platform).trim().toLowerCase();
  if (v === "windows" || v === "win" || v === "win32") return "win32";
  if (v === "mac" || v === "macos" || v === "darwin") return "darwin";
  if (v === "linux") return "linux";
  return v || platform;
}
