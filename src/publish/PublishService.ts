import type { App, TFile } from "obsidian";
import { publicNoteUrl, sealBundle, toBase64, type PublishedBundle, type PublishedNote, type PublishOptions } from "@websync/shared";
import type { CryptoService } from "../sync/CryptoService.js";
import type { RemoteApiClient } from "../sync/RemoteApiClient.js";

/** Images embedded in a published note are inlined up to this much in total; further ones are left out. */
const IMAGE_BUDGET_BYTES = 6 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

export interface PublishDeps {
  app: App;
  remote: RemoteApiClient;
  crypto: CryptoService;
  vaultId: string;
  /** Address of the web app the link points to (`<web>/p/<id>#<key>`). */
  webBase: () => string | null;
}

/**
 * Public note links, like in the web editor: a note is published as an encrypted snapshot, the key to open it travels only
 * in the #fragment of the link. Only the owner of the vault can publish.
 */
export class PublishService {
  constructor(private readonly deps: PublishDeps) {}

  /** The vault's publications by file id. */
  async publications(): Promise<Map<string, PublishedNote>> {
    const list = await this.deps.remote.listPublications(this.deps.vaultId);
    return new Map(list.map((p) => [p.fileId, p] as const));
  }

  async linkOf(fileId: string, publication: PublishedNote): Promise<string> {
    return publicNoteUrl(this.webBase(), publication.id, await this.deps.crypto.publishKey(fileId));
  }

  /** Uploads the current text of the note (with the images it embeds, inlined) and returns the publication. */
  async publish(file: TFile, fileId: string, options: PublishOptions): Promise<PublishedNote> {
    const { app } = this.deps;
    const markdown = await app.vault.cachedRead(file);
    const images: Record<string, string> = {};
    let imageBytes = 0;
    for (const embed of app.metadataCache.getFileCache(file)?.embeds ?? []) {
      const name = embed.link.split("#")[0] ?? "";
      if (!name || images[name]) continue;
      const target = app.metadataCache.getFirstLinkpathDest(name, file.path);
      const mime = target ? IMAGE_MIME[target.extension.toLowerCase()] : undefined; // no SVG: it can carry scripts
      if (!target || !mime) continue;
      imageBytes += target.stat.size;
      if (imageBytes > IMAGE_BUDGET_BYTES) continue;
      images[name] = `data:${mime};base64,${toBase64(new Uint8Array(await app.vault.readBinary(target)))}`;
    }
    const bundle: PublishedBundle = { v: 1, title: file.basename, markdown, images, publishedAt: new Date().toISOString() };
    const blob = toBase64(await sealBundle(bundle, await this.deps.crypto.publishKey(fileId)));
    return this.deps.remote.publishNote(this.deps.vaultId, fileId, blob, options);
  }

  update(fileId: string, options: PublishOptions): Promise<PublishedNote> {
    return this.deps.remote.updatePublication(this.deps.vaultId, fileId, options);
  }

  remove(fileId: string): Promise<void> {
    return this.deps.remote.removePublication(this.deps.vaultId, fileId);
  }

  private webBase(): string {
    const base = this.deps.webBase();
    if (!base) throw new Error("web address unknown");
    return base;
  }
}
