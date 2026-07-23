import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "apps/connector/dist/**",
    "apps/desktop/dist/**",
    "apps/desktop/dist-app/**",
    "apps/desktop/node_modules/**",
    "apps/desktop/resources/connector/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
