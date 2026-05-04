import type { MetadataRoute } from "next";

import { getPseoCatalog, getSiteBaseUrl } from "@/lib/pseo/catalog";

const STATIC_PUBLIC_ROUTES = [
  {
    path: "/",
    changeFrequency: "weekly" as const,
    priority: 1,
  },
  {
    path: "/setup",
    changeFrequency: "monthly" as const,
    priority: 0.9,
  },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const siteBase = getSiteBaseUrl();
  const now = new Date();
  const catalog = getPseoCatalog();

  const staticEntries: MetadataRoute.Sitemap = STATIC_PUBLIC_ROUTES.map((route) => ({
    url: `${siteBase}${route.path}`,
    lastModified: now,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  const pseoEntries: MetadataRoute.Sitemap = catalog.pages.map((page) => ({
    url: `${siteBase}${page.canonicalPath}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [...staticEntries, ...pseoEntries];
}
