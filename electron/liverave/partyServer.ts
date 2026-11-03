import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { guestPageHtml } from "./guestPage.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import type {
  PartyInfo,
  PartyPublicState,
  PartyReaction,
  PartyRequestRecord,
} from "./types.js";

// liveRave's party server: a small HTTP server in the main process
// that guests reach over the party's own Wi-Fi. It serves the guest
// page, issues anonymous per-phone tokens, takes requests and
// reactions, and enforces the fairness rule at the door (a handful
// of NEW requests per guest per window; asking again for a song
// already open is a vote and costs nothing).
//
// Tokens are not free: each party has a random join secret that
// rides in the join link the host shows (the QR code and the typed
// address both carry it as `#join=<secret>`). A phone must present
// that secret to mint a token, minting is rate-limited per device,
// and the guest list is capped — so one script on the LAN cannot
// mint its way around the per-guest fairness rules. Reactions are
// rate-limited per guest for the same reason.
//
// It makes NO musical decisions. The renderer publishes tonight's
// public state (what's playing, what's searchable) and owns every
// request's status; this server stores and relays, and passes each
// accepted request to the renderer through its events. When the
// party stops, the server closes and every token dies with it —
// and so does the join secret: tomorrow's party has a new one.

export const PARTY_PORT = 8471;
const MAX_BODY_BYTES = 16_384;
const NEW_REQUEST_LIMIT = 3;
const NEW_REQUEST_WINDOW_MS = 15 * 60_000;
/** Token mints allowed per source IP per window (join + re-joins). */
const TOKEN_MINT_LIMIT = 5;
const TOKEN_MINT_WINDOW_MS = 15 * 60_000;
/** Reactions allowed per guest per window. */
const REACTION_LIMIT = 30;
const REACTION_WINDOW_MS = 60_000;
/** Hard cap on simultaneous guests for one party. */
const MAX_GUESTS = 500;
const REACTION_KINDS = new Set(["fire", "heart", "clap"]);
const CLOSED_STATUSES = new Set(["played", "not tonight"]);

export interface PartyServerEvents {
  onRequest?: (record: PartyRequestRecord) => void;
  onReaction?: (reaction: PartyReaction) => void;
}

interface GuestRequestView {
  requestId: string;
  trackId: string;
  title: string;
  artist: string;
  status: string;
}

function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}

/** The published state of no party at all: closed, and empty. */
function closedPartyState(): PartyPublicState {
  return {
    open: false,
    accepting: true,
    partyName: "liveRave party",
    nowPlaying: null,
    upNext: [],
    catalogue: [],
  };
}

export class PartyServer {
  private server: Server | null = null;
  private boundPort = 0;
  private state: PartyPublicState = closedPartyState();
  private guests = new Set<string>();
  private records = new Map<string, PartyRequestRecord>();
  private limiter = new SlidingWindowLimiter(
    NEW_REQUEST_LIMIT,
    NEW_REQUEST_WINDOW_MS,
  );
  private mintLimiter = new SlidingWindowLimiter(
    TOKEN_MINT_LIMIT,
    TOKEN_MINT_WINDOW_MS,
  );
  private reactionLimiter = new SlidingWindowLimiter(
    REACTION_LIMIT,
    REACTION_WINDOW_MS,
  );
  /** Tonight's join secret; empty unless a party is running. */
  private joinSecret = "";
  private partyStartedAtMs = 0;

  constructor(private readonly events: PartyServerEvents = {}) {}

  get running(): boolean {
    return this.server !== null;
  }

  partyInfo(): PartyInfo {
    return {
      running: this.running,
      port: this.boundPort,
      joinSecret: this.running ? this.joinSecret : "",
      addresses: this.running
        ? lanAddresses().map(
            (ip) => `http://${ip}:${this.boundPort}/#join=${this.joinSecret}`,
          )
        : [],
    };
  }

  /** Publishes tonight's public state, as owned by the renderer. */
  setState(state: PartyPublicState): void {
    this.state = state;
  }

  /** Records the DJ brain's verdict on a request, for its guest. */
  setRequestStatus(requestId: string, status: string): void {
    const record = this.records.get(requestId);
    if (record) record.status = status;
  }

