import assert from "node:assert/strict";
import { test } from "node:test";
import { balanceOfData, hexToUint, parseRpcList, withRpcFallback } from "./rpc";

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
