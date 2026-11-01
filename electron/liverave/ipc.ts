import { ipcMain, type BrowserWindow } from "electron";
import { PartyServer } from "./partyServer.js";
import type { PartyPublicState, PartyRequestStatusUpdate } from "./types.js";

// The bridge between the renderer (which owns the DJ session and
// every musical decision) and the party server (which owns the
// guests). The renderer starts and stops the party, publishes
// tonight's public state, receives each accepted request and
// reaction as an event, and sends back the DJ brain's status for
// each request so its guest sees honest words.

export function registerPartyIpc(
  getWindow: () => BrowserWindow | null,
): PartyServer {
  const server = new PartyServer({
    onRequest: (record) => {
      getWindow()?.webContents.send("liverave:request-received", record);
    },
    onReaction: (reaction) => {
      getWindow()?.webContents.send("liverave:reaction-received", reaction);
    },
  });

  ipcMain.handle("liverave:start-party", () => server.start());
  ipcMain.handle("liverave:stop-party", async () => {
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

  return server;
}
