import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

// The modules under test read Ghost config at import time.
process.env.GHOST_API_URL = "https://example.com";
process.env.GHOST_ADMIN_API_KEY = "0123456789abcdef01234567:" + "00".repeat(32);
process.env.GHOST_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), "ghost-mcp-test-"));

const { renderDiff, diffLines } = await import("../build/lib/diff.js");
const { htmlToText, tokenize, termCounts } = await import("../build/lib/html.js");
const { makeAdminToken } = await import("../build/lib/adminRequest.js");
const { JsonStore, shortId } = await import("../build/lib/store.js");

test("renderDiff reports no changes for identical input", () => {
    assert.equal(renderDiff("a\nb", "a\nb"), "(no changes)");
});

test("renderDiff shows adds and dels with context", () => {
    const out = renderDiff("one\ntwo\nthree\nfour", "one\n2\nthree\nfour");
    assert.match(out, /- two/);
    assert.match(out, /\+ 2/);
    assert.match(out, /  one/);
});

test("diffLines round-trips: dels reproduce before, adds reproduce after", () => {
    const before = "a\nb\nc\nd";
    const after = "a\nx\nc\ny\nd";
    const lines = diffLines(before, after);
    const reBefore = lines.filter((l) => l.kind !== "add").map((l) => l.text).join("\n");
    const reAfter = lines.filter((l) => l.kind !== "del").map((l) => l.text).join("\n");
    assert.equal(reBefore, before);
    assert.equal(reAfter, after);
});

test("htmlToText strips tags, scripts, and entities", () => {
    const html = "<h1>Title</h1><script>alert(1)</script><p>Hello &amp; welcome</p>";
    const text = htmlToText(html);
    assert.match(text, /Title/);
    assert.match(text, /Hello & welcome/);
    assert.doesNotMatch(text, /alert/);
    assert.doesNotMatch(text, /</);
});

test("tokenize lowercases and drops stopwords/short tokens", () => {
    const tokens = tokenize("The Quick brown FOX is on a hill");
    assert.deepEqual(tokens, ["quick", "brown", "fox", "hill"]);
});

test("termCounts counts term frequency", () => {
    const counts = termCounts(["ghost", "ghost", "blog"]);
    assert.equal(counts.get("ghost"), 2);
    assert.equal(counts.get("blog"), 1);
});

test("makeAdminToken produces a valid HS256 JWT for the admin audience", () => {
    const secret = "0a".repeat(32);
    const token = makeAdminToken(`keyid:${secret}`);
    const [header, payload, signature] = token.split(".");
    const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString());
    const decodedPayload = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(decodedHeader.alg, "HS256");
    assert.equal(decodedHeader.kid, "keyid");
    assert.equal(decodedPayload.aud, "/admin/");
    assert.ok(decodedPayload.exp - decodedPayload.iat === 300);
    const expected = createHmac("sha256", Buffer.from(secret, "hex"))
        .update(`${header}.${payload}`)
        .digest("base64url");
    assert.equal(signature, expected);
});

test("JsonStore round-trips and survives missing files", () => {
    const store = new JsonStore(`test-${shortId("t")}.json`, { items: [] });
    assert.deepEqual(store.read(), { items: [] });
    store.update((v) => v.items.push("a"));
    store.update((v) => v.items.push("b"));
    assert.deepEqual(store.read(), { items: ["a", "b"] });
});
