import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPayeeIsWallet, balanceOfData, hexToUint, isContractAddress, parseRpcList, withRpcFallback } from "./rpc";

// JSON-RPC stub keyed by method -> result (or an Error to simulate a failing endpoint).
function rpcStub(results: Record<string, unknown>) {
  return async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    const v = results[body.method];
    const payload =
      v instanceof Error
        ? { jsonrpc: "2.0", id: body.id ?? 1, error: { message: v.message } }
        : { jsonrpc: "2.0", id: body.id ?? 1, result: v };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
}
const realFetch = globalThis.fetch;
function withFetch(stub: (...a: never[]) => unknown, fn: () => Promise<void>) {
  return async () => {
    globalThis.fetch = stub as typeof globalThis.fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = realFetch;
    }
  };
}

test("hex quantities parse", () => {
  assert.equal(hexToUint("0x0"), 0n);
  assert.equal(hexToUint("0x3e8"), 1000n);
  assert.throws(() => hexToUint("1000"));
  assert.throws(() => hexToUint("0xzz"));
  assert.throws(() => hexToUint(undefined));
});

test("balanceOf calldata pads the wallet address to 32 bytes", () => {
  const wallet = "0xfd644825d074015bed978cb1472bb4b6c1145b06";
  const data = balanceOfData(wallet);
  assert.equal(data.startsWith("0x70a08231"), true);
  assert.equal(data.length, 2 + 8 + 64);
  assert.equal(data.endsWith(wallet.slice(2).toLowerCase()), true);
});

test("parseRpcList splits space or comma separated urls, dedupes, drops junk", () => {
  assert.deepEqual(parseRpcList("https://a.example https://b.example"), ["https://a.example", "https://b.example"]);
  assert.deepEqual(parseRpcList("https://a.example,https://a.example https://c.example"), ["https://a.example", "https://c.example"]);
  assert.deepEqual(parseRpcList(undefined, "  ", "notaurl https://d.example"), ["https://d.example"]);
  assert.deepEqual(parseRpcList(), []);
});

test("withRpcFallback walks the list in order and surfaces the last error", async () => {
  const seen: string[] = [];
  const value = await withRpcFallback(["u1", "u2", "u3"], async (url) => {
    seen.push(url);
    if (url !== "u2") throw new Error(`down ${url}`);
    return 7;
  });
  assert.equal(value, 7);
  assert.deepEqual(seen, ["u1", "u2"]);
  await assert.rejects(
    withRpcFallback(["u1", "u2"], async (url) => {
      throw new Error(`down ${url}`);
    }),
    /down u2/,
  );
  await assert.rejects(withRpcFallback([], async () => 1), /no rpc urls/);
});

// ---- payee safety: EOA-only (refuse to pay a contract) ----

test("isContractAddress is false for an EOA (0x) and true for deployed bytecode", async () => {
  await withFetch(rpcStub({ eth_getCode: "0x" }), async () => {
    assert.equal(await isContractAddress("https://rpc.test", "0xabc"), false);
  })();
  await withFetch(rpcStub({ eth_getCode: "0x6080604052" }), async () => {
    assert.equal(await isContractAddress("https://rpc.test", "0xabc"), true);
  })();
});

test("assertPayeeIsWallet ok for an EOA, refuses a contract payee", async () => {
  await withFetch(rpcStub({ eth_getCode: "0x" }), async () => {
    const r = await assertPayeeIsWallet(["https://rpc.test"], "0xabc");
    assert.equal(r.ok, true);
  })();
  await withFetch(rpcStub({ eth_getCode: "0x6080604052" }), async () => {
    const r = await assertPayeeIsWallet(["https://rpc.test"], "0xabc");
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /is a contract/);
  })();
});

test("assertPayeeIsWallet fails closed: no urls, or every rpc errored", async () => {
  const noUrls = await assertPayeeIsWallet([], "0xabc");
  assert.equal(noUrls.ok, false);
  assert.match(noUrls.reason ?? "", /no rpc urls/);
  await withFetch(rpcStub({ eth_getCode: new Error("boom") }), async () => {
    const r = await assertPayeeIsWallet(["https://rpc.test"], "0xabc");
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /EOA check failed/);
  })();
});
