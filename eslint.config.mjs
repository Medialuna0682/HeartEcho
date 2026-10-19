import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";
import { panelProcessor } from "./tools/embedded-ui.mjs";

export default [
  {
    ignores: ["node_modules/**", "data/**", "protocol/**", "build/**", "dist/**", "docs/**"],
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  { files: ["**/*.mjs"], languageOptions: { globals: globals.node } },
  { files: ["lib/ui-app.mjs"], processor: panelProcessor },
  {
    files: ["**/*.browser.js"],
    languageOptions: { globals: { ...globals.browser, ICONS: "readonly" } },
  },
  prettier,
];
