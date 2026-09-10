export const FOCUS_ZERO_MOTIFS = [
  "orbit",
  "garden",
  "mountains",
  "ocean",
  "constellation",
  "city",
] as const;

export const FOCUS_ZERO_PALETTE_NAMES = [
  "aurora",
  "sunrise",
  "moon",
  "meadow",
  "cobalt",
  "ember",
] as const;

export type FocusZeroMotif = (typeof FOCUS_ZERO_MOTIFS)[number];
export type FocusZeroPaletteName =
  (typeof FOCUS_ZERO_PALETTE_NAMES)[number];

export type FocusZeroScene = {
  motif: FocusZeroMotif;
  palette: FocusZeroPaletteName;
  title: string;
  note: string;
  seed: number;
};

export const FOCUS_ZERO_PALETTES: Record<
  FocusZeroPaletteName,
  readonly [string, string, string, string]
> = {
  aurora: ["#67e8f9", "#a78bfa", "#34d399", "#0f172a"],
  sunrise: ["#fda4af", "#fbbf24", "#fb7185", "#1c1917"],
  moon: ["#c4b5fd", "#93c5fd", "#e2e8f0", "#111827"],
  meadow: ["#6ee7b7", "#bef264", "#fef08a", "#052e2b"],
  cobalt: ["#60a5fa", "#22d3ee", "#818cf8", "#0c1b33"],
  ember: ["#fb7185", "#fdba74", "#fca5a5", "#281414"],
};

const DEFAULT_TITLES: Record<FocusZeroMotif, string> = {
  orbit: "The orbit is quiet",
  garden: "A little room to grow",
  mountains: "You cleared the ridge",
  ocean: "The water is still",
  constellation: "Nothing needs you now",
  city: "The lights can wait",
};

const DEFAULT_NOTES: Record<FocusZeroMotif, string> = {
  orbit: "Focus Zero. Your attention is yours again.",
  garden: "Focus Zero. Leave a little space for what comes next.",
  mountains: "Focus Zero. Enjoy the view before the next climb.",
  ocean: "Focus Zero. No urgent current is pulling at you.",
  constellation: "Focus Zero. The important things are already handled.",
  city: "Focus Zero. The signal is clear and the noise is gone.",
};

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function cleanCopy(value: unknown, fallback: string, limit: number): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, limit);
  return cleaned || fallback;
}

function isMotif(value: unknown): value is FocusZeroMotif {
  return FOCUS_ZERO_MOTIFS.includes(value as FocusZeroMotif);
}

function isPalette(value: unknown): value is FocusZeroPaletteName {
  return FOCUS_ZERO_PALETTE_NAMES.includes(value as FocusZeroPaletteName);
}

export function focusZeroFallback(seed = 47): FocusZeroScene {
  const normalized = Math.abs(Math.floor(seed)) || 47;
  const motif = FOCUS_ZERO_MOTIFS[normalized % FOCUS_ZERO_MOTIFS.length];
  const palette =
    FOCUS_ZERO_PALETTE_NAMES[
      Math.floor(normalized / FOCUS_ZERO_MOTIFS.length) %
        FOCUS_ZERO_PALETTE_NAMES.length
    ];
  return {
    motif,
    palette,
    title: DEFAULT_TITLES[motif],
    note: DEFAULT_NOTES[motif],
    seed: normalized % 1_000_000,
  };
}

export function parseFocusZeroScene(
  value: unknown,
  fallbackSeed = 47,
): FocusZeroScene {
  const candidate = record(value);
  const fallback = focusZeroFallback(fallbackSeed);
  const motif = isMotif(candidate.motif) ? candidate.motif : fallback.motif;
  const rawSeed = Number(candidate.seed);
  const seed = Number.isFinite(rawSeed)
    ? Math.abs(Math.floor(rawSeed)) % 1_000_000
    : fallback.seed;
  return {
    motif,
    palette: isPalette(candidate.palette)
      ? candidate.palette
      : fallback.palette,
    title: cleanCopy(candidate.title, DEFAULT_TITLES[motif], 48),
    note: cleanCopy(candidate.note, DEFAULT_NOTES[motif], 110),
    seed,
  };
}

export function extractFocusZeroScene(
  modelOutput: string,
  fallbackSeed = 47,
): FocusZeroScene {
  const fenced = modelOutput
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return focusZeroFallback(fallbackSeed);
  try {
    return parseFocusZeroScene(
      JSON.parse(fenced.slice(start, end + 1)),
      fallbackSeed,
    );
  } catch {
    return focusZeroFallback(fallbackSeed);
  }
}

export function focusZeroSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % 1_000_000;
}
