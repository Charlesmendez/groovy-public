export type PseoCluster = "alternatives" | "use-cases" | "integrations";

export type PseoCtaVariant = "dual";

export type PseoFaqItem = {
  question: string;
  answer: string;
};

export type PseoPageRecord = {
  id: `${PseoCluster}:${string}`;
  cluster: PseoCluster;
  slug: string;
  canonicalPath: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  title: string;
  metaDescription: string;
  ogTitle: string;
  ogDescription: string;
  h1: string;
  subhead: string;
  intro: string;
  proofPoints: string[];
  featureBullets: string[];
  faq: PseoFaqItem[];
  ctaVariant: PseoCtaVariant;
  relatedPageRefs: Array<`${PseoCluster}:${string}`>;
};

export type PseoCatalog = {
  language: "en";
  market: "global";
  generatedAt: string;
  pages: PseoPageRecord[];
};

export type PseoSourceStatus = {
  seed: string;
  googleCount: number;
  duckduckgoCount: number;
  fallbackCount: number;
  errors: string[];
};

export type PseoKeywordUniverse = {
  language: "en";
  market: "global";
  generatedAt: string;
  sourceStatus: PseoSourceStatus[];
  seeds: string[];
  modifiers: {
    comparison: string[];
    roles: string[];
    industries: string[];
    integrations: string[];
  };
  clusterSummary: Record<PseoCluster, number>;
  topKeywords: string[];
  allKeywords: string[];
  suggestionsBySeed: Record<
    string,
    {
      google: string[];
      duckduckgo: string[];
      fallback: string[];
      errors: string[];
      combined: string[];
    }
  >;
};

export type PseoRelatedPageLink = Pick<
  PseoPageRecord,
  "cluster" | "slug" | "title" | "primaryKeyword"
> & {
  href: string;
};
