import { HarnessWidget } from "@/components/widget/HarnessWidget";

export const dynamic = "force-dynamic";

export default async function WidgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ key?: string; parentOrigin?: string }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const publishableKey = typeof query.key === "string" ? query.key : "";
  let parentOrigin = "";
  try {
    parentOrigin = new URL(query.parentOrigin || "").origin;
  } catch {
    parentOrigin = "";
  }
  if (!publishableKey || !parentOrigin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white p-6 text-center text-sm text-zinc-600">
        This widget is missing its publishable key or embedding origin.
      </div>
    );
  }
  return (
    <HarnessWidget
      slug={slug}
      publishableKey={publishableKey}
      parentOrigin={parentOrigin}
    />
  );
}
