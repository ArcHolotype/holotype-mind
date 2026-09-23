import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCommitLines } from "./sensors";

const sample = [
  { commit: { message: "feat(mind): add /version endpoint\n\nlonger body ignored", author: { date: "2026-09-23T17:49:25Z" } } },
  { commit: { message: "fix(site): clear lint errors", author: { date: "2026-09-23T09:28:16Z" } } },
  { commit: { message: "chore: third", author: { date: "2026-09-22T00:00:00Z" } } },
];

test("formatCommitLines uses the repo short name, first line, and date", () => {
  const lines = formatCommitLines("ArcHolotype/holotype-mind", sample);
  assert.deepEqual(lines, [
    '- holotype-mind: "feat(mind): add /version endpoint" (2026-09-23)',
    '- holotype-mind: "fix(site): clear lint errors" (2026-09-23)',
  ]);
});

test("formatCommitLines caps at two commits per repo", () => {
  assert.equal(formatCommitLines("ArcHolotype/holotype-web", sample).length, 2);
});

test("formatCommitLines returns empty for a non-array payload", () => {
  assert.deepEqual(formatCommitLines("ArcHolotype/holotype-mind", null), []);
  assert.deepEqual(formatCommitLines("ArcHolotype/holotype-mind", { message: "rate limited" }), []);
});

test("formatCommitLines skips entries with no subject", () => {
  const lines = formatCommitLines("ArcHolotype/holotype-mind", [{ commit: { message: "" } }, sample[0]]);
  assert.equal(lines.length, 1);
});
