import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const outputDir = path.join(repoRoot, "src", "content", "pseo");

const SEED_KEYWORDS = [
  "clawdbot",
  "openclaw",
  "ai agents",
  "ai agent",
  "automation",
  "workflow automation",
  "whatsapp ai agent",
  "local ai agent",
  "business automation ai",
];

const ROLE_MODIFIERS = [
  "marketing teams",
  "sales teams",
  "customer support teams",
  "founders",
  "operations managers",
  "project managers",
  "hr teams",
  "recruiters",
  "finance teams",
  "agencies",
  "ecommerce teams",
  "real estate teams",
  "healthcare operations teams",
  "legal ops teams",
  "education teams",
  "startup teams",
  "product managers",
  "customer success teams",
  "executive assistants",
  "virtual assistants",
  "devops teams",
  "software teams",
  "analytics teams",
  "growth teams",
  "social media teams",
];

const INDUSTRY_MODIFIERS = [
  "healthcare",
  "legal",
  "finance",
  "real estate",
  "ecommerce",
  "education",
  "manufacturing",
  "logistics",
  "hospitality",
  "saas",
];

const INTEGRATION_MODIFIERS = [
  "whatsapp",
  "google calendar",
  "slack",
  "gmail",
  "notion",
  "hubspot",
  "salesforce",
  "airtable",
  "google sheets",
  "excel",
  "jira",
  "shopify",
];

const COMPARISON_MODIFIERS = [
  "alternative",
  "vs",
  "pricing",
  "review",
  "self hosted",
  "open source",
];

const COMPETITORS = [
  "clawdbot",
  "openclaw",
  "moltbot",
  "autogpt",
  "agentgpt",
  "superagent",
  "babyagi",
  "open interpreter",
  "cursor",
  "claude code",
  "windsurf",
  "continue",
  "replit agent",
  "devin ai",
  "manus ai",
  "n8n",
  "zapier",
  "make",
  "workato",
  "uipath",
  "power automate",
  "activepieces",
  "pipedream",
  "langchain",
  "crewai",
  "autogen",
  "anythingllm",
  "privategpt",
  "localai",
  "goose ai agent",
  "sema4",
  "stackai",
  "flowise",
  "botpress",
  "voiceflow",
  "jan ai",
  "perplexity",
  "chatgpt",
  "gemini",
  "copilot",
];

const USE_CASE_WORKFLOWS = [
  "meeting scheduling",
  "lead qualification",
  "report generation",
  "inbox triage",
  "social mention monitoring",
  "data extraction",
];

