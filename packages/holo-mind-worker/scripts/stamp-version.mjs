// Stamp the deploy build info into src/version.ts right before `wrangler deploy`.
// Writes a git commit and a UTC timestamp; the public /version endpoint then
// reports exactly which source commit the running worker was built from.
//
// The private source repo and the public mirror (github.com/ArcHolotype/holotype-mind,
// which /version points at) have independent histories, so their commit SHAs differ.
// Pass the PUBLIC commit SHA explicitly so the reported value is one an outsider can
// actually check out:   node scripts/stamp-version.mjs <public-sha>
// With no argument it falls back to this repo's HEAD.
//
// After deploying, restore the committed placeholders with:
//   git checkout -- src/version.ts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../src/version.ts", import.meta.url));

const arg = (process.argv[2] ?? "").trim();
const commit = arg || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const short = commit.slice(0, 7);
const deployedAt = new Date().toISOString();

const body = `// Generated at deploy time by scripts/stamp-version.mjs — do not edit by hand.
// Restore the committed placeholders after deploying: git checkout -- src/version.ts
export const COMMIT = ${JSON.stringify(commit)};
export const COMMIT_SHORT = ${JSON.stringify(short)};
export const DEPLOYED_AT = ${JSON.stringify(deployedAt)};
`;

writeFileSync(target, body);
console.log(`stamped src/version.ts -> commit ${short} @ ${deployedAt}`);

