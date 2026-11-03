import { describe, expect, it, vi } from "vitest";
import {
  isSecretServiceAvailable,
  SECRET_SERVICE_NAME,
  type DbusRunner,
} from "./secret-service";

// dbus-send --print-reply output shape for the ListNames family: an
// array of quoted strings. The fixtures mirror that shape.
const listOutput = (names: string[]) =>
  `method return time=1.0 sender=org.freedesktop.DBus -> destination=:1.0 serial=2 reply_serial=2\n   array [\n${names
    .map((name) => `      string "${name}"`)
    .join("\n")}\n   ]`;

function runnerFor(outputs: { listNames?: string; activatable?: string }) {
  return vi.fn<DbusRunner>((args) => {
    const method = args[args.length - 1] ?? "";
    if (method.endsWith("ListActivatableNames")) {
      return outputs.activatable ?? listOutput([]);
    }
    if (method.endsWith("ListNames"))
      return outputs.listNames ?? listOutput([]);
    throw new Error(`unexpected dbus method: ${method}`);
  });
}

describe("isSecretServiceAvailable", () => {
  it("is true when the service is already running", () => {
    const run = runnerFor({
      listNames: listOutput(["org.freedesktop.DBus", SECRET_SERVICE_NAME]),
    });
    expect(isSecretServiceAvailable(run)).toBe(true);
    // A running service settles it; the activatable list is not probed.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("is true when the service is not running but activatable", () => {
    const run = runnerFor({
      listNames: listOutput(["org.freedesktop.DBus", "org.gnome.keyring"]),
      activatable: listOutput([SECRET_SERVICE_NAME, "org.gnome.keyring"]),
    });
    expect(isSecretServiceAvailable(run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("is false when the name is in neither list", () => {
    const run = runnerFor({
      listNames: listOutput(["org.freedesktop.DBus"]),
      activatable: listOutput(["org.gnome.keyring"]),
    });
    expect(isSecretServiceAvailable(run)).toBe(false);
  });

  it("is false when the runner throws (missing binary, no bus, timeout)", () => {
    const run = vi.fn<DbusRunner>(() => {
      throw new Error("spawnSync dbus-send ETIMEDOUT");
    });
    expect(isSecretServiceAvailable(run)).toBe(false);
  });

  it("still checks activatable when listing running names fails", () => {
    const run = vi.fn<DbusRunner>((args) => {
      const method = args[args.length - 1] ?? "";
      if (method.endsWith("ListNames")) throw new Error("bus hiccup");
      return listOutput([SECRET_SERVICE_NAME]);
    });
    expect(isSecretServiceAvailable(run)).toBe(true);
  });

  it("is false on empty output", () => {
    const run = vi.fn<DbusRunner>(() => "");
    expect(isSecretServiceAvailable(run)).toBe(false);
  });

  it("asks the session bus for both name lists by their D-Bus methods", () => {
    const run = runnerFor({});
    isSecretServiceAvailable(run);
    const methods = run.mock.calls.map(([args]) => args[args.length - 1] ?? "");
    expect(methods).toEqual([
      "org.freedesktop.DBus.ListNames",
      "org.freedesktop.DBus.ListActivatableNames",
    ]);
    for (const [args] of run.mock.calls) {
      expect(args).toContain("--session");
      expect(args).toContain("--dest=org.freedesktop.DBus");
    }
  });
});
