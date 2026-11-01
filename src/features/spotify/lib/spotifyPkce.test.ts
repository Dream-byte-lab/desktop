import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  computeCodeChallenge,
  generateCodeVerifier,
} from "./spotifyPkce";

describe("spotifyPkce", () => {
  it("matches the RFC 7636 known-answer challenge", async () => {
    // The worked example from RFC 7636 Appendix B.
    const challenge = await computeCodeChallenge(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates verifiers from the unreserved alphabet", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(64);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(generateCodeVerifier()).not.toBe(verifier);
  });

  it("builds the authorize URL with PKCE parameters", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client-123",
        redirectUri: "http://127.0.0.1:8472/spotify-callback",
        scopes: ["playlist-read-private", "playlist-read-collaborative"],
        challenge: "challenge-abc",
        state: "state-xyz",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.spotify.com/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("scope")).toBe(
      "playlist-read-private playlist-read-collaborative",
    );
    expect(url.searchParams.get("state")).toBe("state-xyz");
  });
});
