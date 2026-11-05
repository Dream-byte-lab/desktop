// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useArtist, artistAudience } from "./useArtist";
import { api } from "@/shared/api";
import { queryCache } from "@/shared/cache/queryCache";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/shared/api", () => ({
  api: { getArtist: vi.fn() },
  mediaUrl: (url: string) => url,
  toMaxQualityAvatarUrl: (url: string) => url,
  toClientTrack: (track: { id: string }) => ({ ...track }),
}));

const artist = {
  name: "Boards of Canada",
  verified: true,
  bio: "",
  cover: { url: "boc.jpg" },
  tracks: [],
  albums: [],
  singles: [],
};

let firstRender: ReturnType<typeof useArtist> | null = null;
let latest: ReturnType<typeof useArtist> | null = null;

function Probe({ id }: { id: string }) {
  const state = useArtist(id);
  firstRender ??= state;
  latest = state;
  return null;
}

describe("useArtist", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    queryCache.clear();
    firstRender = null;
    latest = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(api.getArtist).mockReset();
    vi.mocked(api.getArtist).mockResolvedValue(artist as any);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens an artist seen before from memory on the first render", async () => {
    await act(async () => {
      root.render(<Probe id="boc" />);
    });
    expect(latest?.data?.title).toBe("Boards of Canada");
    expect(api.getArtist).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    root = createRoot(container);
    firstRender = null;
    vi.mocked(api.getArtist).mockReturnValue(new Promise(() => undefined));

    act(() => {
      root.render(<Probe id="boc" />);
    });
    expect(firstRender).toMatchObject({
      loading: false,
      data: { title: "Boards of Canada" },
    });
    expect(api.getArtist).toHaveBeenCalledTimes(1);
  });

  it("maps the catalogue's similar artists onto the view model", async () => {
    vi.mocked(api.getArtist).mockResolvedValue({
      ...artist,
      similarArtists: [
        { id: "sim-1", name: "Similar One", cover: { url: "sim.jpg" } },
        { id: "sim-2", name: "Similar Two" },
      ],
      similarArtistsBasis: "fans",
    } as any);

    await act(async () => {
      root.render(<Probe id="boc" />);
    });

    expect(latest?.data?.similarArtists).toEqual([
      { id: "sim-1", name: "Similar One", coverUrl: "sim.jpg" },
      { id: "sim-2", name: "Similar Two", coverUrl: "" },
    ]);
    expect(latest?.data?.similarArtistsBasis).toBe("fans");
  });

  it("defaults similar artists to an empty list when the catalogue has none", async () => {
    await act(async () => {
      root.render(<Probe id="boc" />);
    });
    expect(latest?.data?.similarArtists).toEqual([]);
    expect(latest?.data?.similarArtistsBasis).toBeUndefined();
  });
});

describe("artistAudience", () => {
  it("extracts the count from the source's monthly figure", () => {
    expect(
      artistAudience({ monthlyListeners: "17,682,480 monthly listeners" }),
    ).toEqual({ kind: "monthly", count: "17,682,480" });
    expect(artistAudience({ monthlyListeners: "1.2M" })).toEqual({
      kind: "monthly",
      count: "1.2M",
    });
  });

  it("falls back to the compact follower count, and to nothing", () => {
    expect(artistAudience({ followers: 1234567 })).toEqual({
      kind: "followers",
      count: "1.2M",
    });
    expect(artistAudience({})).toBeNull();
    expect(artistAudience({ followers: 0 })).toBeNull();
  });
});
