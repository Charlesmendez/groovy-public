import assert from "node:assert/strict";
import test from "node:test";
import { getEdition } from "./edition";

const EDITION_ENV_KEYS = [
  "GROOVY_EDITION",
  "STRIPE_SECRET_KEY",
  "STRIPE_GROOVY_PERSONAL_PRICE_ID",
  "STRIPE_PERSONAL_PRICE_ID",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
] as const;

function withEditionEnv(
  values: Partial<Record<(typeof EDITION_ENV_KEYS)[number], string>>,
  run: () => void
) {
  const previous = Object.fromEntries(
    EDITION_ENV_KEYS.map((key) => [key, process.env[key]])
  ) as Record<string, string | undefined>;
  for (const key of EDITION_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    run();
  } finally {
    for (const key of EDITION_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("defaults to cloud when no edition is configured", () => {
  withEditionEnv({}, () => assert.equal(getEdition(), "cloud"));
});

test("defaults to cloud when Stripe is configured", () => {
  withEditionEnv({ STRIPE_SECRET_KEY: "configured" }, () =>
    assert.equal(getEdition(), "cloud")
  );
});

test("explicit edition overrides environment inference", () => {
  withEditionEnv(
    { GROOVY_EDITION: "self-hosted", STRIPE_SECRET_KEY: "configured" },
    () => assert.equal(getEdition(), "self-hosted")
  );
});
