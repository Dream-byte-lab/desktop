// PKCE (RFC 7636) helpers for the Spotify connection. The extension
// is a public client: there is no client secret anywhere in the app.
// Instead, each sign-in attempt creates a one-time verifier, sends
// only its SHA-256 challenge to Spotify, and proves possession of
// the verifier when exchanging the returned code for tokens. Anyone
// intercepting the code without the verifier holds nothing usable.

const VERIFIER_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export function generateCodeVerifier(length = 64): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let verifier = "";
  for (const byte of bytes) {
    verifier += VERIFIER_ALPHABET[byte % VERIFIER_ALPHABET.length];
  }
  return verifier;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  challenge: string;
  state: string;
}

export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: options.scopes.join(" "),
    state: options.state,
    code_challenge_method: "S256",
    code_challenge: options.challenge,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}