const INTEGRATIONS = [
  "google calendar",
  "whatsapp",
  "slack",
  "notion",
  "obsidian",
  "gmail",
  "google sheets",
  "excel",
  "google docs",
  "airtable",
  "hubspot",
  "salesforce",
  "stripe",
  "shopify",
  "jira",
  "linear",
  "trello",
  "asana",
  "clickup",
  "zendesk",
  "intercom",
  "linkedin",
  "x",
  "tiktok ads",
  "facebook ads",
  "google ads",
  "meta ads manager",
  "postgres",
  "snowflake",
  "bigquery",
];

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function toTitleCase(input) {
  return input
    .split(" ")
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function unique(array) {
  return Array.from(new Set(array.filter(Boolean)));
}

async function fetchJsonWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "GroovyPseoBot/1.0 (+https://gogroovy.ai)",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGoogleSuggest(query) {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`;
  const payload = await fetchJsonWithTimeout(url);

  if (!Array.isArray(payload) || !Array.isArray(payload[1])) {
    throw new Error("Invalid Google suggest payload");
  }

  return payload[1].map((item) => String(item).trim());
}

async function fetchDuckDuckGoSuggest(query) {
  const url = `https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}&type=list`;
  const payload = await fetchJsonWithTimeout(url);

  if (!Array.isArray(payload)) {
    throw new Error("Invalid DuckDuckGo payload");
  }

  return payload
    .map((item) => (item && typeof item.phrase === "string" ? item.phrase.trim() : ""))
    .filter(Boolean);
}

function fallbackExpansions(seed) {
  return unique([
    `${seed} alternative`,
    `${seed} vs`,
    `${seed} pricing`,
    `${seed} review`,
    `${seed} for business`,
    `${seed} workflow automation`,
  ]);
}

async function captureSuggestions() {
  const bySeed = {};

  for (const seed of SEED_KEYWORDS) {
    const seedPayload = {
      google: [],
      duckduckgo: [],
      fallback: fallbackExpansions(seed),
      errors: [],
    };

    try {
      seedPayload.google = await fetchGoogleSuggest(seed);
    } catch (error) {
      seedPayload.errors.push(`google:${String(error)}`);
    }

    try {
      seedPayload.duckduckgo = await fetchDuckDuckGoSuggest(seed);
    } catch (error) {
      seedPayload.errors.push(`duckduckgo:${String(error)}`);
    }

    seedPayload.combined = unique([
      ...seedPayload.google,
      ...seedPayload.duckduckgo,
      ...seedPayload.fallback,
    ]);

    bySeed[seed] = seedPayload;
  }

  return bySeed;
}

function buildAlternativesPages() {
  const pages = [];
  const slugSet = new Set();
  const primaryKeywordSet = new Set();

  const patterns = [
    {
      keyword: (brand) => `${brand} alternative`,
      title: (brand) => `Best ${toTitleCase(brand)} Alternative for AI Agents`,
      h1: (brand) => `Best ${toTitleCase(brand)} alternative`,
      subhead: (brand) =>
        `Compare Groovy with ${toTitleCase(
          brand,
        )} for local-first AI agent automation and faster execution.`,
    },
    {
      keyword: (brand) => `${brand} vs groovy`,
      title: (brand) => `${toTitleCase(brand)} vs Groovy`,
      h1: (brand) => `${toTitleCase(brand)} vs Groovy`,
      subhead: (brand) =>
        `See how Groovy compares to ${toTitleCase(
          brand,
        )} across automation depth, privacy, and deployment speed.`,
    },
    {
      keyword: (brand) => `${brand} pricing alternative`,
      title: (brand) => `${toTitleCase(brand)} Pricing Alternative`,
      h1: (brand) => `${toTitleCase(brand)} pricing alternative`,
      subhead: () =>
        `Reduce stack sprawl with a local AI agent platform designed for predictable automation costs.`,
    },
    {
      keyword: (brand) => `self hosted alternative to ${brand}`,
      title: (brand) => `Self-Hosted Alternative to ${toTitleCase(brand)}`,
      h1: (brand) => `Self-hosted alternative to ${toTitleCase(brand)}`,
      subhead: () =>
        `Run automations from your own machine while keeping your sessions, files, and workflows under your control.`,
    },
  ];

  for (const brand of COMPETITORS) {
    for (const pattern of patterns) {
      const primaryKeyword = pattern.keyword(brand);
      const baseSlug = slugify(primaryKeyword);
      let slug = baseSlug;
      let counter = 2;

      while (slugSet.has(slug)) {
        slug = `${baseSlug}-${counter}`;
        counter += 1;
      }

      if (primaryKeywordSet.has(primaryKeyword)) {
        throw new Error(`Duplicate primary keyword in alternatives: ${primaryKeyword}`);
      }

      slugSet.add(slug);
      primaryKeywordSet.add(primaryKeyword);

      pages.push({
        id: `alternatives:${slug}`,
        cluster: "alternatives",
        slug,
        canonicalPath: `/alternatives/${slug}`,
        primaryKeyword,
        secondaryKeywords: unique([
          `${brand} alternative`,
          `${brand} vs groovy`,
          "ai agents",
          "ai automation",
          "local ai agent",
          "workflow automation",
        ]),
        title: `${pattern.title(brand)} | Groovy`,
        metaDescription: `Evaluate ${toTitleCase(
          brand,
        )} against Groovy and choose the AI automation stack that ships faster, stays private, and scales with your workflows.`,
        ogTitle: `${pattern.title(brand)} | Groovy`,
        ogDescription: `Head-to-head comparison for ${toTitleCase(
          brand,
        )} with a focus on AI agents, automation depth, and local-first execution.`,
        h1: pattern.h1(brand),
        subhead: pattern.subhead(brand),
        intro: `Teams searching for "${primaryKeyword}" usually need execution, not chatbot fluff. Groovy connects to your real tools and runs automations from WhatsApp or web.`,
        proofPoints: [
          "Run workflows from your own machine with your existing logged-in sessions.",
          "Coordinate browser, files, and code automations from one command center.",
          "Use your own API keys and keep control over model/provider decisions.",
        ],
        featureBullets: [
          "Local-first execution for sensitive workflows and documents.",
          "Agent orchestration across browser actions, files, and integrations.",
          "Fast setup via desktop connector with persistent session support.",
          "WhatsApp-based control for field teams and async operations.",
          "Flexible model routing for Claude, GPT, and other providers.",
          "Production-minded automation patterns, not one-off prompts.",
        ],
        faq: [
          {
            question: `What makes Groovy a strong ${toTitleCase(brand)} alternative?`,
            answer:
              "Groovy focuses on execution across real workflows: browser tasks, documents, integrations, and messaging control from one place.",
          },
          {
            question: "Can I keep my data local?",
            answer:
              "Yes. Groovy is designed for local-first operation using your own machine and credentials.",
          },
          {
            question: "Is Groovy only for developers?",
            answer:
              "No. Teams can trigger automations through WhatsApp and web while technical users can extend deeper workflows.",
          },
        ],
        ctaVariant: "dual",
      });
    }
  }

  if (pages.length !== 160) {
    throw new Error(`Expected 160 alternatives pages, got ${pages.length}`);
  }

  return pages;
}

function buildUseCasePages() {
  const pages = [];
  const keywordSet = new Set();
  const slugSet = new Set();

  for (const role of ROLE_MODIFIERS) {
    for (const workflow of USE_CASE_WORKFLOWS) {
      const primaryKeyword = `${workflow} automation for ${role}`;
      const titleRole = toTitleCase(role);
      const titleWorkflow = toTitleCase(workflow);

      if (keywordSet.has(primaryKeyword)) {
        throw new Error(`Duplicate primary keyword in use-cases: ${primaryKeyword}`);
      }

      keywordSet.add(primaryKeyword);

      const baseSlug = slugify(`${workflow}-${role}-ai-agent`);
      let slug = baseSlug;
      let counter = 2;

      while (slugSet.has(slug)) {
        slug = `${baseSlug}-${counter}`;
        counter += 1;
      }

      slugSet.add(slug);

      pages.push({
        id: `use-cases:${slug}`,
        cluster: "use-cases",
        slug,
        canonicalPath: `/use-cases/${slug}`,
        primaryKeyword,
        secondaryKeywords: unique([
          `ai agents for ${role}`,
          `${workflow} ai automation`,
          "business automation ai",
          "workflow automation",
          "local ai agent",
          "agent automation",
        ]),
        title: `${titleWorkflow} Automation for ${titleRole} | Groovy`,
        metaDescription: `${titleRole} use Groovy to automate ${workflow}, route work faster, and keep execution under control with local-first AI agents.`,
        ogTitle: `${titleWorkflow} for ${titleRole} | Groovy`,
        ogDescription: `Operational playbook for ${role}: automate ${workflow} with practical AI agents and measurable execution gains.`,
        h1: `${titleWorkflow} automation for ${titleRole}`,
        subhead: `Turn repetitive ${workflow} into a reliable AI workflow for ${role}.`,
        intro: `If you are targeting "${primaryKeyword}", this guide gives you an execution blueprint with Groovy's local-first agent stack.`,
        proofPoints: [
          "Shorten handoffs by routing repetitive work to automated agent runs.",
          "Keep operators in control with clear approvals and human checkpoints.",
          "Run fast iterations without rebuilding your stack every week.",
        ],
        featureBullets: [
          `Automate ${workflow} with reusable prompts and tool-connected actions.`,
          "Trigger automations from WhatsApp or dashboard commands.",
          "Use role-specific playbooks with consistent outputs.",
          "Connect files, browser tasks, and integrations in a single flow.",
          "Track execution status and refine workflows continuously.",
          "Scale from solo operators to cross-functional teams.",
        ],
        faq: [
          {
            question: `How does Groovy help ${role} with ${workflow}?`,
            answer:
              "Groovy combines agent orchestration with real tools, so teams can automate the repetitive execution layer and focus on decisions.",
          },
          {
            question: "Do I need heavy setup to start?",
            answer:
              "No. Most teams start with the connector, pair once, and launch role-specific workflows in minutes.",
          },
          {
            question: "Can this fit existing processes?",
            answer:
              "Yes. Groovy is designed to layer onto your current tools and channels rather than forcing a full stack migration.",
          },
        ],
        ctaVariant: "dual",
      });
    }
  }

  if (pages.length !== 150) {
    throw new Error(`Expected 150 use-case pages, got ${pages.length}`);
  }

  return pages;
}

