export type EmailAssistTask = "complete" | "rewrite" | "draft" | "steer";

export type EmailAssistGeneration = {
  text: string;
  finishReason?: string;
  outputTokens?: number;
  textTokens?: number;
  reasoningTokens?: number;
};

export type EmailAssistGenerationResult = EmailAssistGeneration & {
  attempts: number;
  status: "suggestion" | "no_suggestion";
};

const EMPTY_COMPLETION_RECOVERY = `The prior attempt returned no visible text.
Return exactly one short, natural continuation from the cursor position.
If the current sentence is complete, return the most likely next sentence from the email context.
Do not repeat any existing draft text and do not return an empty response.`;

export function cleanEmailAssistOutput(value: string): string {
  return value
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export async function generateEmailAssistWithRecovery(args: {
  task: EmailAssistTask;
  prompt: string;
  generate(prompt: string): Promise<EmailAssistGeneration>;
}): Promise<EmailAssistGenerationResult> {
  const maxAttempts = args.task === "complete" ? 2 : 1;
  let last: EmailAssistGeneration = { text: "" };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt =
      attempt === 1
        ? args.prompt
        : `${args.prompt}\n\n${EMPTY_COMPLETION_RECOVERY}`;
    last = await args.generate(prompt);
    const output = cleanEmailAssistOutput(last.text);
    if (output) {
      return {
        ...last,
        text: output,
        attempts: attempt,
        status: "suggestion",
      };
    }
  }

  return {
    ...last,
    text: "",
    attempts: maxAttempts,
    status: "no_suggestion",
  };
}
