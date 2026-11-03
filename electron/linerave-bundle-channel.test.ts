import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ userData: "", appVersion: "0.1.4" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => env.userData,
    getVersion: () => env.appVersion,
    isPackaged: false,
  },
}));

import {
  LINERAVE_BUNDLE_CHANNEL_ENABLED,
  LINERAVE_BUNDLE_PUBLIC_KEY_HEX,
  LineraveBundleChannel,
  type LineraveBundleManifest,
} from "./linerave-bundle-channel";

// Linerave's OWN signed bundle channel (Step 3). Unlike upstream's gated
// channel, this one is meant to work — so the suite asserts the full
// contract: only bundles signed by OUR key are staged, they apply at the
// next launch, an app too old is refused the bundle, and a bundle whose
// boot is never confirmed rolls back to last-good and is refused forever.

const FEED = "https://feed.test";
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyHex = publicKey
  .export({ format: "der", type: "spki" })
  .toString("hex");
const stranger = crypto.generateKeyPairSync("ed25519");

let root: string;
let builtInDist: string;
let offer: { manifest: LineraveBundleManifest; bytes: Buffer } | null;

function makeBundle(
  version: string,
  opts: {
    signWith?: crypto.KeyObject;
    minAppVersion?: string;
    channel?: string;
  } = {},
): { manifest: LineraveBundleManifest; bytes: Buffer } {
  const work = fs.mkdtempSync(path.join(root, "src-"));
  fs.mkdirSync(path.join(work, "dist"));
  fs.writeFileSync(
    path.join(work, "dist", "index.html"),
    `<html>${version}</html>`,
  );
  const archive = path.join(work, "bundle.tar.gz");
  tar.create({ gzip: true, file: archive, cwd: work, sync: true }, ["dist"]);
  const bytes = fs.readFileSync(archive);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const signature = crypto
    .sign(null, Buffer.from(sha256, "utf8"), opts.signWith || privateKey)
    .toString("hex");
  return {
    bytes,
    manifest: {
      bundleVersion: version,
      minAppVersion: opts.minAppVersion || "0.1.0",
      channel: opts.channel || "linerave",
      assetName: `linerave-bundle-${version}.tar.gz`,
      sha256,
      size: bytes.length,
      signature,
      releasedAt: "2026-11-02T00:00:00.000Z",
    },
  };
}

