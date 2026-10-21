import { describe, expect, it } from "vitest";
import { deriveKeysFromRootBits } from "./crypto";
import { derivePublishKey, fromBase64Url, openBundle, publicNoteUrl, sealBundle, toBase64Url } from "./publish";

const bundle = { v: 1 as const, title: "Hello", markdown: "# Hi\n\nÜber **uns**", images: { "a.png": "data:image/png;base64,AAAA" }, publishedAt: "2026-01-01T00:00:00Z" };

describe("publish", () => {
  it("round-trips a bundle with the key from the link", async () => {
    const keys = await deriveKeysFromRootBits(new Uint8Array(32).fill(7));
    const key = await derivePublishKey(keys.hmacKey, "file-1");
    expect(key.length).toBe(32);
    const blob = await sealBundle(bundle, key);
    expect(await openBundle(blob, key)).toEqual(bundle);
  });

  it("derives a stable key per file and a different one per file", async () => {
    const keys = await deriveKeysFromRootBits(new Uint8Array(32).fill(7));
    const a1 = await derivePublishKey(keys.hmacKey, "a");
    const a2 = await derivePublishKey(keys.hmacKey, "a");
    const b = await derivePublishKey(keys.hmacKey, "b");
    expect(toBase64Url(a1)).toBe(toBase64Url(a2));
    expect(toBase64Url(a1)).not.toBe(toBase64Url(b));
  });

  it("refuses a wrong key", async () => {
    const keys = await deriveKeysFromRootBits(new Uint8Array(32).fill(7));
    const blob = await sealBundle(bundle, await derivePublishKey(keys.hmacKey, "a"));
    await expect(openBundle(blob, await derivePublishKey(keys.hmacKey, "b"))).rejects.toBeTruthy();
  });

  it("round-trips base64url and builds the link", () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2, 62, 63]);
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
    expect(publicNoteUrl("https://x.test/", "abc", bytes)).toMatch(/^https:\/\/x\.test\/p\/abc#[A-Za-z0-9_-]+$/);
  });
});
