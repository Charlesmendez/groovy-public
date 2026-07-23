const mutationQueues = new Map<string, Promise<void>>();

export async function withWikiMutationLock<T>(
  userId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = mutationQueues.get(userId) || Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  mutationQueues.set(userId, tail);

  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release?.();
    if (mutationQueues.get(userId) === tail) {
      mutationQueues.delete(userId);
    }
  }
}
