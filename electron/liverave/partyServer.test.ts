import { afterEach, describe, expect, it } from "vitest";
import { PartyServer } from "./partyServer";
import type { PartyRequestRecord } from "./types";

let server: PartyServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function startOpenServer() {
  const received: PartyRequestRecord[] = [];
  server = new PartyServer({
    onRequest: (record) => received.push(record),
  });
  const info = await server.start(0);
  server.setState({
    open: true,
    accepting: true,
    partyName: "Test Party",
    nowPlaying: { id: "now", title: "Now Song", artist: "Now Artist" },
    upNext: [],
    catalogue: [1, 2, 3, 4, 5].map((n) => ({
      id: `t${n}`,
      title: `Song ${n}`,
      artist: `Artist ${n}`,
    })),
  });
  const base = `http://127.0.0.1:${info.port}`;
  const tokenRes = await fetch(`${base}/api/token`, { method: "POST" });
  const { token } = (await tokenRes.json()) as { token: string };
  return { base, token, received };
}

function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PartyServer", () => {
  it("serves the guest page", async () => {
    server = new PartyServer();
    const info = await server.start(0);
    const res = await fetch(`http://127.0.0.1:${info.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("liveRave");
    expect(html).toContain("Request a song");
  });

  it("accepts a request for a catalogue song and forwards it", async () => {
    const { base, token, received } = await startOpenServer();
    const res = await post(base, "/api/request", { token, trackId: "t1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("received");
    expect(received).toHaveLength(1);
    expect(received[0].trackId).toBe("t1");
    expect(received[0].guestToken).toBe(token);
  });

  it("refuses songs outside tonight's catalogue, politely", async () => {
    const { base, token } = await startOpenServer();
    const res = await post(base, "/api/request", {
      token,
      trackId: "not-tonight",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("isn't in tonight's library");
  });

  it("treats a repeat request as a vote, not a new request", async () => {
    const { base, token, received } = await startOpenServer();
    await post(base, "/api/request", { token, trackId: "t2" });
    const res = await post(base, "/api/request", { token, trackId: "t2" });
    const body = (await res.json()) as { duplicate?: boolean };
    expect(body.duplicate).toBe(true);
    expect(received).toHaveLength(1);
  });

  it("rate-limits new requests per guest", async () => {
    const { base, token } = await startOpenServer();
    for (const trackId of ["t1", "t2", "t3"]) {
      const res = await post(base, "/api/request", { token, trackId });
      expect(res.status).toBe(200);
    }
    const fourth = await post(base, "/api/request", {
      token,
      trackId: "t4",
    });
    expect(fourth.status).toBe(429);
  });

  it("shows the guest their requests with the renderer's statuses", async () => {
    const { base, token, received } = await startOpenServer();
    await post(base, "/api/request", { token, trackId: "t1" });
    server!.setRequestStatus(received[0].requestId, "coming soon");
    const res = await fetch(`${base}/api/state?token=${token}`);
    const body = (await res.json()) as {
      open: boolean;
      myRequests: { trackId: string; title: string; status: string }[];
    };
    expect(body.open).toBe(true);
    expect(body.myRequests).toEqual([
      {
        requestId: received[0].requestId,
        trackId: "t1",
        title: "Song 1",
        artist: "Artist 1",
        status: "coming soon",
      },
    ]);
  });

  it("pauses requests when the host flips the kill switch", async () => {
    const { base, token } = await startOpenServer();
    server!.setState({
      open: true,
      accepting: false,
      partyName: "Test Party",
      nowPlaying: null,
      upNext: [],
      catalogue: [{ id: "t1", title: "Song 1", artist: "Artist 1" }],
    });
    const res = await post(base, "/api/request", { token, trackId: "t1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("paused by the host");
    const state = (await (
      await fetch(`${base}/api/state?token=${token}`)
    ).json()) as { open: boolean; accepting: boolean };
    expect(state.open).toBe(true);
    expect(state.accepting).toBe(false);
  });

  it("rejects unknown guests", async () => {
    const { base } = await startOpenServer();
    const res = await post(base, "/api/request", {
      token: "forged",
      trackId: "t1",
    });
    expect(res.status).toBe(401);
  });
});
