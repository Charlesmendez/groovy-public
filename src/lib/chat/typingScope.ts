export type ChatTypingScopeQuery<Query> = {
  eq: (column: string, value: string) => Query;
  is: (column: string, value: null) => Query;
};

export function scopeChatTypingQuery<
  Query extends ChatTypingScopeQuery<Query>,
>(query: Query, threadRootMessageId: string | null): Query {
  return threadRootMessageId
    ? query.eq("thread_root_message_id", threadRootMessageId)
    : query.is("thread_root_message_id", null);
}
