# Syncstone for Obsidian

Syncs your Obsidian vaults end-to-end encrypted - with the hosted Syncstone service (the default) or with a **Syncstone
server** you run yourself (see the `websync` server repository; switch it on under *Advanced* in the plugin settings).

- Notes and attachments are encrypted on your device; the server only stores ciphertext.
- Version history, trash and restore, live collaboration, sharing and publishing.
- Desktop and mobile.

## Install

**Community plugins (coming soon):** Obsidian -> Settings -> Community plugins -> Browse -> search for *Syncstone*.

**Today, with [BRAT](https://github.com/TfTHacker/obsidian42-brat):**

1. Install **BRAT** from Settings -> Community plugins -> Browse and enable it.
2. Open the BRAT settings, choose **Add beta plugin** and enter `https://github.com/20Bosko07/websync-plugin`.
3. Enable **Syncstone** under Settings -> Community plugins, then sign in (below).

BRAT keeps the plugin up to date with the releases of this repository.

## Signing in

The plugin has no login fields. Enter the address of your Syncstone server in the plugin settings (your own, a company
server, or a hosted one - it is just a URL), press "Sign in", and approve the device in the browser: you sign in on the
server's web page with your username and password (plus authenticator / passkey if you set one up) and pick the vault.

## Disclosures (Obsidian developer policies)

- **Network use:** the plugin talks only to a Syncstone server: the hosted service by default, or the address of your own
  server if you switch on self-hosting in the settings. There is no telemetry, no analytics and no other third-party
  request.
- **Account required:** you need an account on a Syncstone server. Self-hosting is free; a hosted service may charge.
- **No self-update:** the plugin never downloads or runs code other than what Obsidian installed.
- **Lost passphrase = lost data:** the encryption key is derived from your vault passphrase and never leaves your device.

## Development

```bash
pnpm install
pnpm dev          # esbuild watch -> main.js
pnpm build        # typecheck + production bundle
pnpm test         # tests of the shared crypto/protocol code
```

Copy `manifest.json`, `main.js` and `styles.css` to `<vault>/.obsidian/plugins/websync/` to try it.

### `shared/`

`shared/` is the crypto and wire-protocol code that the plugin and the Syncstone server must agree on byte for byte.
It is **copied** from the server repository, never edited here:

```bash
pnpm sync-shared ../websync
```

## Releasing

1. Bump `version` in `manifest.json` and add the version to `versions.json`.
2. Tag the commit with exactly that version (`git tag 0.1.1 && git push --tags`, no leading `v`).
3. The `release` workflow builds and attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release.

The plugin `id` (`websync`) must never change once users have installed it.

## License

MIT, see [LICENSE](LICENSE).
