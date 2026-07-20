import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GHOST_API_URL = "https://example.com";
process.env.GHOST_ADMIN_API_KEY = "0123456789abcdef01234567:" + "00".repeat(32);
process.env.GHOST_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), "ghost-mcp-plans-test-"));

const {
    createPlan, getPlan, listPlans, savePlan, addOperation, discardPlan,
} = await import("../build/lib/plans.js");

test("createPlan starts open and is listable", () => {
    const plan = createPlan("spring cleanup", "merge tutorial tags");
    assert.equal(plan.status, "open");
    assert.equal(plan.name, "spring cleanup");
    assert.ok(getPlan(plan.id));
    assert.ok(listPlans().some((p) => p.id === plan.id));
});

test("addOperation appends to an open plan and rejects non-open plans", () => {
    const plan = createPlan("p2");
    addOperation(plan.id, {
        id: "op_1", kind: "post.edit", params: { id: "abc" },
        reversible: true, staged: { summary: "edit", diff: "(no changes)" },
    });
    assert.equal(getPlan(plan.id).ops.length, 1);

    const applied = getPlan(plan.id);
    applied.status = "applied";
    savePlan(applied);
    assert.throws(() => addOperation(plan.id, {
        id: "op_2", kind: "post.edit", params: {},
        reversible: true, staged: { summary: "x", diff: "" },
    }), /not open/);
});

test("discardPlan removes open plans and refuses applying plans", () => {
    const plan = createPlan("p3");
    assert.equal(discardPlan(plan.id), true);
    assert.equal(getPlan(plan.id), undefined);

    const busy = createPlan("p4");
    busy.status = "applying";
    savePlan(busy);
    assert.throws(() => discardPlan(busy.id), /applying/);
});

const { executorFor, OPERATION_KINDS } = await import("../build/lib/planExecutors.js");
const { makeFakeGhost, post, tag } = await import("./fakeGhost.mjs");

test("every operation kind has an executor with matching reversibility", () => {
    for (const kind of OPERATION_KINDS) {
        const ex = executorFor(kind);
        assert.equal(ex.kind, kind);
        assert.equal(typeof ex.stage, "function");
        assert.equal(typeof ex.apply, "function");
        if (ex.reversible) assert.equal(typeof ex.revert, "function");
        else assert.equal(ex.revert, undefined);
    }
});

test("post.edit stages a diff, applies with updated_at, and reverts from baseline", async () => {
    const api = makeFakeGhost({ posts: [post("p1", "Hello World")] });
    const ex = executorFor("post.edit");
    const staged = await ex.stage(api, { id: "p1", changes: { title: "Hello Universe" } });
    assert.match(staged.diff, /title/);
    assert.equal(staged.base_updated_at, api.posts.rows[0].updated_at);

    const op = { id: "op_pe", kind: "post.edit", params: { id: "p1", changes: { title: "Hello Universe" } },
        reversible: true, staged };
    assert.equal(await ex.preflight(api, op), null);
    await ex.apply(api, op);
    assert.equal(api.posts.rows[0].title, "Hello Universe");

    await ex.revert(api, op);
    assert.equal(api.posts.rows[0].title, "Hello World");
});

test("post.edit preflight reports a conflict when the post changed underneath", async () => {
    const api = makeFakeGhost({ posts: [post("p1", "Hello World")] });
    const ex = executorFor("post.edit");
    const staged = await ex.stage(api, { id: "p1", changes: { title: "New" } });
    await api.posts.edit({ id: "p1", updated_at: api.posts.rows[0].updated_at, title: "Changed elsewhere" });
    const op = { id: "op_c", kind: "post.edit", params: { id: "p1", changes: { title: "New" } },
        reversible: true, staged };
    assert.match(await ex.preflight(api, op), /changed since/);
});

test("post.delete reverts by recreating the post (new id)", async () => {
    const api = makeFakeGhost({ posts: [post("p1", "Doomed")] });
    const ex = executorFor("post.delete");
    const op = { id: "op_pd", kind: "post.delete", params: { id: "p1" },
        reversible: true, staged: await ex.stage(api, { id: "p1" }) };
    assert.equal(await ex.preflight(api, op), null);
    await ex.apply(api, op);
    assert.equal(api.posts.rows.length, 0);
    const detail = await ex.revert(api, op);
    assert.equal(api.posts.rows.length, 1);
    assert.equal(api.posts.rows[0].title, "Doomed");
    assert.match(detail, /new ID/i);
});

