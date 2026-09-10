import type { EmailFeedResponse, EmailView } from "@/lib/email/types";

export type EmailNavigationStats = EmailFeedResponse["stats"];

export function mergeEmailNavigationStats(args: {
  current: EmailNavigationStats;
  incoming: EmailNavigationStats;
  sourceView: EmailView | "authoritative";
  authoritativeNeedsReviewCount?: number;
}): EmailNavigationStats {
  if (args.sourceView === "authoritative") {
    return {
      ...args.incoming,
      needsReview:
        args.authoritativeNeedsReviewCount ?? args.incoming.needsReview,
    };
  }

  return {
    ...args.incoming,
    // Focus is a live Gmail-backed queue. Other feeds only carry the bounded
    // action-index estimate, which can be lower than the real Focus total.
    focus:
      args.sourceView === "focus"
        ? args.incoming.focus
        : args.current.focus,
    draftsReady:
      args.sourceView === "focus"
        ? args.incoming.draftsReady
        : args.current.draftsReady,
    // Needs Review is authoritative only when backed by its materialized
    // Gmail list (or by a Focus response that explicitly counted that list).
    needsReview:
      args.authoritativeNeedsReviewCount ?? args.current.needsReview,
  };
}

export function navigationStatsFromCachedFeeds(args: {
  fallback: EmailNavigationStats;
  focus?: EmailNavigationStats | null;
  needsReviewCount?: number | null;
}): EmailNavigationStats {
  return {
    ...args.fallback,
    focus: args.focus?.focus ?? args.fallback.focus,
    draftsReady: args.focus?.draftsReady ?? args.fallback.draftsReady,
    needsReview: args.needsReviewCount ?? 0,
  };
}
