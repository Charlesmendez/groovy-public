export function isPrivateLiveVoiceRequest() { return false; }
export function normalizePrivateLiveVoiceProvider() { return null; }
export function handlePrivateLiveVoiceProxy({ client }) {
  client?.close?.(1008, "voice_unavailable");
}