test("post.publish is irreversible and passes the newsletter option through", async () => {
    const api = makeFakeGhost({ posts: [post("p1", "Launch", { status: "draft" })] });
    const ex = executorFor("post.publish");
    assert.equal(ex.reversible, false);
    const staged = await ex.stage(api, { id: "p1", newsletter_slug: "weekly" });
    assert.match(staged.summary, /email/i);
    const op = { id: "op_pub", kind: "post.publish", params: { id: "p1", newsletter_slug: "weekly" },
        reversible: false, staged };
    assert.equal(await ex.preflight(api, op), null);
    await ex.apply(api, op);
    assert.equal(api.posts.rows[0].status, "published");
});

test("tag.delete captures affected posts and revert restores tag + associations", async () => {
    const t = tag("t1", "Tutorials");
    const api = makeFakeGhost({
        tags: [t],
        posts: [
            post("p1", "Guide One", { tags: [{ id: "t1", name: "Tutorials", slug: "tutorials" }] }),
            post("p2", "Unrelated"),
        ],
    });
    const ex = executorFor("tag.delete");
    const staged = await ex.stage(api, { id: "t1" });
    assert.equal(staged.cascade.length, 1);
    assert.equal(staged.cascade[0].post_id, "p1");

    const op = { id: "op_td", kind: "tag.delete", params: { id: "t1" }, reversible: true, staged };
    assert.equal(await ex.preflight(api, op), null);
    await ex.apply(api, op);
    assert.equal(api.tags.rows.length, 0);

    api.posts.rows[0].tags = []; // Ghost cascades tag removal off posts
    await ex.revert(api, op);
    assert.equal(api.tags.rows.length, 1);
    assert.ok(api.posts.rows[0].tags.some((x) => x.name === "Tutorials"));
});

test("tag.merge retags affected posts then deletes the source tag", async () => {
    const api = makeFakeGhost({
        tags: [tag("t1", "Guides"), tag("t2", "Tutorials")],
        posts: [post("p1", "Post A", { tags: [{ id: "t1", name: "Guides", slug: "guides" }] })],
    });
    const ex = executorFor("tag.merge");
    const staged = await ex.stage(api, { from_id: "t1", into_id: "t2" });
    const op = { id: "op_tm", kind: "tag.merge", params: { from_id: "t1", into_id: "t2" },
        reversible: true, staged };
    assert.equal(await ex.preflight(api, op), null);
    await ex.apply(api, op);
    assert.equal(api.tags.rows.length, 1);
    assert.deepEqual(api.posts.rows[0].tags.map((x) => x.name), ["Tutorials"]);

    await ex.revert(api, op);
    assert.ok(api.tags.rows.some((x) => x.name === "Guides"));
    assert.deepEqual(api.posts.rows[0].tags.map((x) => x.name).sort(), ["Guides"]);
});

test("member.edit is reversible; member.delete, tier.edit, offer.edit are irreversible", () => {
    assert.equal(executorFor("member.edit").reversible, true);
    assert.equal(executorFor("newsletter.edit").reversible, true);
    for (const kind of ["member.delete", "tier.edit", "offer.edit"]) {
        assert.equal(executorFor(kind).reversible, false, kind);
    }
});

test("member.delete stage output warns about Stripe history", async () => {
    const api = makeFakeGhost({ members: [{ id: "m1", email: "a@b.com", name: "Ada", updated_at: "t0" }] });
    const staged = await executorFor("member.delete").stage(api, { id: "m1" });
    assert.match(staged.diff, /IRREVERSIBLE/);
    assert.match(staged.diff, /Stripe/);
});

test("member.edit reverts from baseline", async () => {
    const api = makeFakeGhost({ members: [{ id: "m1", email: "a@b.com", name: "Ada", note: null, labels: [], updated_at: "t0" }] });
    const ex = executorFor("member.edit");
    const staged = await ex.stage(api, { id: "m1", changes: { name: "Grace" } });
    const op = { id: "op_me", kind: "member.edit", params: { id: "m1", changes: { name: "Grace" } },
        reversible: true, staged };
    assert.equal(await ex.preflight(api, op), null);
    await ex.apply(api, op);
    assert.equal(api.members.rows[0].name, "Grace");
    await ex.revert(api, op);
    assert.equal(api.members.rows[0].name, "Ada");
});
