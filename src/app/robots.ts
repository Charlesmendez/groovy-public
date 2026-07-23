import type { MetadataRoute } from "next";

import { getSiteBaseUrl } from "@/lib/pseo/catalog";

export default function robots(): MetadataRoute.Robots {
  const siteBase = getSiteBaseUrl();

  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/alternatives/", "/use-cases/", "/integrations/", "/setup"],
        disallow: [
          "/api/",
          "/admin/",
          "/dashboard/",
          "/invite/",
          "/login",
          "/whatsapp/success",
          "/whatsapp/failed",
        ],
      },
    ],
    sitemap: `${siteBase}/sitemap.xml`,
    host: siteBase,
  };
}
