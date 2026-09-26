import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCuriosity, htmlToText, readBrowseDigest, DEFAULT_BROWSE_CAPS } from "./browse";

test("parseCuriosity pulls, trims, de-dupes and caps entries from persisted intent JSON", () => {
  const intent = JSON.stringify({
    type: "observe",
    reason: "curious",
    curiosity: ["  Fruit fly sleep  ", "fruit fly sleep", "https://example.com/a", "", 42, null],
  });
  assert.deepEqual(parseCuriosity(intent, 3), ["Fruit fly sleep", "https://example.com/a"]);
});

test("parseCuriosity tolerates missing, malformed and non-array input", () => {
  assert.deepEqual(parseCuriosity(null, 3), []);
  assert.deepEqual(parseCuriosity("not json", 3), []);
  assert.deepEqual(parseCuriosity(JSON.stringify({ type: "rest" }), 3), []);
  assert.deepEqual(parseCuriosity(JSON.stringify({ curiosity: "nope" }), 3), []);
  assert.deepEqual(parseCuriosity(JSON.stringify({ curiosity: ["a", "b"] }), 0), []);
});

test("parseCuriosity caps long entries", () => {
  const long = "x".repeat(500);
  const out = parseCuriosity(JSON.stringify({ curiosity: [long] }), 3);
  assert.equal(out[0].length, 300);
});

test("htmlToText strips scripts, styles, tags and decodes entities", () => {
  const html =
    "<html><head><style>a{}</style><script>var x=1;</script></head>" +
    "<body><h1>Title</h1><p>Hello &amp; welcome&nbsp;here</p></body></html>";
  const text = htmlToText(html, 500);
  assert.equal(text.includes("<"), false);
  assert.equal(text.includes("var x"), false);
  assert.match(text, /Hello & welcome here/);
});

test("htmlToText respects the per-item char cap", () => {
  const text = htmlToText("<p>" + "abc ".repeat(1000) + "</p>", 50);
  assert.equal(text.length, 50);
});

test("readBrowseDigest returns null for an empty request without touching the network", async () => {
  assert.equal(await readBrowseDigest([], DEFAULT_BROWSE_CAPS), null);
});

test("readBrowseDigest never throws and yields null when every fetch fails", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const out = await readBrowseDigest(["https://example.com/x", "some topic"], DEFAULT_BROWSE_CAPS);
    assert.equal(out, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("readBrowseDigest honours the item cap and fences each reading with its source", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  // @ts-expect-error test stub
  globalThis.fetch = async (url: string) => {
    calls++;
    return new Response(`<p>body of ${url}</p>`, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const out = await readBrowseDigest(
      ["https://a.example/1", "https://b.example/2", "https://c.example/3", "https://d.example/4"],
      { maxItems: 2, totalTimeoutMs: 5000, maxCharsPerItem: 200 },
    );
    assert.equal(calls, 2, "only maxItems targets are fetched");
    assert.match(out ?? "", /https:\/\/a\.example\/1/);
    assert.match(out ?? "", /body of https:\/\/b\.example\/2/);
    assert.equal((out ?? "").includes("c.example"), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("readBrowseDigest skips non-OK responses and keeps the rest", async () => {
  const realFetch = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = async (url: string) =>
    String(url).includes("bad")
      ? new Response("nope", { status: 404 })
      : new Response("<p>good page</p>", { status: 200, headers: { "content-type": "text/html" } });
  try {
    const out = await readBrowseDigest(["https://bad.example", "https://good.example"], {
      maxItems: 3,
      totalTimeoutMs: 5000,
      maxCharsPerItem: 200,
    });
    assert.match(out ?? "", /good page/);
    assert.equal((out ?? "").includes("bad.example"), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
