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
