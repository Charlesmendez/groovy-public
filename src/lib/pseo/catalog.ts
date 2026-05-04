import type { Metadata } from "next";

import keywordUniverseJson from "@/content/pseo/keyword-universe.en.json";
import pageCatalogJson from "@/content/pseo/page-catalog.en.json";

import type {
  PseoCatalog,
  PseoCluster,
  PseoKeywordUniverse,
  PseoPageRecord,
  PseoRelatedPageLink,
} from "./types";

const pseoCatalog = pageCatalogJson as PseoCatalog;
const pseoKeywordUniverse = keywordUniverseJson as PseoKeywordUniverse;

function buildPageKey(cluster: PseoCluster, slug: string) {
  return `${cluster}:${slug}`;
}

const pseoPageByRef = new Map<string, PseoPageRecord>(
  pseoCatalog.pages.map((page) => [buildPageKey(page.cluster, page.slug), page]),
);

export function getSiteBaseUrl(): string {
  const fallback = "https://gogroovy.ai";
  const candidate = process.env.NEXT_PUBLIC_APP_URL || fallback;

  try {
    return new URL(candidate).origin;
  } catch {
    return fallback;
  }
}

export function getPseoCatalog(): PseoCatalog {
  return pseoCatalog;
}

export function getPseoKeywordUniverse(): PseoKeywordUniverse {
  return pseoKeywordUniverse;
}

export function getPseoPagePath(cluster: PseoCluster, slug: string): string {
  return `/${cluster}/${slug}`;
}

export function getPseoPage(cluster: PseoCluster, slug: string): PseoPageRecord | null {
  return pseoPageByRef.get(buildPageKey(cluster, slug)) ?? null;
}

export function getPseoPagesByCluster(cluster: PseoCluster): PseoPageRecord[] {
  return pseoCatalog.pages.filter((page) => page.cluster === cluster);
}

export function getPseoStaticParams(cluster: PseoCluster): Array<{ slug: string }> {
  return getPseoPagesByCluster(cluster).map((page) => ({ slug: page.slug }));
}

export function getRelatedPseoPages(
  page: PseoPageRecord,
  limit = 5,
): PseoRelatedPageLink[] {
  return page.relatedPageRefs
    .map((ref) => pseoPageByRef.get(ref))
    .filter((candidate): candidate is PseoPageRecord => Boolean(candidate))
    .slice(0, limit)
    .map((related) => ({
      cluster: related.cluster,
      slug: related.slug,
      title: related.title,
      primaryKeyword: related.primaryKeyword,
      href: getPseoPagePath(related.cluster, related.slug),
    }));
}

export function buildPseoMetadata(page: PseoPageRecord): Metadata {
  return {
    title: page.title,
    description: page.metaDescription,
    keywords: [page.primaryKeyword, ...page.secondaryKeywords],
    alternates: {
      canonical: page.canonicalPath,
    },
    openGraph: {
      title: page.ogTitle,
      description: page.ogDescription,
      type: "article",
      url: page.canonicalPath,
    },
    twitter: {
      card: "summary_large_image",
      title: page.ogTitle,
      description: page.ogDescription,
    },
    robots: {
      index: true,
      follow: true,
    },
  };
}
