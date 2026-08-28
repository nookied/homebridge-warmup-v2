import globals from "globals";
import pluginJs from "@eslint/js";
import pluginJest from "eslint-plugin-jest";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    // Third-party code kept close to the original so it stays auditable
    // against upstream — see src/vendor/fakegato-history/README.md.
    ignores: ["src/vendor/**"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      sourceType: "commonjs", // Change to "module" for ES6
      globals: {
        ...globals.node,
        ...globals.es2021,
        ...globals.jest, // Add Jest globals
      },
    },
  },
  pluginJs.configs.recommended,
  {
    plugins: {
      jest: pluginJest,
    },
    rules: {
      ...pluginJest.configs.recommended.rules,
      "no-unused-vars": "warn", // Change no-unused-vars to a warning
    },
  },
];