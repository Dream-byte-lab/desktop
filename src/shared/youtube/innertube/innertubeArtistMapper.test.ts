import { describe, expect, it } from "vitest";
import {
  mapInnertubeArtistDetails,
  rankSimilarArtistsFromTracks,
} from "./innertubeArtistMapper";
import type { Track } from "@/shared/contracts";

// Fixtures shaped like the real Innertube artist browse body: a
// header, the shelves the mapper already reads, and — on artist
// pages that carry one — the source's own similar-artists
// carousel. The similar parse is title-keyed and accepts only
// artist-page endpoints, mirroring the release shelves' rules.

function artistRun(name: string, browseId: string) {
  return {
    text: name,
    navigationEndpoint: {
      browseEndpoint: {
        browseId,
        browseEndpointContextSupportedConfigs: {
          browseEndpointContextMusicConfig: {
            pageType: "MUSIC_PAGE_TYPE_ARTIST",
          },
        },
      },
    },
  };
}

function twoRowArtist(name: string, browseId: string) {
  return {
    musicTwoRowItemRenderer: {
      title: { runs: [artistRun(name, browseId)] },
      thumbnailRenderer: {
        musicThumbnailRenderer: {
          thumbnail: {
            thumbnails: [
              {
                url: `https://img.example/${browseId}.jpg`,
                width: 540,
                height: 540,
              },
            ],
          },
        },
      },
    },
  };
}

function twoRowAlbum(title: string, browseId: string) {
  return {
    musicTwoRowItemRenderer: {
      title: {
        runs: [
          {
            text: title,
            navigationEndpoint: {
              browseEndpoint: {
                browseId,
                browseEndpointContextSupportedConfigs: {
                  browseEndpointContextMusicConfig: {
                    pageType: "MUSIC_PAGE_TYPE_ALBUM",
                  },
                },
              },
            },
          },
        ],
      },
    },
  };
}

function carousel(title: string, contents: unknown[]) {
  return {
    musicCarouselShelfRenderer: {
      header: {
        musicCarouselShelfBasicHeaderRenderer: {
          title: { runs: [{ text: title }] },
        },
      },
      contents,
    },
  };
}

function artistBody(extraShelves: unknown[]) {
  return {
    contents: {
      musicImmersiveHeaderRenderer: {
        title: { runs: [{ text: "Main Artist" }] },
      },
    },
    shelves: extraShelves,
  };
}

describe("mapInnertubeArtistDetails — similar artists shelf", () => {
  it("reads the source's Fans might also like carousel as fans-basis similar artists", () => {
    const body = artistBody([
      carousel("Fans might also like", [
        twoRowArtist("Similar One", "UCsim1"),
        twoRowAlbum("Not An Artist", "MPREalbum"),
        twoRowArtist("Main Artist", "UCmain"),
        twoRowArtist("Similar Two", "UCsim2"),
        twoRowArtist("Similar One Again", "UCsim1"),
      ]),
      carousel("Albums", [twoRowAlbum("Some Album", "MPREother")]),
    ]);

    const artist = mapInnertubeArtistDetails("UCmain", body);

    // Only artist cards land, the artist themself and duplicates
    // are excluded, and the Albums shelf contributes nothing.
    expect(artist?.similarArtistsBasis).toBe("fans");
    expect(artist?.similarArtists).toEqual([
      {
        id: "UCsim1",
        name: "Similar One",
        cover: expect.objectContaining({
          url: "https://img.example/UCsim1.jpg",
        }),
      },
      {
        id: "UCsim2",
        name: "Similar Two",
        cover: expect.objectContaining({
          url: "https://img.example/UCsim2.jpg",
        }),
      },
    ]);
  });

  it("leaves the field unset when the page carries no similar shelf", () => {
    const body = artistBody([carousel("Albums", [twoRowAlbum("LP", "MPRE1")])]);
    const artist = mapInnertubeArtistDetails("UCmain", body);
    expect(artist?.similarArtists).toBeUndefined();
    expect(artist?.similarArtistsBasis).toBeUndefined();
  });
});

describe("rankSimilarArtistsFromTracks", () => {
  const track = (artists: { id: string; name: string }[]): Track =>
    ({
      id: `t-${Math.random()}`,
      title: "Song",
      artists,
      durationMs: 1000,
    }) as Track;

  it("ranks by credit frequency, excluding self and id-less credits", () => {
    const ranked = rankSimilarArtistsFromTracks(
      [
        track([
          { id: "UCa", name: "A" },
          { id: "UCb", name: "B" },
        ]),
        track([{ id: "UCa", name: "A" }]),
        track([
          { id: "UCself", name: "Self" },
          { id: "", name: "Nobody" },
          { id: "unknown", name: "Unknown" },
        ]),
      ],
      "UCself",
    );
    expect(ranked).toEqual([
      { id: "UCa", name: "A" },
      { id: "UCb", name: "B" },
    ]);
  });

  it("counts an artist once per track and honours the limit", () => {
    const ranked = rankSimilarArtistsFromTracks(
      [
        track([
          { id: "UCa", name: "A" },
          { id: "UCa", name: "A" },
          { id: "UCb", name: "B" },
        ]),
        track([{ id: "UCb", name: "B" }]),
      ],
      "UCself",
      1,
    );
    expect(ranked).toEqual([{ id: "UCb", name: "B" }]);
  });
});
