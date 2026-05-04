/**
 * Vercel Projects API.
 */

import { vercelFetch } from "./client";

export type VercelProject = {
  id: string;
  name: string;
  accountId: string;
  framework: string | null;
  createdAt: number;
};

export type DomainVerificationChallenge = {
  type: string;
  domain: string;
  value: string;
  reason: string;
};

export type VercelProjectDomain = {
  name: string;
  apexName: string;
  projectId: string;
  verified: boolean;
  verification?: DomainVerificationChallenge[];
  createdAt: number;
  updatedAt: number;
};

/** Create a new project (no git repo needed). */
export async function createProject(name: string): Promise<VercelProject> {
  const { data } = await vercelFetch<VercelProject>("/v11/projects", {
    method: "POST",
    body: JSON.stringify({
      name,
      framework: "nextjs",
    }),
  });
  return data;
}

/** Get project by ID or name. */
export async function getProject(idOrName: string): Promise<VercelProject> {
  const { data } = await vercelFetch<VercelProject>(
    `/v9/projects/${encodeURIComponent(idOrName)}`
  );
  return data;
}

/** Add a custom domain to a project. */
export async function addDomainToProject(
  projectIdOrName: string,
  domain: string
): Promise<VercelProjectDomain> {
  const { data } = await vercelFetch<VercelProjectDomain>(
    `/v10/projects/${encodeURIComponent(projectIdOrName)}/domains`,
    {
      method: "POST",
      body: JSON.stringify({ name: domain }),
    }
  );
  return data;
}

/** Delete a project and all its deployments. */
export async function deleteProject(idOrName: string): Promise<void> {
  await vercelFetch(`/v9/projects/${encodeURIComponent(idOrName)}`, {
    method: "DELETE",
  });
}

/** Verify a project domain (after user adds TXT record). */
export async function verifyProjectDomain(
  projectIdOrName: string,
  domain: string
): Promise<VercelProjectDomain> {
  const { data } = await vercelFetch<VercelProjectDomain>(
    `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains/${encodeURIComponent(domain)}/verify`,
    { method: "POST" }
  );
  return data;
}
