export type ExtensionRuntimeTarget =
  | "groovy_cloud"
  | "customer_runner"
  | "device_connector";

export type ExtensionVisibility = "private" | "org" | "public";

export type ExtensionStatus = "draft" | "active" | "disabled";

export type ExtensionInstallStatus = "installed" | "disabled" | "error";

export type ExtensionInstallScope = "user" | "workspace" | "org";

export type ExtensionAuthScope =
  | "none"
  | "end_user"
  | "shared_org"
  | "service_identity";

export type ExtensionRiskLevel =
  | "read"
  | "write"
  | "destructive"
  | "privileged";

export type ExtensionConnectionStatus =
  | "pending"
  | "connected"
  | "disconnected"
  | "error";

export type ExtensionRunnerStatus = "pending" | "online" | "offline" | "error";

export type ExtensionRunnerTransport = "relay" | "https" | "local";

export type ExtensionApprovalState =
  | "not_required"
  | "required"
  | "approved"
  | "denied";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | unknown };

export type ExtensionHttpAction = {
  kind: "http_action";
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
  maxResponseChars?: number;
};

export type ExtensionCliAction = {
  kind: "cli_action";
  argvTemplate: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputChars?: number;
};

export type ExtensionConnectorAction = {
  kind: "connector_action";
  connectorType: string;
  params?: Record<string, unknown>;
  message?: string;
};

export type ExtensionToolAction =
  | ExtensionHttpAction
  | ExtensionCliAction
  | ExtensionConnectorAction;

export type ExtensionManifestTool = {
  slug: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  runtimeTarget?: ExtensionRuntimeTarget;
  authScope?: ExtensionAuthScope;
  riskLevel?: ExtensionRiskLevel;
  action: ExtensionToolAction;
  promptHint?: string;
  tags?: string[];
  enabled?: boolean;
};

export type ExtensionManifest = {
  schemaVersion: 1;
  displayName?: string;
  description?: string;
  capabilityTags?: string[];
  skillInstructions?: string;
  tools: ExtensionManifestTool[];
};

export type ExtensionInstallationPolicy = {
  requireApprovalForRiskLevels?: ExtensionRiskLevel[];
};

export type ExtensionRuntimeTool = {
  agentId: string;
  extensionId: string;
  extensionVersionId: string;
  installationId: string;
  connectionId: string | null;
  toolName: string;
  toolSlug: string;
  extensionSlug: string;
  extensionName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  runtimeTarget: ExtensionRuntimeTarget;
  authScope: ExtensionAuthScope;
  riskLevel: ExtensionRiskLevel;
  action: ExtensionToolAction;
  promptHint: string;
  capabilityTags: string[];
  extensionSkillInstructions: string;
  tags: string[];
  installStatus: ExtensionInstallStatus;
  approvalPolicy: ExtensionInstallationPolicy;
  runnerId: string | null;
  runnerStatus: ExtensionRunnerStatus | null;
};

export type ExtensionConnectionRuntime = {
  id: string;
  authScope: ExtensionAuthScope;
  status: ExtensionConnectionStatus;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
};

export type ExtensionRunnerRuntime = {
  id: string;
  agentId: string;
  name: string;
  runtimeTarget: ExtensionRuntimeTarget;
  transport: ExtensionRunnerTransport;
  status: ExtensionRunnerStatus;
  endpoint: string | null;
  metadata: Record<string, unknown>;
  authToken: string | null;
};

export type LoadedExtensionPack = {
  extensionId: string;
  versionId: string;
  installationId: string;
  slug: string;
  name: string;
  description: string;
  capabilityTags: string[];
  skillInstructions: string;
  tools: ExtensionRuntimeTool[];
};
