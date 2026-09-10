import assert from "node:assert/strict";
import test from "node:test";
import {
  getCanonicalAppUrl,
  getConfiguredAppUrl,
} from "./appConfig";

function withAppUrlEnv(
  values: {
    GROOVY_APP_URL?: string;
    NEXT_PUBLIC_APP_URL?: string;
    VERCEL_URL?: string;
  },
  run: () => void,
) {
  const prior = {
    GROOVY_APP_URL: process.env.GROOVY_APP_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    VERCEL_URL: process.env.VERCEL_URL,
  };
  for (const key of Object.keys(prior) as Array<keyof typeof prior>) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const key of Object.keys(prior) as Array<keyof typeof prior>) {
      const value = prior[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("canonical callbacks never use a Vercel deployment alias", () => {
  withAppUrlEnv(
    {
      VERCEL_URL: "groovy-preview-example.vercel.app",
    },
    () => {
      assert.equal(getCanonicalAppUrl(), null);
      assert.equal(
        getConfiguredAppUrl(),
        "https://groovy-preview-example.vercel.app",
      );
    },
  );
});

test("canonical callbacks prefer the explicitly configured public origin", () => {
  withAppUrlEnv(
    {
      GROOVY_APP_URL: "https://www.gogroovy.ai/",
      NEXT_PUBLIC_APP_URL: "https://secondary.example.com",
      VERCEL_URL: "groovy-preview-example.vercel.app",
    },
    () => {
      assert.equal(getCanonicalAppUrl(), "https://www.gogroovy.ai");
    },
  );
});
