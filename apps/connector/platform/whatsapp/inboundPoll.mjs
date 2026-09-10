export async function readLoadedMessageTail(page, chatId, limit) {
  if (!page || typeof page.evaluate !== "function") return [];
  const boundedLimit = Math.max(1, Math.min(30, Math.trunc(Number(limit) || 10)));
  return page.evaluate(({ targetChatId, messageLimit }) => {
    const serializeId = (value) => {
      if (typeof value === "string") return value;
      if (typeof value?._serialized === "string") return value._serialized;
      return "";
    };
    const store = window.Store;
    const rawChat = store?.Chat?.get?.(targetChatId);
    const collection = rawChat?.msgs;
    const models =
      (typeof collection?.getModelsArray === "function" && collection.getModelsArray()) ||
      (Array.isArray(collection?.models) && collection.models) ||
      [];
    return models.slice(-messageLimit).map((model) => ({
      id: {
        _serialized: serializeId(model?.id),
        id: String(model?.id?.id || ""),
        remote: serializeId(model?.id?.remote),
      },
      body: String(model?.body || ""),
      timestamp: Number(model?.t || model?.timestamp || 0),
      fromMe: model?.id?.fromMe === true || model?.fromMe === true,
      from: serializeId(model?.from),
      to: serializeId(model?.to),
    }));
  }, { targetChatId: chatId, messageLimit: boundedLimit });
}
