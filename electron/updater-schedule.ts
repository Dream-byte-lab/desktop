// Release update checks: the periodic re-check cadence for the RELEASE
// channel (electron-updater against the private releases repo).
//
// This constant is the release channel's periodic interval only. The
// launch check is separate and unchanged, and the Step 3 bundle channel
// keeps its own cadence and is not governed by this constant.
export const RELEASE_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
