import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Plain apostrophes in UI copy are fine with React 19.
      "react/no-unescaped-entities": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // UI and tests consume loosely typed JSON from our own API. Server code stays strict.
    files: ["src/app/**/page.tsx", "src/components/**", "src/lib/client.ts", "tests/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
];

export default config;
