import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";
import { panelProcessor } from "./tools/embedded-ui.mjs";

export default [
  {
    ignores: [
      "node_modules/**",
      "data/**",
      "protocol/**",
      "build/**",
      "dist/**",
      "docs/**",
      // 用户下载的扩展原始素材（已移植到 extensions/，不参与仓库代码规范）
      "插件及SKILL/**",
      // 移植过来的扩展包保持上游原样（边界由 tools/security-test.mjs 扫描）
      "extensions/plugins/**",
      "extensions/skills/**",
      // 打包前由 tools/gen-extensions.mjs 自动生成
      "lib/extensions.generated.mjs",
    ],
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
  // 插件/技能扩展是 .js 的 ESM（Node 环境），和主程序用同一套规则
  { files: ["extensions/**/*.js"], languageOptions: { globals: globals.node } },
  { files: ["lib/ui-app.mjs"], processor: panelProcessor },
  {
    files: ["**/*.browser.js"],
    languageOptions: { globals: { ...globals.browser, ICONS: "readonly" } },
  },
  prettier,
];
