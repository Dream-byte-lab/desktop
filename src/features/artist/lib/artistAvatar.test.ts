import { describe, expect, it, vi } from "vitest";
import { sizedAvatarUrl } from "./artistAvatar";

vi.mock("@/shared/api", () => ({
  api: { getArtistImage: vi.fn() },
  mediaUrl: (url: string) => url,
}));

describe("sizedAvatarUrl", () => {
  it("appends the size suffix to a googleusercontent avatar", () => {
    expect(sizedAvatarUrl("https://lh3.googleusercontent.com/abc123", 96)).toBe(
      "https://lh3.googleusercontent.com/abc123=s96-c",
    );
  });

  it("replaces an existing size suffix on a ggpht avatar", () => {
    expect(
      sizedAvatarUrl("https://yt3.ggpht.com/xyz=w176-h176-l90-rj", 96),
    ).toBe("https://yt3.ggpht.com/xyz=s96-c");
  });

  it("replaces a long tokenised suffix", () => {
    expect(
      sizedAvatarUrl(
        "https://lh3.googleusercontent.com/abc=s176-c-k-c0x00ffffff-no-rj",
        96,
      ),
    ).toBe("https://lh3.googleusercontent.com/abc=s96-c");
  });

  it("accepts a multi-label google host", () => {
    expect(sizedAvatarUrl("https://a.b.ggpht.com/img", 96)).toBe(
      "https://a.b.ggpht.com/img=s96-c",
    );
  });

  it("leaves non-google hosts untouched", () => {
    expect(sizedAvatarUrl("https://i.scdn.co/image/abc", 96)).toBe(
      "https://i.scdn.co/image/abc",
    );
  });

  it("rejects lookalike hosts that merely contain the google suffix", () => {
    expect(
      sizedAvatarUrl("https://lh3.googleusercontent.com.evil.com/abc", 96),
    ).toBe("https://lh3.googleusercontent.com.evil.com/abc");
    expect(sizedAvatarUrl("https://evilgoogleusercontent.com/abc", 96)).toBe(
      "https://evilgoogleusercontent.com/abc",
    );
  });

  it("rejects a google host appearing only in the path", () => {
    expect(
      sizedAvatarUrl("https://example.com/lh3.googleusercontent.com/abc", 96),
    ).toBe("https://example.com/lh3.googleusercontent.com/abc");
  });

  it("returns unparseable strings unchanged", () => {
    expect(sizedAvatarUrl("not a url", 96)).toBe("not a url");
  });
});
