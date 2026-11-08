import { rethrowIfAborted } from "@/shared/utils/abort";

export async function resolveSoundCloudUrl(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  let url = rawUrl.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }
  let host = "";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    path = parsed.pathname;
  } catch {
    host = "";
    path = "";
  }
  const isShortLink = host === "on.soundcloud.com";
  const isSoundCloudHost =
    host === "soundcloud.com" || host.endsWith(".soundcloud.com");
  const isCanonical = isSoundCloudHost && path.length > 1;
  if (isShortLink || !isCanonical) {
    try {
      const response = await fetch(url, { redirect: "follow", signal });
      if (response.url) url = response.url;
    } catch {
      rethrowIfAborted(signal);
    }
  }
  try {
    const parsed = new URL(url);
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

export function isSoundCloudLikesUrl(canonicalUrl: string): boolean {
  const pathParts = soundCloudPathParts(canonicalUrl);
  return pathParts.length >= 2 && pathParts[1].toLowerCase() === "likes";
}

export function soundCloudPathParts(canonicalUrl: string): string[] {
  return new URL(canonicalUrl).pathname.replace(/^\/+|\/+$/g, "").split("/");
}