function buildIntegrationPages() {
  const pages = [];
  const keywordSet = new Set();
  const slugSet = new Set();

  const patterns = [
    (integration) => `${integration} ai agent`,
    (integration) => `${integration} automation ai`,
    (integration) => `ai workflow automation with ${integration}`,
  ];

  for (const integration of INTEGRATIONS) {
    for (const pattern of patterns) {
      const primaryKeyword = pattern(integration);
      if (keywordSet.has(primaryKeyword)) {
        throw new Error(`Duplicate primary keyword in integrations: ${primaryKeyword}`);
      }

      keywordSet.add(primaryKeyword);

      const baseSlug = slugify(`${primaryKeyword}-integration`);
      let slug = baseSlug;
      let counter = 2;
      while (slugSet.has(slug)) {
        slug = `${baseSlug}-${counter}`;
        counter += 1;
      }
      slugSet.add(slug);

      const titleIntegration = toTitleCase(integration);
      pages.push({
        id: `integrations:${slug}`,
        cluster: "integrations",
        slug,
        canonicalPath: `/integrations/${slug}`,
        primaryKeyword,
        secondaryKeywords: unique([
          `${integration} ai automation`,
          `ai agent for ${integration}`,
          "workflow automation",
          "business automation ai",
          "ai agents",
          "agent automation",
        ]),
        title: `${titleIntegration} AI Agent Automation | Groovy`,
        metaDescription: `Automate ${integration} workflows with Groovy AI agents. Connect tools, execute tasks, and keep operations local-first.`,
        ogTitle: `${titleIntegration} Automation with AI Agents`,
        ogDescription: `Practical guide for ${integration} automation using Groovy's agent orchestration and local-first workflow execution.`,
        h1: `${titleIntegration} automation with AI agents`,
        subhead: `Connect ${titleIntegration} to Groovy and run multi-step automation from one command layer.`,
        intro: `Teams searching "${primaryKeyword}" usually want reliable execution, not another disconnected tool. Groovy coordinates the stack end to end.`,
        proofPoints: [
          `Unify ${integration} actions with browser, files, and messaging workflows.`,
          "Reduce context switching by centralizing automation commands.",
          "Maintain control over model providers and API key usage.",
        ],
        featureBullets: [
          `Automate repetitive ${integration} tasks with reusable execution patterns.`,
          "Connect event triggers to practical task completions.",
          "Use WhatsApp/web controls to launch workflows quickly.",
          "Route approvals and exceptions back to your operators.",
          "Keep workflow data and context tied to real sessions.",
          "Scale to team-wide automation without brittle scripts.",
        ],
        faq: [
          {
            question: `Can Groovy automate ${titleIntegration} workflows reliably?`,
            answer:
              "Yes. Groovy focuses on practical workflow execution with agent orchestration and tool-connected actions.",
          },
          {
            question: "Does this support local-first execution?",
            answer:
              "Yes. Groovy is designed to run with local control while still integrating with cloud software where needed.",
          },
          {
            question: "Can I combine multiple integrations in one flow?",
            answer:
              "Yes. Groovy supports cross-tool workflows so teams can chain actions across systems without manual handoffs.",
          },
        ],
        ctaVariant: "dual",
      });
    }
  }

  if (pages.length !== 90) {
    throw new Error(`Expected 90 integrations pages, got ${pages.length}`);
  }

  return pages;
}

