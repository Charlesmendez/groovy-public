import { after } from "next/server";

export function scheduleAfterResponse(
  operation: () => Promise<void>,
  label: string
): Promise<void> {
  const run = async () => {
    try {
      await operation();
    } catch (error) {
      console.error(
        `[afterResponse] ${label} failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  try {
    after(run);
    return Promise.resolve();
  } catch {
    return run();
  }
}