  async start(port: number = PARTY_PORT): Promise<PartyInfo> {
    if (this.server) return this.partyInfo();
    this.partyStartedAtMs = Date.now();
    // A fresh secret per party: yesterday's QR code joins nothing.
    this.joinSecret = randomBytes(16).toString("base64url");
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) {
          this.json(res, 500, { error: "Something went wrong" });
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => resolve());
    });
    const address = server.address();
    this.boundPort =
      typeof address === "object" && address ? address.port : port;
    this.server = server;
    return this.partyInfo();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    this.guests.clear();
    this.records.clear();
    this.limiter.reset();
    this.mintLimiter.reset();
    this.reactionLimiter.reset();
    this.joinSecret = "";
    // The published state dies with the party too: a restarted
    // server must never serve the previous party's now-playing,
    // up-next or catalogue, not even for the moment before the
    // host's first publish of the new night lands.
    this.state = closedPartyState();
    this.partyStartedAtMs = 0;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private json(
    res: import("node:http").ServerResponse,
    status: number,
    body: unknown,
  ): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  private async readBody(
    req: import("node:http").IncomingMessage,
  ): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(buffer);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /** The LAN address a request arrived from, as a limiter key. */
  private sourceIp(req: import("node:http").IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
  }

  /** Constant-time check of a presented join secret. */
  private joinSecretMatches(candidate: string): boolean {
    const expected = Buffer.from(this.joinSecret, "utf8");
    const given = Buffer.from(candidate, "utf8");
    if (expected.length === 0 || expected.length !== given.length) {
      return false;
    }
    return timingSafeEqual(expected, given);
  }

  private async handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      const html = guestPageHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }

    if (req.method === "POST" && path === "/api/token") {
      const body = await this.readBody(req);
      const presented = typeof body?.join === "string" ? body.join : "";
      if (!this.joinSecretMatches(presented)) {
        this.json(res, 403, {
          error: "That join link isn't right — scan the host's QR code",
        });
        return;
      }
      const mintVerdict = this.mintLimiter.hit(this.sourceIp(req), Date.now());
      if (!mintVerdict.allowed) {
        this.json(res, 429, {
          error: "Too many joins from this device — give it a few minutes",
          retryAfterSec: Math.ceil(mintVerdict.retryAfterMs / 1000),
        });
        return;
      }
      if (this.guests.size >= MAX_GUESTS) {
        this.json(res, 403, { error: "The party is full tonight" });
        return;
      }
      const token = randomUUID();
      this.guests.add(token);
      this.json(res, 200, { token });
      return;
    }

    if (req.method === "GET" && path === "/api/catalogue") {
      this.json(res, 200, { tracks: this.state.catalogue });
      return;
    }

    if (req.method === "GET" && path === "/api/state") {
      // The guest token rides in a header, never in the URL, so it
      // stays out of anything that logs addresses.
      const header = req.headers["x-party-token"];
      const token = typeof header === "string" ? header : "";
      const myRequests: GuestRequestView[] = [];
      for (const record of this.records.values()) {
        if (record.guestToken !== token) continue;
        const listing = this.state.catalogue.find(
          (track) => track.id === record.trackId,
        );
        myRequests.push({
          requestId: record.requestId,
          trackId: record.trackId,
          title: listing?.title ?? record.trackId,
          artist: listing?.artist ?? "",
          status: record.status,
        });
      }
      this.json(res, 200, {
        open: this.state.open,
        accepting: this.state.accepting,
        partyName: this.state.partyName,
        nowPlaying: this.state.nowPlaying,
        upNext: this.state.upNext,
        myRequests,
      });
      return;
    }

    if (req.method === "POST" && path === "/api/request") {
      const body = await this.readBody(req);
      const token = typeof body?.token === "string" ? body.token : "";
      const trackId = typeof body?.trackId === "string" ? body.trackId : "";
      if (!this.guests.has(token)) {
        this.json(res, 401, { error: "Unknown guest — reload the page" });
        return;
      }
      if (!this.state.open) {
        this.json(res, 403, { error: "The party isn't open yet" });
        return;
      }
      if (!this.state.accepting) {
        this.json(res, 403, { error: "Requests are paused by the host" });
        return;
      }
      const listing = this.state.catalogue.find(
        (track) => track.id === trackId,
      );
      if (!listing) {
        this.json(res, 404, {
          error: "That song isn't in tonight's library",
        });
        return;
      }
      for (const record of this.records.values()) {
        if (
          record.guestToken === token &&
          record.trackId === trackId &&
          !CLOSED_STATUSES.has(record.status)
        ) {
          this.json(res, 200, {
            ok: true,
            duplicate: true,
            requestId: record.requestId,
            status: record.status,
          });
          return;
        }
      }
      const verdict = this.limiter.hit(token, Date.now());
      if (!verdict.allowed) {
        this.json(res, 429, {
          error: "That's a lot of requests — give it a few minutes",
          retryAfterSec: Math.ceil(verdict.retryAfterMs / 1000),
        });
        return;
      }
      const record: PartyRequestRecord = {
        requestId: randomUUID(),
        guestToken: token,
        trackId,
        requestedAtSec: Math.max(
          0,
          Math.floor((Date.now() - this.partyStartedAtMs) / 1000),
        ),
        status: "received",
      };
      this.records.set(record.requestId, record);
      this.events.onRequest?.(record);
      this.json(res, 200, {
        ok: true,
        requestId: record.requestId,
        status: record.status,
      });
      return;
    }

    if (req.method === "POST" && path === "/api/react") {
      const body = await this.readBody(req);
      const token = typeof body?.token === "string" ? body.token : "";
      const kind = typeof body?.kind === "string" ? body.kind : "";
      if (!this.guests.has(token)) {
        this.json(res, 401, { error: "Unknown guest — reload the page" });
        return;
      }
      if (!REACTION_KINDS.has(kind)) {
        this.json(res, 400, { error: "Unknown reaction" });
        return;
      }
      const verdict = this.reactionLimiter.hit(token, Date.now());
      if (!verdict.allowed) {
        this.json(res, 429, {
          error: "Easy — too many reactions",
          retryAfterSec: Math.ceil(verdict.retryAfterMs / 1000),
        });
        return;
      }
      this.events.onReaction?.({ guestToken: token, kind, atMs: Date.now() });
      this.json(res, 200, { ok: true });
      return;
    }

    this.json(res, 404, { error: "Not found" });
  }
}
