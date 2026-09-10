import assert from "node:assert/strict";
import test from "node:test";
import {
  extractFocusZeroScene,
  focusZeroFallback,
  focusZeroSeed,
  parseFocusZeroScene,
} from "./focusZero";

test("a valid AI scene recipe is preserved", () => {
  assert.deepEqual(
    parseFocusZeroScene({
      motif: "garden",
      palette: "meadow",
      title: "A small clearing",
      note: "You made room for the work that matters.",
      seed: 812,
    }),
    {
      motif: "garden",
      palette: "meadow",
      title: "A small clearing",
      note: "You made room for the work that matters.",
      seed: 812,
    },
  );
});

test("unsafe or malformed model choices collapse to a constrained recipe", () => {
  const scene = extractFocusZeroScene(
    '```json\n{"motif":"<script>","palette":"url(javascript:bad)","title":"","seed":"nope"}\n```',
    91,
  );
  assert.deepEqual(scene, focusZeroFallback(91));
});

test("scene copy is single-line and bounded", () => {
  const scene = parseFocusZeroScene({
    motif: "orbit",
    palette: "aurora",
    title: `Quiet\n${"x".repeat(80)}`,
    note: `Clear\t${"y".repeat(140)}`,
    seed: -12,
  });
  assert.equal(scene.title.includes("\n"), false);
  assert.equal(scene.title.length, 48);
  assert.equal(scene.note.length, 110);
  assert.equal(scene.seed, 12);
});

test("the same private cache key produces the same visual seed", () => {
  assert.equal(focusZeroSeed("user:2026-07-27"), focusZeroSeed("user:2026-07-27"));
  assert.notEqual(
    focusZeroSeed("user:2026-07-27"),
    focusZeroSeed("user:2026-07-28"),
  );
});
