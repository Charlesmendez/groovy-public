/**
 * Provider-key policy for this deployment.
 *
 * Hosted Groovy is BYOK-only. Source-available/self-hosted deployments can
 * explicitly opt into server-managed provider keys with
 * GROOVY_ALLOW_SERVER_PROVIDER_KEYS=1.
 */

export const SERVER_KEY_ELIGIBLE_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "azure_openai",
  "aws_bedrock",
  "groq",
  "mistral",
  "other",
] as const;

export function serverProviderKeysAllowed(): boolean {
  return process.env.GROOVY_ALLOW_SERVER_PROVIDER_KEYS === "1";
}

export function isServerKeyEligibleProvider(provider: string): boolean {
  return (SERVER_KEY_ELIGIBLE_PROVIDERS as readonly string[]).includes(provider);
}
