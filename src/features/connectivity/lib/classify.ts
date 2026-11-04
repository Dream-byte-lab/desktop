export type ConnectionVerdict =
  "online" | "offline" | "server_error" | "server_unreachable";

export type YoutubeReach = "ok" | "blocked" | "unreachable" | "unknown";

export type ConnectionIssue =
  | "youtube_blocked"
  | "youtube_unreachable"
  | "youtube_refused"
  | "server"
  | "server_unreachable"
  | "offline";

export type IssueGroup = "youtube" | "server" | "offline";

export interface ConnectionProbe {
  deviceOnline: boolean;
  api: { ok: boolean; status?: number };
  internet: boolean | null;
  youtube: boolean | null;
  youtubeFailure?: "timeout" | "blocked" | null;
  country: string | null;
}

export function classifyConnection(probe: ConnectionProbe): ConnectionVerdict {
  if (probe.api.ok) return "online";
  if (!probe.deviceOnline) return "offline";
  if (probe.api.status !== undefined && probe.api.status >= 500)
    return "server_error";
  if (probe.internet === true) return "server_unreachable";
  return "offline";
}

export function youtubeReach(probe: ConnectionProbe): YoutubeReach {
  if (probe.youtube === true) return "ok";
  if (probe.youtube === false && probe.internet === true)
    return probe.youtubeFailure === "timeout" ? "unreachable" : "blocked";
  return "unknown";
}

export function connectionIssue(
  verdict: ConnectionVerdict,
  youtube: YoutubeReach,
): Exclude<ConnectionIssue, "youtube_refused"> | null {
  if (verdict === "offline") return "offline";
  // The two server verdicts stay distinct issues: a 5xx answer
  // proves the server responded and failed, while an unreachable
  // verdict proves only that no answer arrived — the modal copy
  // must not claim the first for the second.
  if (verdict === "server_error") return "server";
  if (verdict === "server_unreachable") return "server_unreachable";
  if (youtube === "blocked") return "youtube_blocked";
  if (youtube === "unreachable") return "youtube_unreachable";
  return null;
}

export function issueGroup(issue: ConnectionIssue): IssueGroup {
  if (issue === "offline") return "offline";
  if (issue === "server" || issue === "server_unreachable") return "server";
  return "youtube";
}

export function issueResolved(
  group: IssueGroup,
  verdict: ConnectionVerdict,
  youtube: YoutubeReach,
): boolean {
  if (verdict !== "online") return false;
  return group !== "youtube" || youtube === "ok";
}
