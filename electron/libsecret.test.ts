import { describe, expect, it, vi } from "vitest";
import {
  findLibsecret,
  isLibsecretInstalled,
  LIBSECRET_SONAME,
  LIBSECRET_SYSTEM_DIRS,
} from "./libsecret";

const SONAME_PATH = (dir: string) => `${dir}/${LIBSECRET_SONAME}`;

// An existence check backed by a fixed set of "installed" paths.
function existsIn(installed: string[]) {
  const set = new Set(installed);
  return vi.fn((candidate: string) => set.has(candidate));
}

describe("findLibsecret", () => {
  it("finds the library in a system dir", () => {
    const exists = existsIn([SONAME_PATH("/usr/lib")]);
    expect(findLibsecret({ exists, env: {} })).toBe(SONAME_PATH("/usr/lib"));
    expect(isLibsecretInstalled({ exists, env: {} })).toBe(true);
  });

  it("returns null when the library is nowhere on disk", () => {
    const exists = existsIn([]);
    expect(findLibsecret({ exists, env: {} })).toBeNull();
    expect(isLibsecretInstalled({ exists, env: {} })).toBe(false);
  });

  it("searches LD_LIBRARY_PATH before the system dirs", () => {
    const exists = existsIn([
      SONAME_PATH("/opt/custom/lib"),
      SONAME_PATH("/usr/lib/x86_64-linux-gnu"),
    ]);
    expect(
      findLibsecret({ exists, env: { LD_LIBRARY_PATH: "/opt/custom/lib" } }),
    ).toBe(SONAME_PATH("/opt/custom/lib"));
  });

  it("keeps LD_LIBRARY_PATH entry order", () => {
    const exists = existsIn([SONAME_PATH("/second"), SONAME_PATH("/first")]);
    expect(
      findLibsecret({ exists, env: { LD_LIBRARY_PATH: "/first:/second" } }),
    ).toBe(SONAME_PATH("/first"));
    // The winning entry is the first one probed, not just the first hit.
    expect(exists.mock.calls[0]?.[0]).toBe(SONAME_PATH("/first"));
  });

  it("falls through LD_LIBRARY_PATH misses to the system dirs", () => {
    const exists = existsIn([SONAME_PATH("/usr/lib64")]);
    expect(
      findLibsecret({ exists, env: { LD_LIBRARY_PATH: "/nowhere:/alsono" } }),
    ).toBe(SONAME_PATH("/usr/lib64"));
  });

  it("skips empty LD_LIBRARY_PATH entries instead of probing the cwd", () => {
    const exists = existsIn([]);
    findLibsecret({ exists, env: { LD_LIBRARY_PATH: ":/opt/lib::" } });
    const probed = exists.mock.calls.map(([candidate]) => candidate);
    expect(probed).not.toContain(SONAME_PATH(""));
    expect(probed[0]).toBe(SONAME_PATH("/opt/lib"));
  });

  it("probes the system dirs in their documented order", () => {
    const exists = existsIn([]);
    findLibsecret({ exists, env: {} });
    expect(exists.mock.calls.map(([candidate]) => candidate)).toEqual(
      LIBSECRET_SYSTEM_DIRS.map((dir) => SONAME_PATH(dir)),
    );
  });

  it("prefers the earliest system dir when several have the library", () => {
    const exists = existsIn([
      SONAME_PATH("/lib"),
      SONAME_PATH("/usr/lib/aarch64-linux-gnu"),
      SONAME_PATH("/usr/lib/x86_64-linux-gnu"),
    ]);
    expect(findLibsecret({ exists, env: {} })).toBe(
      SONAME_PATH("/usr/lib/x86_64-linux-gnu"),
    );
  });

  it("treats an unset LD_LIBRARY_PATH as no extra dirs", () => {
    const exists = existsIn([SONAME_PATH("/usr/lib")]);
    expect(findLibsecret({ exists, env: {} })).toBe(SONAME_PATH("/usr/lib"));
    expect(exists.mock.calls[0]?.[0]).toBe(
      SONAME_PATH(LIBSECRET_SYSTEM_DIRS[0]!),
    );
  });
});
