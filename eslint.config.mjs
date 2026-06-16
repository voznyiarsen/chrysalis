import globals from "globals";
import pluginJs from "@eslint/js";
import configPrettier from "eslint-config-prettier";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      "documentation/**",
      "minecraft-clients/**",
      "patching-scripts/**",
      "logs/**",
    ],
  },
  pluginJs.configs.recommended,
  configPrettier,
  {
    files: ["*.js", "tests/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "warn",
    },
  },
];