const fakeFetch = async (url: string) => {
  if (!offer) throw new Error("no offer");
  if (url.includes("linerave-bundle-manifest.json")) {
    return {
      ok: true,
      json: async () => offer!.manifest,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }
  if (url.includes(offer.manifest.assetName)) {
    const bytes = offer.bytes;
    return {
      ok: true,
      json: async () => ({}),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  }
  throw new Error(`unexpected fetch ${url}`);
};

function makeChannel(extra: Record<string, unknown> = {}) {
  return new LineraveBundleChannel({
    defaultRendererDist: builtInDist,
    feedBaseUrl: FEED,
    publicKeyHex,
    bundlesRoot: path.join(root, "lb"),
    appVersion: "0.1.4",
    fetchImpl: fakeFetch as never,
    ...extra,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "linerave-bundles-"));
  env.userData = root;
  builtInDist = path.join(root, "built-in");
  fs.mkdirSync(builtInDist, { recursive: true });
  fs.writeFileSync(path.join(builtInDist, "index.html"), "<html>built</html>");
  offer = null;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("LineraveBundleChannel", () => {
  it("is enabled under its own gate, separate from upstream's", () => {
    expect(LINERAVE_BUNDLE_CHANNEL_ENABLED).toBe(true);
  });

  it("stages a correctly signed bundle and applies it at next launch", async () => {
    offer = makeBundle("0.1.5");
    const first = makeChannel();
    const result = await first.checkInBackground();
    expect(result.staged).toBe(true);
    expect(first.getState().staged?.bundleVersion).toBe("0.1.5");
    // Not yet applied in the running session.
    expect(first.getState().active).toBeNull();

    const second = makeChannel();
    const indexPath = second.resolveIndexPath();
    expect(indexPath).toBeTruthy();
    expect(fs.readFileSync(indexPath!, "utf-8")).toBe("<html>0.1.5</html>");
    expect(second.getState().active?.bundleVersion).toBe("0.1.5");

    second.confirmBootHealthy();
    const third = makeChannel();
    expect(third.resolveIndexPath()).toBe(indexPath);
  });

  it("refuses a bundle signed by the wrong key", async () => {
    offer = makeBundle("0.1.5", { signWith: stranger.privateKey });
    const channel = makeChannel();
    const result = await channel.checkInBackground();
    expect(result.staged).toBe(false);
    expect(result.reason).toMatch(/signature/i);
    expect(channel.getState().staged).toBeNull();
    expect(channel.resolveIndexPath()).toBeNull();
  });

  it("refuses a tampered archive (hash mismatch)", async () => {
    const good = makeBundle("0.1.5");
    const tampered = Buffer.from(good.bytes);
    tampered[tampered.length - 5] ^= 0xff;
    offer = { manifest: good.manifest, bytes: tampered };
    const channel = makeChannel();
    const result = await channel.checkInBackground();
    expect(result.staged).toBe(false);
    expect(channel.getState().staged).toBeNull();
  });

  it("refuses a manifest for another channel", async () => {
    offer = makeBundle("0.1.5", { channel: "upstream" });
    const channel = makeChannel();
    const result = await channel.checkInBackground();
    expect(result.staged).toBe(false);
    expect(channel.getState().staged).toBeNull();
  });

  it("refuses a bundle whose minAppVersion exceeds the running app", async () => {
    offer = makeBundle("0.2.0", { minAppVersion: "0.2.0" });
    const channel = makeChannel();
    const result = await channel.checkInBackground();
    expect(result.staged).toBe(false);
    expect(result.reason).toMatch(/needs app/);
    expect(channel.getState().staged).toBeNull();
    expect(channel.resolveIndexPath()).toBeNull();
  });

  it("rolls back to last-good when a promoted bundle never confirms its boot, and refuses it afterwards", async () => {
    // Get 0.1.5 active and confirmed (the last-good).
    offer = makeBundle("0.1.5");
    const a = makeChannel();
    await a.checkInBackground();
    const b = makeChannel();
    const goodIndex = b.resolveIndexPath();
    b.confirmBootHealthy();

    // Offer 0.1.6; it stages and promotes at next launch…
    const bad = makeBundle("0.1.6");
    offer = bad;
    const c = makeChannel();
    expect((await c.checkInBackground()).staged).toBe(true);
    const d = makeChannel();
    const badIndex = d.resolveIndexPath();
    expect(badIndex).not.toBe(goodIndex);
    expect(fs.readFileSync(badIndex!, "utf-8")).toBe("<html>0.1.6</html>");
    // …but its boot is never confirmed (it was broken). Next launch:
    const e = makeChannel();
    expect(e.resolveIndexPath()).toBe(goodIndex);
    expect(e.getState().active?.bundleVersion).toBe("0.1.5");

    // And the identical bad artifact (same version + same hash) can
    // never be staged again.
    offer = bad;
    const f = makeChannel();
    const again = await f.checkInBackground();
    expect(again.staged).toBe(false);
    expect(again.reason).toMatch(/rolled back/);
  });

  it("ships a well-formed production public key with the recorded fingerprint", () => {
    const der = Buffer.from(LINERAVE_BUNDLE_PUBLIC_KEY_HEX, "hex");
    const key = crypto.createPublicKey({
      key: der,
      format: "der",
      type: "spki",
    });
    expect(key.asymmetricKeyType).toBe("ed25519");
    const fingerprint = crypto.createHash("sha256").update(der).digest("hex");
    expect(fingerprint).toBe(
      "b1607513c74ed8a7318c39892e31c5d57c9b7c864ad7d49925fd02bf51839ba1",
    );
    // The production-key channel refuses a stranger-signed bundle.
    return (async () => {
      offer = makeBundle("0.1.5", { signWith: stranger.privateKey });
      const channel = new LineraveBundleChannel({
        defaultRendererDist: builtInDist,
        feedBaseUrl: FEED,
        bundlesRoot: path.join(root, "lb-prod"),
        appVersion: "0.1.4",
        fetchImpl: fakeFetch as never,
      });
      const result = await channel.checkInBackground();
      expect(result.staged).toBe(false);
    })();
  });
});
