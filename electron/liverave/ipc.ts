import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow } from "electron";
import { PartyServer } from "./partyServer.js";
import type {
  PartyPublicState,
  PartyRequestStatusUpdate,
  PartySearchReply,
  PartyTrackListing,
} from "./types.js";

// The bridge between the renderer (which owns the DJ session and
// every musical decision) and the party server (which owns the
// guests). The renderer starts and stops the party, publishes
// tonight's public state, receives each accepted request and
// reaction as an event, and sends back the DJ brain's status for
// each request so its guest sees honest words.
//
// Searches run the other way (Step 6): a guest's programme search
// starts at the server, but the programme's search lives in the
// renderer. The bridge forwards the question with an id and pairs
// the renderer's reply with the waiting ask; the server bounds the
// wait, so a reply that never comes cannot hang a guest.

export function registerPartyIpc(
  getWindow: () => BrowserWindow | null,
): PartyServer {
  const pendingSearches = new Map<
    string,
    {
      resolve: (tracks: PartyTrackListing[]) => void;
      reject: (error: Error) => void;
    }
  >();

  const server = new PartyServer({
    onRequest: (record) => {
      getWindow()?.webContents.send("liverave:request-received", record);
    },
    onReaction: (reaction) => {
      getWindow()?.webContents.send("liverave:reaction-received", reaction);
    },
    onSearch: (query) => {
      const win = getWindow();
      if (!win) {
        return Promise.reject(new Error("No host window for search"));
      }
      const searchId = randomUUID();
      return new Promise<PartyTrackListing[]>((resolve, reject) => {
        pendingSearches.set(searchId, { resolve, reject });
        win.webContents.send("liverave:search", { searchId, query });
      });
    },
  });

  // A party boundary kills every unanswered search ask: each new
  // party starts with no relayed questions outstanding, and a
  // stopped party leaves none behind.
  const dropPendingSearches = () => {
    for (const pending of pendingSearches.values()) {
      pending.reject(new Error("The party moved on"));
    }
    pendingSearches.clear();
  };

  ipcMain.handle("liverave:start-party", () => {
    dropPendingSearches();
    return server.start();
  });
  ipcMain.handle("liverave:stop-party", async () => {
    dropPendingSearches();
    await server.stop();
    return server.partyInfo();
  });
  ipcMain.handle("liverave:party-info", () => server.partyInfo());
  ipcMain.on("liverave:set-state", (_event, state: PartyPublicState) =>
    server.setState(state),
  );
  ipcMain.on(
    "liverave:set-request-status",
    (_event, update: PartyRequestStatusUpdate) =>
      server.setRequestStatus(update.requestId, update.status),
  );
  ipcMain.on("liverave:search-reply", (_event, reply: PartySearchReply) => {
    const pending = pendingSearches.get(reply.searchId);
    if (!pending) return;
    pendingSearches.delete(reply.searchId);
    pending.resolve(reply.tracks ?? []);
  });

  return server;
}
