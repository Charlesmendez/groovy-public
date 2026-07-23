import { TeamChatClient } from "@/components/chat/TeamChatClient";

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}) {
  const { channelId } = await params;
  return <TeamChatClient initialChannelId={channelId} />;
}
