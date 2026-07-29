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
    ".vinext/**",
    ".wrangler/**",
    "out/**",
    "build/**",
    "dist/**",
    "desktop-dist/**",
    "release/**",
    "outputs/**",
    "node_modules/**",
    "server/node_modules/**",
    "cloudflare-types.d.ts",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
