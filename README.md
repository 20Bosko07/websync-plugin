# WebSync for Obsidian

Syncs your Obsidian vaults end-to-end encrypted - with the hosted WebSync service (the default) or with a **WebSync
server** you run yourself (see the `websync` server repository; switch it on under *Advanced* in the plugin settings).

- Notes and attachments are encrypted on your device; the server only stores ciphertext.
- Version history, trash and restore, live collaboration, sharing and publishing.
- Desktop and mobile.

## Disclosures (Obsidian developer policies)

- **Network use:** the plugin talks only to a WebSync server: the hosted service by default, or the address of your own
  server if you switch on self-hosting in the settings. There is no telemetry, no analytics and no other third-party
  request.
- **Account required:** you need an account on a WebSync server. Self-hosting is free; a hosted service may charge.
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

`shared/` is the crypto and wire-protocol code that the plugin and the WebSync server must agree on byte for byte.
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
