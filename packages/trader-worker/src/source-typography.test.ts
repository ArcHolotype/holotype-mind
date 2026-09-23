import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Typography guard for the files we own. Their copy is written for an English-only
// terminal/browser surface, so the only non-ASCII glyphs allowed are the marks we
// deliberately typeset with: CLI status marks, arrows, dashes, quotes and maths.
// Anything else — a stray glyph, or prose pasted from another locale — fails here
// instead of surfacing in a deploy log or on the public site.
//
// Upstream murmur's vendored files are out of scope by design (see README): we do not
// retype other people's code, and touching it would bury our real changes in fork diff.
const APPROVED_GLYPHS = new Set([
  "—", "–", "·", "•", "…", "§", "×", "−", "≈", "≠", "≤", "≥", "°",
  "→", "←", "↑", "↓", "↔", "⇒",
  "✓", "✗", "⚠", "✅", "™",
  "“", "”", "‘", "’",
  "①", "②", "③", "④", "⑤",
]);

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "..", "..", "..");

const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".toml", ".sql", ".md", ".css", ".html", ".json"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".wrangler", ".next", "build"]);
const SKIP_FILES = new Set(["package-lock.json", path.basename(new URL(import.meta.url).pathname)]);

// The surfaces we author: the mind worker, our deploy config, the signer we run, the README.
const OWNED = [
  path.join(root, "packages", "holo-mind-worker"),
  path.join(root, "packages", "trader-worker", "wrangler.holotype.toml"),
  path.join(root, "packages", "trader-worker", "scripts", "deploy-manifest-auto.mjs"),
  path.join(root, "README.md"),
];

function* walk(target: string): Generator<string> {
  if (!statSync(target).isDirectory()) {
    yield target;
    return;
  }
  for (const entry of readdirSync(target)) {
    if (SKIP_DIRS.has(entry)) continue;
    yield* walk(path.join(target, entry));
  }
}

function scannedFiles(): string[] {
  return OWNED.flatMap((target) => [...walk(target)]).filter(
    (file) => TEXT_EXT.has(path.extname(file)) && !SKIP_FILES.has(path.basename(file)),
  );
}

function unexpectedGlyphs(): string[] {
  const found: string[] = [];
  for (const file of scannedFiles()) {
    const rel = path.relative(root, file);
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const ch of line) {
        if (ch.charCodeAt(0) > 127 && !APPROVED_GLYPHS.has(ch)) found.push(`${rel}:${i + 1} U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
      }
    });
  }
  return found;
}

test("files we author use only the approved typographic glyphs", () => {
  assert.deepEqual(unexpectedGlyphs(), [], "unexpected characters — retype in ASCII, or add the glyph to APPROVED_GLYPHS if it is a deliberate typesetting choice");
});

test("the typography scan still covers the surfaces it claims to", () => {
  const files = scannedFiles();
  assert.ok(files.length >= 12, `only scanned ${files.length} files — the OWNED paths above are probably wrong`);
  for (const expected of [path.join("holo-mind-worker", "src", "heartbeat.ts"), "wrangler.holotype.toml", "deploy-manifest-auto.mjs"]) {
    assert.ok(files.some((f) => f.endsWith(expected)), `${expected} is no longer scanned`);
  }
});
