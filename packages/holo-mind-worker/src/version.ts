// Build stamp for the public /version endpoint, so anyone can verify the running
// worker matches a specific source commit. The committed values below are
// fallbacks that keep local builds, tests, and CI working; at deploy time
// scripts/stamp-version.mjs rewrites them from `git rev-parse HEAD` and the file
// is restored to these placeholders afterwards, so the repository stays clean
// while the deployed bundle carries the real stamp.
export const COMMIT = "dev";
export const COMMIT_SHORT = "dev";
export const DEPLOYED_AT = "unknown";
