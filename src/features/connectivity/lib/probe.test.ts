import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyConnection } from "./classify";
import { probeConnection } from "./probe";

// In a plain browser there is no desktop bridge to say whether
// the internet itself works. The probe must measure that itself,
// or every API failure is misreported as "offline".

function stubBrowser(fetchImpl: (url: string) => Promise<unknown>) {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => fetchImpl(url)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("probeConnection in a plain browser (no desktop bridge)", () => {
  it("blames the server, not the user, when another origin answers", async () => {
    stubBrowser(async (url) => {
      if (url.endsWith("/health")) throw new Error("network down");
      return { ok: true, status: 200 };
    });

    const probe = await probeConnection();

    expect(probe.internet).toBe(true);
    expect(classifyConnection(probe)).toBe("server_unreachable");
  });

  it("still says offline when nothing at all answers", async () => {
    stubBrowser(async () => {
      throw new Error("network down");
    });

    const probe = await probeConnection();

    expect(probe.internet).toBe(false);
    expect(classifyConnection(probe)).toBe("offline");
  });

  it("is online when the api answers, without needing the control check", async () => {
    const fetched: string[] = [];
    stubBrowser(async (url) => {
      fetched.push(url);
      return { ok: true, status: 200 };
    });

    const probe = await probeConnection();

    expect(classifyConnection(probe)).toBe("online");
    expect(fetched.some((url) => url.includes("covers"))).toBe(false);
  });
});
