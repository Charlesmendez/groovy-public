export { vercelFetch, VercelApiError } from "./client";
export { createProject, getProject, deleteProject, addDomainToProject, verifyProjectDomain } from "./projects";
export type { VercelProject, VercelProjectDomain, DomainVerificationChallenge } from "./projects";
export {
  createDeployment,
  deleteDeployment,
  getDeployment,
  getDeploymentEvents,
  pollDeploymentUntilReady,
  listDeploymentsByProject,
} from "./deployments";
export type { InlinedFile, VercelDeployment, DeploymentLogEvent } from "./deployments";
export { getDomainConfig } from "./domains";
export type { DomainConfig } from "./domains";
