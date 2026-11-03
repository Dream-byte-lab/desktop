import { describe, expect, it, vi } from "vitest";
import {
  decideLinuxPasswordStore,
  resolveLinuxPasswordStoreSync,
  type LinuxPasswordStoreInput,
} from "./password-store";

const allGood: LinuxPasswordStoreInput = {
  platform: "linux",
  libsecretInstalled: true,
  secretServiceAvailable: true,
  argv: ["/opt/linerave/linerave"],
};

describe("decideLinuxPasswordStore", () => {
  it("pins gnome-libsecret when every condition holds", () => {
    expect(decideLinuxPasswordStore(allGood)).toBe("gnome-libsecret");
  });

  it("never pins on non-Linux platforms", () => {
    for (const platform of ["win32", "darwin", "freebsd", ""]) {
      expect(decideLinuxPasswordStore({ ...allGood, platform })).toBeNull();
    }
  });

  it("does not pin without libsecret installed", () => {
    expect(
      decideLinuxPasswordStore({ ...allGood, libsecretInstalled: false }),
    ).toBeNull();
  });

  it("does not pin without a Secret Service provider", () => {
    expect(
      decideLinuxPasswordStore({ ...allGood, secretServiceAvailable: false }),
    ).toBeNull();
  });

  it("respects a user-supplied --password-store in split form", () => {
    expect(
      decideLinuxPasswordStore({
        ...allGood,
        argv: ["linerave", "--password-store", "kwallet5"],
      }),
    ).toBeNull();
  });

  it("respects a user-supplied --password-store in = form", () => {
    expect(
      decideLinuxPasswordStore({
        ...allGood,
        argv: ["linerave", "--password-store=basic_text"],
      }),
    ).toBeNull();
  });

  it("is not fooled by lookalike arguments", () => {
    expect(
      decideLinuxPasswordStore({
        ...allGood,
        argv: [
          "linerave",
          "--password-store-hint=gnome",
          "--my-password-store",
        ],
      }),
    ).toBe("gnome-libsecret");
  });
});

describe("resolveLinuxPasswordStoreSync", () => {
  it("pins when the real-check stand-ins all pass", () => {
    expect(
      resolveLinuxPasswordStoreSync({
        platform: "linux",
        argv: ["linerave"],
        libsecretInstalled: () => true,
        secretServiceAvailable: () => true,
      }),
    ).toBe("gnome-libsecret");
  });

  it("short-circuits on non-Linux without probing anything", () => {
    const libsecretInstalled = vi.fn(() => true);
    const secretServiceAvailable = vi.fn(() => true);
    expect(
      resolveLinuxPasswordStoreSync({
        platform: "win32",
        argv: [],
        libsecretInstalled,
        secretServiceAvailable,
      }),
    ).toBeNull();
    expect(libsecretInstalled).not.toHaveBeenCalled();
    expect(secretServiceAvailable).not.toHaveBeenCalled();
  });

  it("skips the bus probe when libsecret is missing", () => {
    const secretServiceAvailable = vi.fn(() => true);
    expect(
      resolveLinuxPasswordStoreSync({
        platform: "linux",
        argv: [],
        libsecretInstalled: () => false,
        secretServiceAvailable,
      }),
    ).toBeNull();
    expect(secretServiceAvailable).not.toHaveBeenCalled();
  });

  it("honours the user's own --password-store from argv", () => {
    expect(
      resolveLinuxPasswordStoreSync({
        platform: "linux",
        argv: ["linerave", "--password-store=kwallet6"],
        libsecretInstalled: () => true,
        secretServiceAvailable: () => true,
      }),
    ).toBeNull();
  });

  it("turns a throwing check into null instead of throwing", () => {
    expect(
      resolveLinuxPasswordStoreSync({
        platform: "linux",
        argv: [],
        libsecretInstalled: () => {
          throw new Error("fs exploded");
        },
        secretServiceAvailable: () => true,
      }),
    ).toBeNull();
    expect(
      resolveLinuxPasswordStoreSync({
        platform: "linux",
        argv: [],
        libsecretInstalled: () => true,
        secretServiceAvailable: () => {
          throw new Error("bus exploded");
        },
      }),
    ).toBeNull();
  });
});
