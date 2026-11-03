import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import * as tar from "tar";

// LINERAVE'S OWN signed bundle channel (master plan Step 3).
//
// This is NOT upstream's OTA channel. Upstream's BundleManager stays
// permanently gated off (BUNDLE_UPDATES_DISABLED_FOR_LINERAVE in
// bundle-manager.ts, security audit SA-2 finding F1): its host and its
// signing key are upstream's, and Linerave must never run their frontend.
//
// This channel is ours in every particular: bundles are published to the
// user's own private repo (Dream-byte-lab/linerave-releases) and are
// accepted only if they carry an Ed25519 signature from OUR key, whose
// public half is pinned below. There are deliberately NO environment
// overrides for the feed or the key (SA-2 fix list), no IPC surface, and
// no UI: the user's ruling is that updates are fully automatic and the
// app must never prompt. A verified bundle is staged in the background
// and applied at the NEXT launch; a bundle that fails to boot is rolled
// back from automatically (see resolveIndexPath / confirmBootHealthy).
//
// Design: investigation/step3-signed-channel-design.md.

export const LINERAVE_BUNDLE_CHANNEL_ENABLED = true;

// Ed25519 public key (DER, SPKI) for Linerave bundle signing.
// Fingerprint (sha256 of this DER): b1607513c74ed8a7318c39892e31c5d57c9b7
// c864ad7d49925fd02bf51839ba1. The private half lives outside every repo
// (~/workspace/liner-liveRave/keys/linerave-bundle-signing.key) and, for
// the release pipeline, as a secret in linerave-releases.
export const LINERAVE_BUNDLE_PUBLIC_KEY_HEX =
  "302a300506032b6570032100f78be8be8569a835411378247fae27d8e43974308ba9c0c158d39d351777c6e0";

const BUNDLE_RELEASE_TAG = "bundle-latest";
const MANIFEST_ASSET_NAME = "linerave-bundle-manifest.json";
const MANIFEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface LineraveBundleManifest {
  bundleVersion: string;
  minAppVersion: string;
  channel: string;
  /** Bare asset file name inside the bundle release — never a URL. */
  assetName: string;
  sha256: string;
  size: number;
  /** Hex Ed25519 signature over the utf-8 bytes of the sha256 hex. */
  signature: string;
  releasedAt: string;
}

export interface LineraveBundleEntry {
  bundleVersion: string;
  bundleDir: string;
  sha256: string;
  minAppVersion: string;
  installedAt: string;
}

interface RefusedBundle {
  bundleVersion: string;
  sha256: string;
}

interface LineraveBundleState {
  active: LineraveBundleEntry | null;
  previous: LineraveBundleEntry | null;
  staged: LineraveBundleEntry | null;
  /** True while the active bundle has not yet proven a healthy boot. */
  pendingBoot: boolean;
  refused: RefusedBundle[];
}

interface GithubFeedConfig {
  owner: string;
  repo: string;
  token?: string;
}

type FetchImpl = typeof fetch;

export interface LineraveBundleChannelOptions {
  defaultRendererDist: string;
  /** Test/simple mode: serve manifest + archive from one base URL. */
  feedBaseUrl?: string;
  /** GitHub mode: defaults to the coordinates in app-update.yml. */
  github?: GithubFeedConfig;
  publicKeyHex?: string;
  bundlesRoot?: string;
  appVersion?: string;
  fetchImpl?: FetchImpl;
}

const EMPTY_STATE: LineraveBundleState = {
  active: null,
  previous: null,
  staged: null,
  pendingBoot: false,
  refused: [],
};

export class LineraveBundleChannel {
  private readonly defaultRendererDist: string;
  private readonly root: string;
  private readonly stateFilePath: string;
  private readonly publicKeyHex: string;
  private readonly appVersion: string;
  private readonly fetchImpl: FetchImpl;
  private readonly feedBaseUrl?: string;
  private readonly github?: GithubFeedConfig;
  private state: LineraveBundleState;
  private isChecking = false;

  constructor(options: LineraveBundleChannelOptions) {
    this.defaultRendererDist = options.defaultRendererDist;
    this.publicKeyHex = options.publicKeyHex || LINERAVE_BUNDLE_PUBLIC_KEY_HEX;
    this.appVersion = options.appVersion || app.getVersion();
    this.fetchImpl = options.fetchImpl || fetch;
    this.feedBaseUrl = options.feedBaseUrl;
    this.github = options.github || readAppUpdateConfig() || undefined;
    this.root =
      options.bundlesRoot ||
      path.join(app.getPath("userData"), "linerave-bundles");
    this.stateFilePath = path.join(this.root, "state.json");
    fs.mkdirSync(this.root, { recursive: true });
    this.state = this.loadState();
  }

