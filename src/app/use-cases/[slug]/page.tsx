import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PseoLandingTemplate } from "@/components/marketing/PseoLandingTemplate";
import {
  buildPseoMetadata,
  getPseoPage,
  getPseoStaticParams,
  getRelatedPseoPages,
  getSiteBaseUrl,
} from "@/lib/pseo/catalog";

type RouteParams = {
  slug: string;
};

export const dynamicParams = false;

export function generateStaticParams(): Array<{ slug: string }> {
  return getPseoStaticParams("use-cases");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getPseoPage("use-cases", slug);
  if (!page) {
    return {
      title: "Page not found",
      robots: { index: false, follow: false },
    };
  }
  return buildPseoMetadata(page);
}

export default async function UseCasesPseoPage({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const { slug } = await params;
  const page = getPseoPage("use-cases", slug);
  if (!page) notFound();

  const canonicalUrl = `${getSiteBaseUrl()}${page.canonicalPath}`;
  const relatedPages = getRelatedPseoPages(page, 5);

  return (
    <PseoLandingTemplate
      page={page}
      canonicalUrl={canonicalUrl}
      relatedPages={relatedPages}
    />
  );
}