function attachRelatedLinks(allPages) {
  const byCluster = {
    alternatives: allPages.filter((item) => item.cluster === "alternatives"),
    "use-cases": allPages.filter((item) => item.cluster === "use-cases"),
    integrations: allPages.filter((item) => item.cluster === "integrations"),
  };

  return allPages.map((page, index) => {
    const sameCluster = byCluster[page.cluster];
    const sameClusterIndex = sameCluster.findIndex((entry) => entry.id === page.id);

    const sameClusterRelated = [
      sameCluster[(sameClusterIndex + 1) % sameCluster.length],
      sameCluster[(sameClusterIndex + 2) % sameCluster.length],
      sameCluster[(sameClusterIndex + sameCluster.length - 1) % sameCluster.length],
    ];

    const crossRelated = [
      byCluster.alternatives[index % byCluster.alternatives.length],
      byCluster["use-cases"][index % byCluster["use-cases"].length],
      byCluster.integrations[index % byCluster.integrations.length],
    ];

    const related = unique(
      [...sameClusterRelated, ...crossRelated]
        .filter((entry) => entry.id !== page.id)
        .slice(0, 6)
        .map((entry) => `${entry.cluster}:${entry.slug}`),
    );

    return {
      ...page,
      relatedPageRefs: related.slice(0, 5),
    };
  });
}