  // ---------------------------------------------------------------- state

  private loadState(): LineraveBundleState {
    try {
      const raw = fs.readFileSync(this.stateFilePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<LineraveBundleState>;
      return {
        active: parsed.active ?? null,
        previous: parsed.previous ?? null,
        staged: parsed.staged ?? null,
        pendingBoot: parsed.pendingBoot === true,
        refused: Array.isArray(parsed.refused) ? parsed.refused : [],
      };
    } catch {
      return { ...EMPTY_STATE, refused: [] };
    }
  }

  private saveState(): void {
    try {
      fs.writeFileSync(
        this.stateFilePath,
        JSON.stringify(this.state, null, 2),
        "utf-8",
      );
    } catch (err) {
      console.warn("[LineraveBundles] Failed to save state:", err);
    }
  }

  private removeDir(dir: string | undefined | null): void {
    if (!dir) return;
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  // ------------------------------------------------------------- versions

  private compareVersions(left: string, right: string): number {
    const a = left.split("-")[0].split(".").map(Number);
    const b = right.split("-")[0].split(".").map(Number);
    for (let i = 0; i < 3; i += 1) {
      const diff = (a[i] || 0) - (b[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  /** appVersion >= minAppVersion (semver-ish, same rule as upstream's). */
  public isVersionCompatible(minAppVersion: string): boolean {
    if (!minAppVersion) return true;
    return this.compareVersions(this.appVersion, minAppVersion) >= 0;
  }

  private isUpgradeOver(manifest: LineraveBundleManifest): boolean {
    const baseline = this.state.staged || this.state.active;
    if (!baseline) return true;
    const order = this.compareVersions(
      manifest.bundleVersion,
      baseline.bundleVersion,
    );
    if (order !== 0) return order > 0;
    // Same version, different hash = a repair offer.
    return baseline.sha256.toLowerCase() !== manifest.sha256.toLowerCase();
  }

  private isRefused(manifest: LineraveBundleManifest): boolean {
    return this.state.refused.some(
      (r) =>
        r.bundleVersion === manifest.bundleVersion &&
        r.sha256.toLowerCase() === manifest.sha256.toLowerCase(),
    );
  }

  // --------------------------------------------------------- verification

  private verifySignature(sha256Hex: string, signatureHex: string): boolean {
    try {
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(this.publicKeyHex, "hex"),
        format: "der",
        type: "spki",
      });
      return crypto.verify(
        null,
        Buffer.from(sha256Hex, "utf-8"),
        publicKey,
        Buffer.from(signatureHex, "hex"),
      );
    } catch {
      return false;
    }
  }

  private hashFile(filePath: string): string {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex");
  }

  /**
   * Re-proves a bundle already on disk (SA-2 F2: a state file is not
   * proof). The bundle dir must still hold its archive and manifest, the
   * archive must hash to the recorded sha256, the manifest signature
   * must verify against our key, and dist/index.html must exist.
   */
  private verifyOnDisk(entry: LineraveBundleEntry): boolean {
    try {
      const archivePath = path.join(entry.bundleDir, "archive.tar.gz");
      const manifestPath = path.join(entry.bundleDir, "manifest.json");
      const indexPath = path.join(entry.bundleDir, "dist", "index.html");
      if (
        !fs.existsSync(archivePath) ||
        !fs.existsSync(manifestPath) ||
        !fs.existsSync(indexPath)
      ) {
        return false;
      }
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, "utf-8"),
      ) as LineraveBundleManifest;
      if (
        manifest.bundleVersion !== entry.bundleVersion ||
        manifest.sha256.toLowerCase() !== entry.sha256.toLowerCase()
      ) {
        return false;
      }
      if (
        this.hashFile(archivePath).toLowerCase() !== entry.sha256.toLowerCase()
      ) {
        return false;
      }
      return this.verifySignature(manifest.sha256, manifest.signature);
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ launch

  /**
   * Launch-time resolution, called before the main window loads. Handles
   * rollback of an unconfirmed bundle and promotion of a staged one.
   * Returns the index.html to serve, or null to serve the built-in dist.
   */
  public resolveIndexPath(): string | null {
    if (!LINERAVE_BUNDLE_CHANNEL_ENABLED) return null;

    // A previous launch ran the active bundle and never confirmed a
    // healthy boot: roll back before serving anything.
    if (this.state.pendingBoot && this.state.active) {
      const bad = this.state.active;
      console.warn(
        `[LineraveBundles] Bundle ${bad.bundleVersion} never confirmed a healthy boot — rolling back.`,
      );
      this.state.refused.push({
        bundleVersion: bad.bundleVersion,
        sha256: bad.sha256,
      });
      this.removeDir(bad.bundleDir);
      this.state.active =
        this.state.previous && this.verifyOnDisk(this.state.previous)
          ? this.state.previous
          : null;
      if (!this.state.active && this.state.previous) {
        this.removeDir(this.state.previous.bundleDir);
      }
      this.state.previous = null;
      this.state.pendingBoot = false;
      this.saveState();
    }

    // Promote a staged bundle, re-verified from disk first.
    if (this.state.staged) {
      const staged = this.state.staged;
      if (this.verifyOnDisk(staged)) {
        if (
          this.state.previous &&
          this.state.previous.bundleDir !== this.state.active?.bundleDir
        ) {
          this.removeDir(this.state.previous.bundleDir);
        }
        this.state.previous = this.state.active;
        this.state.active = staged;
        this.state.staged = null;
        this.state.pendingBoot = true;
        this.saveState();
      } else {
        console.warn(
          `[LineraveBundles] Staged bundle ${staged.bundleVersion} failed re-verification — discarding.`,
        );
        this.removeDir(staged.bundleDir);
        this.state.staged = null;
        this.saveState();
      }
    }

    if (this.state.active) {
      if (this.verifyOnDisk(this.state.active)) {
        return path.join(this.state.active.bundleDir, "dist", "index.html");
      }
      console.warn(
        `[LineraveBundles] Active bundle ${this.state.active.bundleVersion} failed re-verification — dropping it.`,
      );
      this.removeDir(this.state.active.bundleDir);
      this.state.active =
        this.state.previous && this.verifyOnDisk(this.state.previous)
          ? this.state.previous
          : null;
      this.state.previous = null;
      this.state.pendingBoot = false;
      this.saveState();
      if (this.state.active) {
        return path.join(this.state.active.bundleDir, "dist", "index.html");
      }
    }
    return null;
  }

  /** Lightweight lookup for secondary windows (no promotion/rollback). */
  public getActiveIndexPath(): string | null {
    if (!LINERAVE_BUNDLE_CHANNEL_ENABLED) return null;
    const active = this.state.active;
    if (!active) return null;
    const indexPath = path.join(active.bundleDir, "dist", "index.html");
    return fs.existsSync(indexPath) ? indexPath : null;
  }

  /** Called once the renderer has loaded and stayed alive. */
  public confirmBootHealthy(): void {
    if (this.state.pendingBoot) {
      this.state.pendingBoot = false;
      this.saveState();
    }
  }

  public getState(): Readonly<LineraveBundleState> {
    return this.state;
  }

  // -------------------------------------------------------------- feed

  private async fetchManifest(): Promise<LineraveBundleManifest> {
    if (this.feedBaseUrl) {
      const res = await this.fetchImpl(
        `${this.feedBaseUrl}/${MANIFEST_ASSET_NAME}?t=${Date.now()}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
        },
      );
      if (!res.ok) throw new Error(`Manifest fetch returned ${res.status}`);
      return (await res.json()) as LineraveBundleManifest;
    }
    const assetUrl = await this.githubAssetUrl(MANIFEST_ASSET_NAME);
    const res = await this.fetchImpl(assetUrl, {
      headers: this.githubHeaders(true),
      cache: "no-store",
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Manifest fetch returned ${res.status}`);
    return (await res.json()) as LineraveBundleManifest;
  }

  private async downloadArchive(
    manifest: LineraveBundleManifest,
  ): Promise<Buffer> {
    if (this.feedBaseUrl) {
      const res = await this.fetchImpl(
        `${this.feedBaseUrl}/${manifest.assetName}`,
        { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) },
      );
      if (!res.ok) throw new Error(`Download returned ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
    const assetUrl = await this.githubAssetUrl(manifest.assetName);
    const res = await this.fetchImpl(assetUrl, {
      headers: this.githubHeaders(true),
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Download returned ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private githubHeaders(forAsset: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: forAsset
        ? "application/octet-stream"
        : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.github?.token)
      headers.Authorization = `Bearer ${this.github.token}`;
    return headers;
  }

  private async githubAssetUrl(assetName: string): Promise<string> {
    if (!this.github) throw new Error("Bundle feed is not configured");
    const { owner, repo } = this.github;
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/releases/tags/${BUNDLE_RELEASE_TAG}`,
      {
        headers: this.githubHeaders(false),
        cache: "no-store",
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`Release lookup returned ${res.status}`);
    const release = (await res.json()) as {
      assets?: { name: string; url: string }[];
    };
    const asset = release.assets?.find((a) => a.name === assetName);
    if (!asset) throw new Error(`Asset ${assetName} not in bundle release`);
    return asset.url;
  }

  // ------------------------------------------------------------- check

  /**
   * Quiet background check: fetch, gate, download, verify, stage.
   * Never prompts, never throws; a staged bundle applies at next launch.
   */
  public async checkInBackground(): Promise<{
    staged: boolean;
    reason?: string;
  }> {
    if (!LINERAVE_BUNDLE_CHANNEL_ENABLED) {
      return { staged: false, reason: "Channel disabled" };
    }
    if (!this.feedBaseUrl && !this.github) {
      return { staged: false, reason: "Feed not configured" };
    }
    if (this.isChecking) return { staged: false, reason: "Already checking" };
    this.isChecking = true;
    try {
      const manifest = await this.fetchManifest();
      if (
        !manifest ||
        manifest.channel !== "linerave" ||
        !manifest.bundleVersion ||
        !manifest.assetName ||
        !manifest.sha256 ||
        !manifest.signature ||
        path.basename(manifest.assetName) !== manifest.assetName
      ) {
        return { staged: false, reason: "Malformed manifest" };
      }
      if (!this.isVersionCompatible(manifest.minAppVersion)) {
        return {
          staged: false,
          reason: `Bundle ${manifest.bundleVersion} needs app >= ${manifest.minAppVersion}`,
        };
      }
      if (this.isRefused(manifest)) {
        return { staged: false, reason: "Bundle was rolled back before" };
      }
      if (!this.isUpgradeOver(manifest)) {
        return { staged: false, reason: "Already up to date" };
      }

      const archive = await this.downloadArchive(manifest);
      if (manifest.size && archive.length !== manifest.size) {
        return { staged: false, reason: "Size mismatch" };
      }
      const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
      if (sha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
        return { staged: false, reason: "SHA256 mismatch" };
      }
      if (!this.verifySignature(sha256, manifest.signature)) {
        return { staged: false, reason: "Signature verification failed" };
      }

      // Extract into a temp dir, prove the shape, then move into place.
      const bundleDir = path.join(
        this.root,
        `bundle-${manifest.bundleVersion}-${sha256.slice(0, 8)}`,
      );
      const tempDir = path.join(
        this.root,
        `temp-${manifest.bundleVersion}-${Date.now()}`,
      );
      try {
        fs.mkdirSync(tempDir, { recursive: true });
        const tempArchive = path.join(tempDir, "archive.tar.gz");
        fs.writeFileSync(tempArchive, archive);
        tar.extract({ sync: true, file: tempArchive, cwd: tempDir });
        if (!fs.existsSync(path.join(tempDir, "dist", "index.html"))) {
          return {
            staged: false,
            reason: "Archive has no dist/index.html",
          };
        }
        fs.writeFileSync(
          path.join(tempDir, "manifest.json"),
          JSON.stringify(manifest, null, 2),
          "utf-8",
        );
        this.removeDir(bundleDir);
        fs.renameSync(tempDir, bundleDir);
      } catch (err: any) {
        this.removeDir(tempDir);
        return { staged: false, reason: err.message };
      }

      const entry: LineraveBundleEntry = {
        bundleVersion: manifest.bundleVersion,
        bundleDir,
        sha256,
        minAppVersion: manifest.minAppVersion,
        installedAt: new Date().toISOString(),
      };
      if (
        this.state.staged &&
        this.state.staged.bundleDir !== bundleDir &&
        this.state.staged.bundleDir !== this.state.active?.bundleDir
      ) {
        this.removeDir(this.state.staged.bundleDir);
      }
      this.state.staged = entry;
      this.saveState();
      console.log(
        `[LineraveBundles] Bundle ${manifest.bundleVersion} verified and staged. It will apply at next launch.`,
      );
      return { staged: true };
    } catch (err: any) {
      // Silence is the design: offline, missing release, any feed trouble
      // simply means "no update today".
      console.warn(`[LineraveBundles] Check failed quietly: ${err.message}`);
      return { staged: false, reason: err.message };
    } finally {
      this.isChecking = false;
    }
  }
}

/**
 * Reads the repo coordinates + read-only token our own release recipe
 * writes into every package for the installer updater (app-update.yml).
 * Returns null outside a packaged app or when the file is absent — the
 * channel then stays silent. Deliberately NOT overridable by env vars.
 */
function readAppUpdateConfig(): GithubFeedConfig | null {
  try {
    if (!app.isPackaged || !process.resourcesPath) return null;
    const filePath = path.join(process.resourcesPath, "app-update.yml");
    if (!fs.existsSync(filePath)) return null;
    const values: Record<string, string> = {};
    for (const line of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      if (match) values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
    }
    if (!values.owner || !values.repo) return null;
    return { owner: values.owner, repo: values.repo, token: values.token };
  } catch {
    return null;
  }
}
