export type ChatSearchRoom = {
  kind: "channel" | "dm";
  name: string;
};

export function chatSearchRoomScopeLabel(room: ChatSearchRoom): string {
  return `in:${room.kind === "channel" ? "#" : "@"}${room.name}`;
}
