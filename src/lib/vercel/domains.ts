/**
 * Vercel Domains API.
 */

import { vercelFetch } from "./client";

export type DomainConfig = {
  configuredBy: "CNAME" | "A" | "http" | "dns-01" | null;
  acceptedChallenges: string[];
  misconfigured: boolean;
  recommendedIPv4?: Array<{ rank: number; value: string[] }>;
  recommendedCNAME?: Array<{ rank: number; value: string }>;
};

/**
 * Get a domain's current DNS configuration.
 * Shows whether the domain is pointing to Vercel and what records are needed.
 */
export async function getDomainConfig(domain: string): Promise<DomainConfig> {
  const { data } = await vercelFetch<DomainConfig>(
    `/v6/domains/${encodeURIComponent(domain)}/config`
  );
  return data;
}
