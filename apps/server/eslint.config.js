import globals from "globals";
import { config } from "@repo/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    // scripts/ はWorkers上ではなくローカルのNode.jsで実行するツール
    files: ["scripts/**/*.mjs", "tests/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
];
