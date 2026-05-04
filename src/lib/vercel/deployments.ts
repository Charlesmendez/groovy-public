/**
 * Vercel Deployments API.
 */

import { vercelFetch } from "./client";

export type InlinedFile = {
  file: string;
  data: string;
  encoding?: "base64" | "utf-8";
};

export type DeploymentProjectSettings = {
  framework?: string;
  buildCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
  nodeVersion?: string;
};

export type CreateDeploymentInput = {
  /** Vercel project name or ID. */
  name: string;
  /** Existing project ID (takes precedence over name). */
  project?: string;
  /** "production" or "preview". */
  target?: "production" | "preview";
  files: InlinedFile[];
  projectSettings?: DeploymentProjectSettings;
};

export type VercelDeployment = {
  id: string;
  url: string;
  name: string;
  readyState: "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELED" | "INITIALIZING";
  alias?: string[];
  createdAt: number;
  inspectorUrl?: string | null;
};

export type DeploymentLogEvent = {
  type: "stdout" | "stderr" | "command" | "exit";
  created: number;
  payload?: {
    text?: string;
    deploymentId?: string;
  };
};

type ListDeploymentsResponse = {
  deployments?: VercelDeployment[];
};

/**
 * Create a deployment from inlined files.
 * For Next.js static export we set framework + buildCommand.
 */
export async function createDeployment(
  input: CreateDeploymentInput
): Promise<VercelDeployment> {
  const { data } = await vercelFetch<VercelDeployment>(
    "/v13/deployments?skipAutoDetectionConfirmation=1",
    {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        project: input.project,
        target: input.target || "production",
        files: input.files,
        projectSettings: input.projectSettings || {
          framework: "nextjs",
          buildCommand: "next build",
          nodeVersion: "20.x",
        },
      }),
    }
  );
  return data;
}

/** Delete a deployment. */
export async function deleteDeployment(id: string): Promise<void> {
  await vercelFetch(`/v13/deployments/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Get a deployment by ID. */
export async function getDeployment(idOrUrl: string): Promise<VercelDeployment> {
  const { data } = await vercelFetch<VercelDeployment>(
    `/v13/deployments/${encodeURIComponent(idOrUrl)}`
  );
  return data;
}

/** List recent deployments for a Vercel project. */
export async function listDeploymentsByProject(
  projectIdOrName: string,
  limit = 100
): Promise<VercelDeployment[]> {
  const bounded = Math.max(1, Math.min(limit, 100));
  const { data } = await vercelFetch<ListDeploymentsResponse>(
    `/v6/deployments?projectId=${encodeURIComponent(projectIdOrName)}&limit=${bounded}`
  );
  return Array.isArray(data?.deployments) ? data.deployments : [];
}

/**
 * Stream build logs (NDJSON) for a deployment.
 * Returns parsed log events.
 */
export async function getDeploymentEvents(
  deploymentId: string
): Promise<DeploymentLogEvent[]> {
  const { data } = await vercelFetch<DeploymentLogEvent[]>(
    `/v3/deployments/${encodeURIComponent(deploymentId)}/events`
  );
  return Array.isArray(data) ? data : [];
}

/**
 * Poll a deployment until it reaches a terminal state (READY or ERROR).
 * Calls `onLog` for each new build log line.
 * Returns the final deployment state + last N log lines on error.
 */
export async function pollDeploymentUntilReady(
  deploymentId: string,
  opts: {
    onLog?: (line: string) => void;
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<{
  status: "READY" | "ERROR" | "CANCELED" | "TIMEOUT";
  deployment: VercelDeployment;
  errorLines: string[];
}> {
  const timeoutMs = opts.timeoutMs ?? 180_000; // 3 min default
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  const startTime = Date.now();
  let lastEventTs = 0;
  const allLines: string[] = [];

  while (Date.now() - startTime < timeoutMs) {
    const deployment = await getDeployment(deploymentId);

    if (deployment.readyState === "READY") {
      return { status: "READY", deployment, errorLines: [] };
    }
    if (deployment.readyState === "ERROR") {
      return {
        status: "ERROR",
        deployment,
        errorLines: allLines.slice(-150),
      };
    }
    if (deployment.readyState === "CANCELED") {
      return { status: "CANCELED", deployment, errorLines: [] };
    }

    // Fetch new log events
    try {
      const events = await getDeploymentEvents(deploymentId);
      for (const ev of events) {
        if (ev.created <= lastEventTs) continue;
        lastEventTs = ev.created;
        const text = ev.payload?.text?.trim();
        if (text) {
          allLines.push(text);
          opts.onLog?.(text);
        }
      }
    } catch {
      // Log fetch can fail transiently; keep polling deployment status
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  const deployment = await getDeployment(deploymentId);
  return {
    status: "TIMEOUT",
    deployment,
    errorLines: allLines.slice(-100),
  };
}
