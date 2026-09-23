import test from "node:test";
import assert from "node:assert/strict";
import { driveOf, readMarket } from "./heartbeat.js";

const env = {} as any;

function stubState(payload: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => payload })) as any;
  return () => { globalThis.fetch = original; };
}

test("readMarket passes the body's collective neural snapshot through", async () => {
  const restore = stubState({
    market: { temperature: 0.6, regime: "CALM", value: 1234, breadth: 56, source: "token-volume" },
    collective: { arousal: 0.42, cohesion: 0.31, rest: 0.12, wingbeat: 0.77, valence: 0.08, vitality: 0.5 },
  });
  try {
    const reading = await readMarket(env, "https://body.example");
    assert.equal(reading.temperature, 0.6);
    assert.deepEqual(reading.neural, { arousal: 0.42, cohesion: 0.31, rest: 0.12, wingbeat: 0.77, valence: 0.08, vitality: 0.5 });
  } finally { restore(); }
});

test("readMarket yields neural null when the body is unreachable", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("body down"); }) as any;
  try {
    const reading = await readMarket(env, "https://body.example");
    assert.equal(reading.neural, null);
    assert.equal(reading.temperature, null);
  } finally { globalThis.fetch = original; }
});

test("driveOf maps intents coarsely and fails closed on garbage", () => {
  assert.equal(driveOf(JSON.stringify({ type: "rest" })), "rest");
  assert.equal(driveOf(JSON.stringify({ type: "reflect" })), "reflect");
  assert.equal(driveOf(JSON.stringify({ type: "observe" })), "observe");
  assert.equal(driveOf(JSON.stringify({ type: "narrate" })), "observe");
  assert.equal(driveOf(JSON.stringify({ type: "idle" })), "idle");
  assert.equal(driveOf(JSON.stringify({ type: "spend_everything" })), null);
  assert.equal(driveOf("not json"), null);
  assert.equal(driveOf(null), null);
});
