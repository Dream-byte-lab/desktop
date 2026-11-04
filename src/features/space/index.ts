// Your Space (interface slice S2): the listening-statistics
// foundation — the hybrid server+device read model, the Dashboard
// (/space) and Listening History (/space/history) pages, and the
// device play log's writer. Routes and the sidebar section are
// landed by the parent at integration (see the slice report's
// SEAMS OWED); recordDevicePlay's one-line hookup in the player
// engine is listed there too.

export { default as ListeningDashboard } from "./ui/ListeningDashboard";
export { default as ListeningHistoryPage } from "./ui/ListeningHistoryPage";
export {
  useListeningStats,
  type ListeningStatsState,
} from "./hooks/useListeningStats";
export {
  useListeningHistory,
  type ListeningHistoryState,
} from "./hooks/useListeningHistory";
export { recordDevicePlay } from "./lib/devicePlayWriter";
export {
  aggregateListeningStats,
  mergePlayEvents,
  countsAsPlay,
  type ListeningStats,
  type ListeningCoverage,
} from "./lib/listeningStats";
