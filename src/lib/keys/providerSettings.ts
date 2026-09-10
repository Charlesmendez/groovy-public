import type {
  KeyModes,
  LlmKeyMode,
  Provider,
} from "@/lib/keys/resolveKeyMode";
import { isServerKeyEligibleProvider } from "@/lib/keys/providerKeyPolicy";

export type ProviderKeyInfo = {
  name: string;
  shortDescription: string;
  placeholder: string;
  helpUrl: string;
  description?: string;
};

export const PROVIDER_INFO: Record<Provider, ProviderKeyInfo> = {
  anthropic: {
    name: "Anthropic (Claude)",
    shortDescription: "Claude models and the main Groovy orchestrator",
    placeholder: "sk-ant-...",
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    name: "OpenAI",
    shortDescription: "GPT models and OpenAI-powered Minds",
    placeholder: "sk-...",
    helpUrl: "https://platform.openai.com/api-keys",
  },
  google: {
    name: "Google (Gemini)",
    shortDescription: "Gemini models",
    placeholder: "AIza...",
    helpUrl: "https://aistudio.google.com/app/apikey",
  },
  xai: {
    name: "xAI (Grok)",
    shortDescription: "Grok models",
    placeholder: "xai-...",
    helpUrl: "https://console.x.ai/",
  },
  azure_openai: {
    name: "Azure OpenAI",
    shortDescription: "Models deployed through Azure AI",
    placeholder: "Azure OpenAI key",
    helpUrl: "https://learn.microsoft.com/azure/ai-services/openai/",
  },
  aws_bedrock: {
    name: "AWS Bedrock",
    shortDescription: "Models hosted through Amazon Bedrock",
    placeholder: "AWS access secret",
    helpUrl: "https://docs.aws.amazon.com/bedrock/",
  },
  groq: {
    name: "Groq",
    shortDescription: "Models served through Groq",
    placeholder: "gsk_...",
    helpUrl: "https://console.groq.com/keys",
  },
  mistral: {
    name: "Mistral",
    shortDescription: "Mistral models",
    placeholder: "Mistral API key",
    helpUrl: "https://console.mistral.ai/api-keys/",
  },
  other: {
    name: "Other provider",
    shortDescription: "A key for a custom model provider",
    placeholder: "Provider API key",
    helpUrl: "/docs/reference-infrastructure",
  },
  claude_cli: {
    name: "Claude Headless CLI",
    shortDescription: "Claude Code automation on your connector",
    placeholder: "sk-ant-oat01-...",
    helpUrl: "https://docs.claude.com/en/docs/claude-code/headless",
    description:
      "OAuth token from `claude setup-token`. Uses your Claude.ai plan for headless CLI runs.",
  },
  codex_cli: {
    name: "Codex Headless CLI",
    shortDescription: "Codex automation on your connector",
    placeholder: "sk-...",
    helpUrl: "https://platform.openai.com/api-keys",
    description:
      "Optional OpenAI API key for headless Codex CLI runs. Leave unset to use the connector machine's `codex login` session.",
  },
};

export const MODEL_PROVIDER_ORDER: Provider[] = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "azure_openai",
  "aws_bedrock",
  "groq",
  "mistral",
  "other",
];

export const AGENT_RUNTIME_PROVIDER_ORDER: Provider[] = [
  "claude_cli",
  "codex_cli",
];

export const PROVIDER_ORDER: Provider[] = [
  ...MODEL_PROVIDER_ORDER,
  ...AGENT_RUNTIME_PROVIDER_ORDER,
];

export function providerManagedModeLabel(provider: Provider): string {
  return provider === "codex_cli" || provider === "claude_cli"
    ? "Local login"
    : "Server env";
}

export function providerUserModeLabel(provider: Provider): string {
  return provider === "codex_cli" ? "API key" : "Own key";
}

export function buildInitialProviderModes(
  globalMode: LlmKeyMode,
  keyModes?: KeyModes,
  allowServerProviderKeys = true,
): KeyModes {
  const output: KeyModes = {};
  for (const provider of PROVIDER_ORDER) {
    const savedMode = keyModes?.[provider];
    output[provider] =
      !allowServerProviderKeys && isServerKeyEligibleProvider(provider)
        ? "user"
        : savedMode === "groovy" || savedMode === "user"
          ? savedMode
          : provider === "claude_cli" || provider === "codex_cli"
            ? "groovy"
            : globalMode;
  }
  return output;
}

export function deriveGlobalProviderMode(
  keyModes: KeyModes,
  allowServerProviderKeys: boolean,
): LlmKeyMode {
  if (!allowServerProviderKeys) return "user";
  return MODEL_PROVIDER_ORDER.some(
    (provider) => keyModes[provider] === "user",
  )
    ? "user"
    : "groovy";
}

export function providerKeyModesChanged(
  current: KeyModes,
  initial: KeyModes,
): boolean {
  return PROVIDER_ORDER.some(
    (provider) => current[provider] !== initial[provider],
  );
}

export function hasPrimaryProviderKey(args: {
  configured: Partial<Record<Provider, { configured?: boolean }>>;
  entered: Partial<Record<Provider, string>>;
}): boolean {
  return (["anthropic", "openai"] as const).some(
    (provider) =>
      args.configured[provider]?.configured === true ||
      Boolean(args.entered[provider]?.trim()),
  );
}