function validateCatalog(catalog) {
  const primaryKeywordSet = new Set();
  const canonicalSet = new Set();

  for (const page of catalog.pages) {
    if (primaryKeywordSet.has(page.primaryKeyword)) {
      throw new Error(`Duplicate primary keyword: ${page.primaryKeyword}`);
    }
    if (canonicalSet.has(page.canonicalPath)) {
      throw new Error(`Duplicate canonical path: ${page.canonicalPath}`);
    }
    if (page.relatedPageRefs.length < 3 || page.relatedPageRefs.length > 6) {
      throw new Error(
        `Related links must be 3-6 entries for ${page.id}, got ${page.relatedPageRefs.length}`,
      );
    }
    primaryKeywordSet.add(page.primaryKeyword);
    canonicalSet.add(page.canonicalPath);
  }

  const clusterCounts = {
    alternatives: catalog.pages.filter((page) => page.cluster === "alternatives").length,
    "use-cases": catalog.pages.filter((page) => page.cluster === "use-cases").length,
    integrations: catalog.pages.filter((page) => page.cluster === "integrations").length,
  };

  if (clusterCounts.alternatives !== 160) {
    throw new Error(`Expected 160 alternatives pages, got ${clusterCounts.alternatives}`);
  }
  if (clusterCounts["use-cases"] !== 150) {
    throw new Error(`Expected 150 use-case pages, got ${clusterCounts["use-cases"]}`);
  }
  if (clusterCounts.integrations !== 90) {
    throw new Error(`Expected 90 integration pages, got ${clusterCounts.integrations}`);
  }
}

function buildKeywordUniverse(suggestionsBySeed, pageCatalog) {
  const suggestionKeywords = Object.values(suggestionsBySeed).flatMap(
    (entry) => entry.combined,
  );
  const expandedKeywords = unique([
    ...SEED_KEYWORDS.flatMap((seed) =>
      COMPARISON_MODIFIERS.map((modifier) => `${seed} ${modifier}`),
    ),
    ...SEED_KEYWORDS.flatMap((seed) =>
      ROLE_MODIFIERS.slice(0, 10).map((role) => `${seed} for ${role}`),
    ),
    ...SEED_KEYWORDS.flatMap((seed) =>
      INDUSTRY_MODIFIERS.map((industry) => `${seed} ${industry}`),
    ),
    ...SEED_KEYWORDS.flatMap((seed) =>
      INTEGRATION_MODIFIERS.map((integration) => `${seed} ${integration}`),
    ),
  ]);

  const allKeywords = unique([
    ...SEED_KEYWORDS,
    ...suggestionKeywords,
    ...expandedKeywords,
    ...pageCatalog.pages.map((item) => item.primaryKeyword),
  ]);

  return {
    language: "en",
    market: "global",
    generatedAt: new Date().toISOString(),
    sourceStatus: Object.entries(suggestionsBySeed).map(([seed, payload]) => ({
      seed,
      googleCount: payload.google.length,
      duckduckgoCount: payload.duckduckgo.length,
      fallbackCount: payload.fallback.length,
      errors: payload.errors,
    })),
    seeds: SEED_KEYWORDS,
    modifiers: {
      comparison: COMPARISON_MODIFIERS,
      roles: ROLE_MODIFIERS,
      industries: INDUSTRY_MODIFIERS,
      integrations: INTEGRATION_MODIFIERS,
    },
    clusterSummary: {
      alternatives: pageCatalog.pages.filter((item) => item.cluster === "alternatives").length,
      "use-cases": pageCatalog.pages.filter((item) => item.cluster === "use-cases").length,
      integrations: pageCatalog.pages.filter((item) => item.cluster === "integrations").length,
    },
    topKeywords: pageCatalog.pages.slice(0, 120).map((item) => item.primaryKeyword),
    allKeywords,
    suggestionsBySeed,
  };
}

async function writeJson(fileName, payload) {
  const filePath = path.join(outputDir, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });

  const suggestionsBySeed = await captureSuggestions();
  const alternatives = buildAlternativesPages();
  const useCases = buildUseCasePages();
  const integrations = buildIntegrationPages();

  const pages = attachRelatedLinks([...alternatives, ...useCases, ...integrations]);
  const pageCatalog = {
    language: "en",
    market: "global",
    generatedAt: new Date().toISOString(),
    pages,
  };

  validateCatalog(pageCatalog);

  const keywordUniverse = buildKeywordUniverse(suggestionsBySeed, pageCatalog);

  await writeJson("page-catalog.en.json", pageCatalog);
  await writeJson("keyword-universe.en.json", keywordUniverse);

  console.log(
    JSON.stringify(
      {
        pages: pageCatalog.pages.length,
        alternatives: alternatives.length,
        useCases: useCases.length,
        integrations: integrations.length,
        keywords: keywordUniverse.allKeywords.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
