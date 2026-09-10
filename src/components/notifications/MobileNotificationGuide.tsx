import { Smartphone } from "lucide-react";

/** Shared opt-in guidance: iOS Home Screen requirements do not apply to Android Chrome. */
export function MobileNotificationGuide({
  compact = false,
  className = "",
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <aside
      aria-label="Mobile notification setup"
      className={`rounded-xl border border-cyan-300/15 bg-cyan-300/[0.04] ${compact ? "p-3 text-[11px]" : "p-4 text-xs"} leading-relaxed ${className}`}
    >
      <div className="flex items-center gap-2 font-medium text-cyan-100">
        <Smartphone
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-cyan-300"
        />
        Notifications on your phone
      </div>
      <p className="mt-2 text-zinc-300">
        <strong className="font-medium text-zinc-100">
          iPhone &amp; iPad:
        </strong>{" "}
        notifications only work in the Home Screen app, not in a browser tab.
        Add Groovy to your Home Screen and open it from its icon first.
      </p>
      <details className="mt-2">
        <summary className="w-fit cursor-pointer rounded py-1 font-medium text-cyan-200 outline-none hover:text-cyan-100 focus-visible:ring-2 focus-visible:ring-cyan-300/60">
          How to set up iPhone or iPad
        </summary>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-zinc-300 marker:text-cyan-300">
          <li>
            Open Groovy in Safari. Tap{" "}
            <strong className="font-medium text-zinc-100">Share</strong>, then{" "}
            <strong className="font-medium text-zinc-100">
              Add to Home Screen
            </strong>
            . If shown, keep{" "}
            <strong className="font-medium text-zinc-100">
              Open as Web App
            </strong>{" "}
            on, then tap{" "}
            <strong className="font-medium text-zinc-100">Add</strong>.
          </li>
          <li>
            Open Groovy from the new Home Screen icon and sign in if asked.
          </li>
          <li>
            Return to notifications, choose which conversations can alert you,
            and tap <strong className="font-medium text-zinc-100">Allow</strong>{" "}
            when prompted.
          </li>
        </ol>
        <p className="mt-2 text-zinc-400">
          Requires iOS or iPadOS 16.4 or later.
        </p>
      </details>
      <p className="mt-2 text-zinc-400">
        <strong className="font-medium text-zinc-300">Android:</strong>{" "}
        supported browsers such as Chrome can notify you without installing
        Groovy. Allow notifications when prompted.
      </p>
    </aside>
  );
}
