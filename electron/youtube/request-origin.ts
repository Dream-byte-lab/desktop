export const YOUTUBE_REQUEST_URLS = [
  "*://*.youtube.com/*",
  "*://*.googlevideo.com/*",
];

export function youtubeOriginFor(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  return host === "www.youtube.com"
    ? "https://www.youtube.com"
    : "https://music.youtube.com";
}
