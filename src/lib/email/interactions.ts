import type { EmailView } from "@/lib/email/types";

export type EmailWorkspaceOperation =
  | "archive"
  | "spam"
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "move_focus"
  | "move_inbox"
  | "move_noise"
  | "move_handled";

export type EmailSwipeAction = {
  label: "Done" | "Focus" | "Needs Review" | "Noise";
  description: string;
  operation: Extract<
    EmailWorkspaceOperation,
    "move_focus" | "move_handled" | "move_inbox" | "move_noise"
  >;
  tone: "positive" | "quiet";
};

export function canMarkEmailDone(view: EmailView): boolean {
  return view !== "handled" && view !== "sent";
}

export function getEmailSwipeActions(
  view: EmailView,
  options: { recoverToFocus?: boolean } = {},
): {
  right: EmailSwipeAction;
  left: EmailSwipeAction;
} {
  if (view === "noise") {
    return {
      right: options.recoverToFocus
        ? {
            label: "Focus",
            description: "Return to Focus",
            operation: "move_focus",
            tone: "positive",
          }
        : {
            label: "Needs Review",
            description: "Return to Needs Review",
            operation: "move_inbox",
            tone: "positive",
          },
      left: {
        label: "Done",
        description: "Move to Handled",
        operation: "move_handled",
        tone: "quiet",
      },
    };
  }
  if (view === "handled") {
    return {
      right: options.recoverToFocus
        ? {
            label: "Focus",
            description: "Return to Focus",
            operation: "move_focus",
            tone: "positive",
          }
        : {
            label: "Needs Review",
            description: "Return to Needs Review",
            operation: "move_inbox",
            tone: "positive",
          },
      left: {
        label: "Noise",
        description: "Move to Noise",
        operation: "move_noise",
        tone: "quiet",
      },
    };
  }
  return {
    right: {
      label: "Done",
      description: "Move to Handled",
      operation: "move_handled",
      tone: "positive",
    },
    left: {
      label: "Noise",
      description: "Move to Noise",
      operation: "move_noise",
      tone: "quiet",
    },
  };
}
