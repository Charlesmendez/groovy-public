/**
 * @param {{ mobileUi: boolean, requiredWorkspaceRoot?: string | null }} options
 */
export function isWorkspaceRequiredForAgentCreation({
  mobileUi,
  requiredWorkspaceRoot = null,
}) {
  return Boolean(String(requiredWorkspaceRoot || "").trim()) || mobileUi !== true;
}
