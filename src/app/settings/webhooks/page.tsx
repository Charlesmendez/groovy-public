import { IncomingWebhookSettings } from "@/components/settings/IncomingWebhookSettings";

export default async function SettingsWebhooksPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string }>;
}) {
  const { channel } = await searchParams;
  return <IncomingWebhookSettings initialChannelId={channel} />;
}
