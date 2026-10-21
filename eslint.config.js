// @ts-check
import tseslint from "typescript-eslint";

/**
 * Platform-neutrality guardrail: this plugin must run identically on
 * Obsidian desktop (Electron) and Obsidian mobile (Capacitor WebView, no
 * Node.js, no native modules). `no-restricted-imports` below catches
 * accidental Node-only imports in `src/**` at lint time, so a slip doesn't
 * quietly break mobile until someone tests on a phone.
 */
export default tseslint.config(
  {
    ignores: ["main.js", "dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "fs",
              message:
                "Node's fs module does not exist on Obsidian mobile (Capacitor WebView). Use this.app.vault / this.app.vault.adapter instead.",
            },
            {
              name: "node:fs",
              message:
                "Node's fs module does not exist on Obsidian mobile (Capacitor WebView). Use this.app.vault / this.app.vault.adapter instead.",
            },
            {
              name: "path",
              message:
                "Node's path module does not exist on Obsidian mobile (Capacitor WebView). Handle vault-relative path strings manually.",
            },
            {
              name: "node:path",
              message:
                "Node's path module does not exist on Obsidian mobile (Capacitor WebView). Handle vault-relative path strings manually.",
            },
            {
              name: "electron",
              message:
                "Electron is not available on Obsidian mobile (Capacitor WebView). This plugin must run identically on desktop and mobile.",
            },
          ],
        },
      ],
    },
  },
);
