import type {
  ClientImportedPlaylist,
  ClientImportedTrack,
} from "../../importTypes";

// Bringing your own Spotify playlists in from a file. Spotify
// gives every account — Free included — a copy of its data: the
// privacy page's download contains Playlist1.json, Playlist2.json…
// with every playlist, private ones too. CSV exports (Exportify
// and friends) carry the same lists. This parser turns either into
// the playlists the import pipeline already knows how to match, so
// a file import behaves exactly like a link import: same matching,
// same review, same failed-imports keeping. It is a snapshot, not
// a live sync — re-export to refresh.

export interface ParsedExportFile {
  kind: "spotify-json" | "csv";
  playlists: ClientImportedPlaylist[];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function spotifyTrackId(uri: string): string {
  return uri.startsWith("spotify:track:")
    ? uri.slice("spotify:track:".length)
    : uri;
}

function trackFromSpotifyItem(item: JsonRecord): ClientImportedTrack | null {
  const episode = asRecord(item.episode);
  if (episode) return null; // Podcast episodes are not songs.
  const track = asRecord(item.track);
  if (track) {
    const title = asString(track.trackName);
    if (!title) return null;
    const artist = asString(track.artistName);
    const album = asString(track.albumName);
    return {
      sourceId: spotifyTrackId(asString(track.trackUri)) || title,
      title,
      artists: artist ? [artist] : [],
      ...(album ? { album } : {}),
    };
  }
  const local = asRecord(item.localTrack);
  if (local) {
    const title = asString(local.trackName);
    if (!title) return null;
    const artist = asString(local.artistName);
    const album = asString(local.albumName);
    return {
      sourceId: `local:${title.toLowerCase()}|${artist.toLowerCase()}`,
      title,
      artists: artist ? [artist] : [],
      ...(album ? { album } : {}),
    };
  }
  return null;
}

function playlistFromSpotifyJson(raw: unknown): ClientImportedPlaylist | null {
  const record = asRecord(raw);
  if (!record || !Array.isArray(record.items)) return null;
  const tracks = record.items
    .map((item) => {
      const itemRecord = asRecord(item);
      return itemRecord ? trackFromSpotifyItem(itemRecord) : null;
    })
    .filter((track): track is ClientImportedTrack => Boolean(track));
  if (tracks.length === 0) return null;
  const description = asString(record.description);
  return {
    source: "spotify",
    sourceUrl: "",
    title: asString(record.name) || "Imported playlist",
    ...(description ? { description } : {}),
    tracks,
  };
}

function playlistsFromSpotifyData(root: unknown): ClientImportedPlaylist[] {
  const record = asRecord(root);
  if (!record) return [];
  if (Array.isArray(record.playlists)) {
    return record.playlists
      .map(playlistFromSpotifyJson)
      .filter((playlist): playlist is ClientImportedPlaylist =>
        Boolean(playlist),
      );
  }
  const single = playlistFromSpotifyJson(record);
  return single ? [single] : [];
}

/** Minimal CSV reader: quoted fields, embedded commas and newlines. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

function columnIndex(headers: string[], ...needles: string[][]): number {
  for (const group of needles) {
    const index = headers.findIndex((header) =>
      group.every((needle) => header.includes(needle)),
    );
    if (index >= 0) return index;
  }
  return -1;
}

function playlistsFromCsv(
  fileName: string,
  text: string,
): ClientImportedPlaylist[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const titleCol = columnIndex(headers, ["track", "name"], ["title"], ["name"]);
  if (titleCol < 0) return [];
  const artistCol = columnIndex(headers, ["artist", "name"], ["artist"]);
  const albumCol = columnIndex(headers, ["album", "name"], ["album"]);
  const durationCol = columnIndex(headers, ["duration"]);
  const durationIsMs = headers[durationCol]?.includes("ms") ?? false;
  const uriCol = columnIndex(
    headers,
    ["track", "uri"],
    ["spotify", "id"],
    ["uri"],
  );
  const tracks: ClientImportedTrack[] = [];
  for (const row of rows.slice(1)) {
    const title = (row[titleCol] ?? "").trim();
    if (!title) continue;
    const artist = artistCol >= 0 ? (row[artistCol] ?? "").trim() : "";
    const album = albumCol >= 0 ? (row[albumCol] ?? "").trim() : "";
    const uri = uriCol >= 0 ? (row[uriCol] ?? "").trim() : "";
    const rawDuration =
      durationCol >= 0 ? Number((row[durationCol] ?? "").trim()) : NaN;
    const durationMs = Number.isFinite(rawDuration)
      ? Math.round(durationIsMs ? rawDuration : rawDuration * 1000)
      : undefined;
    tracks.push({
      sourceId: spotifyTrackId(uri) || title,
      title,
      artists: artist ? [artist] : [],
      ...(album ? { album } : {}),
      ...(durationMs ? { durationMs } : {}),
    });
  }
  if (tracks.length === 0) return [];
  const baseName = fileName.replace(/\.[^.]+$/, "").trim();
  return [
    {
      source: "spotify",
      sourceUrl: "",
      title: baseName || "Imported playlist",
      tracks,
    },
  ];
}

/**
 * Parses a Spotify data-export file into importable playlists.
 * Throws a plain-language error when nothing usable is inside.
 */
export function parseExportFile(
  fileName: string,
  text: string,
): ParsedExportFile {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let root: unknown;
    try {
      root = JSON.parse(trimmed);
    } catch {
      throw new Error("That file could not be read as JSON.");
    }
    const playlists = playlistsFromSpotifyData(root);
    if (playlists.length === 0) {
      throw new Error(
        "No playlists were found in that file. From Spotify's data download, use one of the Playlist files (Playlist1.json, Playlist2.json, …).",
      );
    }
    return { kind: "spotify-json", playlists };
  }
  const playlists = playlistsFromCsv(fileName, text);
  if (playlists.length === 0) {
    throw new Error(
      "No songs were found in that file. A CSV export needs at least a track-name column.",
    );
  }
  return { kind: "csv", playlists };
}
