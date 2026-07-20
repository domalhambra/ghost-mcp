# Site Change Plans Implementation Plan

Goal: Add transactional-style, site-wide change plans to the Ghost MCP server — batch operations across posts, tags, members, tiers, offers, and newsletters into a named plan with one rollup diff, one approval gate, sequential apply with automatic best-effort compensation on failure, and post-hoc rollback.

Architecture: A local plan store (JSON file, same pattern as proposals/snapshots) holds plans made of typed operations. Each operation kind is backed by an executor implementing `stage` (validate + capture baseline + cascade data), `preflight` (optimistic-lock conflict check before any write), `apply`, and — for reversible kinds — `revert`. An engine runs two-phase apply (preflight everything, then execute sequentially), compensating already-applied reversible ops in reverse order on mid-plan failure. Irreversible ops (email sends, Stripe-touching edits, member deletes) execute only with explicit per-op acknowledgment and are excluded from the rollback promise. Executors take an injected Ghost client so the engine is fully testable against a fake.

Tech Stack: TypeScript (existing `tsc` build), `@tryghost/admin-api` client, `zod` for tool schemas, `@modelcontextprotocol/sdk` `McpServer.tool()` registration, `node --test` against built output (existing test convention).

Honest limits (state these in all user-facing docs): Ghost's Admin API has no transactions. "Apply with automatic rollback" is best-effort compensation — a compensating write can itself fail and is reported as such. Recreated entities (deleted posts/tags restored by rollback) get new IDs. Irreversible operations are never silently rolled back; they are flagged and skipped with an explanation.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/plans.ts` | Create | Plan/operation types, plan JSON store, status guards (no network code) |
| `src/lib/planExecutors.ts` | Create | Executor interface + one executor per operation kind, Ghost client injected |
| `src/lib/planEngine.ts` | Create | Two-phase apply, compensation, rollback, rollup diff rendering |
| `src/tools/plans.ts` | Create | MCP tool registration: `plans_create`, `plans_add_op`, `plans_diff`, `plans_apply`, `plans_rollback`, `plans_list`, `plans_discard` |
| `src/server.ts` | Modify (after line 78) | Register the plan tools |
| `test/plans.test.mjs` | Create | Engine + store + executor tests against a fake Ghost client |
| `FEATURES.md` / `README.md` | Modify | Document the feature and its limits |

Existing files are **not** modified except `server.ts` and docs: the single-post proposal flow (`src/tools/editorial.ts`) and post snapshots (`src/lib/snapshots.ts`) stay as-is. Plans carry their own baselines internally rather than reusing the post-only snapshot store.

Conventions to follow (from the existing codebase):
- Tool results are `{ content: [{ type: "text", text }] }` — copy the local `text()` helper pattern from `src/tools/editorial.ts:41`.
- Persistence via `JsonStore` from `src/lib/store.ts`; IDs via `shortId(prefix)`.
- Confirmation via `confirmWithUser` (`src/lib/confirm.ts`) with `confirm=true` fallback, exactly as `posts_apply_edit` does.
- Content diffs via `renderDiff(htmlToText(a), htmlToText(b))` from `src/lib/diff.ts` / `src/lib/html.ts`.
- Tests set `GHOST_API_URL`, `GHOST_ADMIN_API_KEY`, and `GHOST_MCP_DATA_DIR` (temp dir) **before** importing built modules — see `test/lib.test.mjs:8-16`.
- Ghost optimistic lock: every `posts.edit`/`tags.edit` payload includes the current `updated_at`; Ghost rejects stale values. This is the preflight mechanism.

---

## Task 1: Plan store and types (`src/lib/plans.ts`)

Files:
- Create: `src/lib/plans.ts`
- Test: `test/plans.test.mjs`

Step 1: Write the failing test

Create `test/plans.test.mjs`:

```js
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
```

Step 2: Run test to verify it fails

Run: `npm test`
Expected: FAIL — `Cannot find module '../build/lib/plans.js'` (build error surfaces first as a missing module at import).

Step 3: Write the implementation

Create `src/lib/plans.ts`:

```ts
// Site-wide change plans: a named batch of operations across Ghost entities
// with one diff, one approval, sequential apply, compensation, and rollback.
// This module is pure state + persistence; network work lives in the
// executors (planExecutors.ts) and the engine (planEngine.ts).
import { JsonStore, shortId } from "./store";

export type OperationKind =
    | "post.edit"
    | "post.retag"
    | "post.schedule"
    | "post.delete"
    | "post.publish"
    | "tag.add"
    | "tag.edit"
    | "tag.delete"
    | "tag.merge"
    | "newsletter.edit"
    | "member.edit"
    | "member.delete"
    | "tier.edit"
    | "offer.edit";

export interface CascadeEntry {
    post_id: string;
    post_title: string;
    // Tag names on the post at stage time, used to restore associations.
    tag_names: string[];
}

export interface StagedState {
    summary: string;
    diff: string;
    baseline?: any; // full entity as read from the Admin API
    base_updated_at?: string;
    cascade?: CascadeEntry[];
    created_id?: string; // filled by apply for creation ops (tag.add)
}

export type OpResultStatus =
    | "applied"
    | "failed"
    | "reverted"
    | "revert_failed"
    | "skipped";

export interface Operation {
    id: string;
    kind: OperationKind;
    params: Record<string, any>;
    reversible: boolean;
    staged: StagedState;
    result?: { status: OpResultStatus; detail?: string; error?: string };
}

export type PlanStatus = "open" | "applying" | "applied" | "failed" | "rolled_back";

export interface Plan {
    id: string;
    name: string;
    intent?: string;
    status: PlanStatus;
    created_at: string;
    ops: Operation[];
}

interface PlanFile {
    plans: Plan[];
}

const MAX_PLANS = 50;
const MAX_OPS_PER_PLAN = 200;

const store = new JsonStore<PlanFile>("plans.json", { plans: [] });

export function createPlan(name: string, intent?: string): Plan {
    const plan: Plan = {
        id: shortId("plan"),
        name,
        intent,
        status: "open",
        created_at: new Date().toISOString(),
        ops: [],
    };
    store.update((file) => {
        file.plans.push(plan);
        if (file.plans.length > MAX_PLANS) file.plans.shift();
    });
    return plan;
}

export function getPlan(planId: string): Plan | undefined {
    return store.read().plans.find((p) => p.id === planId);
}

export function listPlans(): Plan[] {
    return store.read().plans.slice().reverse();
}

export function savePlan(plan: Plan): void {
    store.update((file) => {
        const index = file.plans.findIndex((p) => p.id === plan.id);
        if (index === -1) file.plans.push(plan);
        else file.plans[index] = plan;
    });
}

export function addOperation(planId: string, op: Operation): Plan {
    const plan = getPlan(planId);
    if (!plan) throw new Error(`No plan ${planId} found.`);
    if (plan.status !== "open") {
        throw new Error(`Plan ${planId} is ${plan.status}, not open - operations can no longer be added.`);
    }
    if (plan.ops.length >= MAX_OPS_PER_PLAN) {
        throw new Error(`Plan ${planId} already has ${MAX_OPS_PER_PLAN} operations.`);
    }
    plan.ops.push(op);
    savePlan(plan);
    return plan;
}

export function discardPlan(planId: string): boolean {
    const plan = getPlan(planId);
    if (!plan) return false;
    if (plan.status === "applying") {
        throw new Error(`Plan ${planId} is applying and cannot be discarded right now.`);
    }
    store.update((file) => {
        file.plans = file.plans.filter((p) => p.id !== planId);
    });
    return true;
}
```

Step 4: Run test to verify it passes

Run: `npm test`
Expected: PASS (new tests plus the existing `lib.test.mjs` / `smoke.test.mjs` suites).

Step 5: Commit

```
git add src/lib/plans.ts test/plans.test.mjs
git commit -m "Add plan store and operation types for site change plans"
```

---

## Task 2: Executor interface, fake Ghost client, post executors

Files:
- Create: `src/lib/planExecutors.ts`
- Create: `test/fakeGhost.mjs`
- Modify: `test/plans.test.mjs` (append)

Step 1: Create the fake Ghost client test helper

Create `test/fakeGhost.mjs` — an in-memory Admin API double that mimics the small slice of `@tryghost/admin-api` behavior the executors rely on (`read`/`edit`/`add`/`delete`/`browse`, `updated_at` bumping on edit, stale-`updated_at` rejection, paginated browse):

```js
// In-memory stand-in for @tryghost/admin-api used by plan engine tests.
let clock = 0;
const stamp = () => `2026-01-01T00:00:${String(clock++).padStart(2, "0")}.000Z`;

function makeResource(rows, { lock = false } = {}) {
    const calls = [];
    const byId = (id) => rows.find((r) => r.id === id);
    return {
        rows,
        calls,
        async read({ id, slug }) {
            calls.push(["read", id ?? slug]);
            const row = id ? byId(id) : rows.find((r) => r.slug === slug);
            if (!row) { const e = new Error("NotFound"); e.response = { status: 404 }; throw e; }
            return structuredClone(row);
        },
        async edit(data) {
            calls.push(["edit", data.id, structuredClone(data)]);
            const row = byId(data.id);
            if (!row) { const e = new Error("NotFound"); e.response = { status: 404 }; throw e; }
            if (lock && data.updated_at !== undefined && data.updated_at !== row.updated_at) {
                throw new Error("UpdateCollisionError: updated_at is stale");
            }
            Object.assign(row, Object.fromEntries(
                Object.entries(data).filter(([k]) => k !== "updated_at")
            ));
            row.updated_at = stamp();
            return structuredClone(row);
        },
        async add(data) {
            calls.push(["add", structuredClone(data)]);
            const row = { id: `new_${rows.length + 1}`, updated_at: stamp(), ...data };
            rows.push(row);
            return structuredClone(row);
        },
        async delete({ id }) {
            calls.push(["delete", id]);
            const index = rows.findIndex((r) => r.id === id);
            if (index === -1) { const e = new Error("NotFound"); e.response = { status: 404 }; throw e; }
            rows.splice(index, 1);
            return {};
        },
        async browse(options = {}) {
            calls.push(["browse", structuredClone(options)]);
            let out = rows;
            const tagMatch = /^tag:(.+)$/.exec(options.filter ?? "");
            if (tagMatch) {
                out = rows.filter((r) => (r.tags ?? []).some((t) => t.slug === tagMatch[1]));
            }
            const result = structuredClone(out);
            result.meta = { pagination: { next: null } };
            return result;
        },
    };
}

export function makeFakeGhost({ posts = [], tags = [], members = [], tiers = [], offers = [], newsletters = [] } = {}) {
    return {
        posts: makeResource(posts, { lock: true }),
        tags: makeResource(tags, { lock: true }),
        members: makeResource(members),
        tiers: makeResource(tiers),
        offers: makeResource(offers),
        newsletters: makeResource(newsletters),
    };
}

export function post(id, title, extra = {}) {
    return { id, title, slug: title.toLowerCase().replace(/\s+/g, "-"), status: "draft",
        html: `<p>${title} body</p>`, tags: [], updated_at: stamp(), ...extra };
}

export function tag(id, name, extra = {}) {
    return { id, name, slug: name.toLowerCase().replace(/\s+/g, "-"), description: null,
        updated_at: stamp(), ...extra };
}
```

Step 2: Write the failing executor tests

Append to `test/plans.test.mjs`:

```js
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
```

Step 3: Run tests to verify they fail

Run: `npm test`
Expected: FAIL — `Cannot find module '../build/lib/planExecutors.js'`.

Step 4: Write the implementation

Create `src/lib/planExecutors.ts`:

```ts
// One executor per operation kind. Executors take the Ghost Admin API client
// as a parameter (never importing the singleton) so the engine is testable
// against an in-memory fake.
import { renderDiff } from "./diff";
import { htmlToText } from "./html";
import type { CascadeEntry, Operation, OperationKind, StagedState } from "./plans";

// Structural slice of @tryghost/admin-api used by executors.
export interface GhostClientLike {
    posts: any;
    tags: any;
    members: any;
    tiers: any;
    offers: any;
    newsletters: any;
}

export interface Executor {
    kind: OperationKind;
    reversible: boolean;
    stage(api: GhostClientLike, params: Record<string, any>): Promise<StagedState>;
    // Returns a conflict description, or null when safe to apply. May refresh
    // staged.baseline/base_updated_at so revert restores the pre-apply state.
    preflight(api: GhostClientLike, op: Operation): Promise<string | null>;
    apply(api: GhostClientLike, op: Operation): Promise<string>;
    revert?(api: GhostClientLike, op: Operation): Promise<string>;
}

function fieldDiff(before: any, changes: Record<string, any>): string {
    const sections: string[] = [];
    for (const [field, next] of Object.entries(changes)) {
        if (field === "html" || field === "lexical") continue;
        sections.push(`* ${field}: ${JSON.stringify(before?.[field] ?? null)} -> ${JSON.stringify(next)}`);
    }
    if (changes.html !== undefined) {
        sections.push(
            "Content diff (rendered text):\n" +
                renderDiff(htmlToText(before?.html ?? ""), htmlToText(changes.html))
        );
    } else if (changes.lexical !== undefined) {
        sections.push("Lexical content will be replaced (structured diff not available).");
    }
    return sections.join("\n") || "(no changes)";
}

function pickChanges(params: Record<string, any>, allowed: string[]): Record<string, any> {
    const source = params.changes ?? params;
    const changes: Record<string, any> = {};
    for (const field of allowed) {
        if (source[field] !== undefined) changes[field] = source[field];
    }
    return changes;
}

async function readPost(api: GhostClientLike, id: string): Promise<any> {
    return api.posts.read({ id }, { formats: ["html", "lexical"] });
}

// Shared preflight for entities with Ghost's updated_at optimistic lock.
function lockedPreflight(read: (api: GhostClientLike, op: Operation) => Promise<any>, label: string) {
    return async (api: GhostClientLike, op: Operation): Promise<string | null> => {
        const current = await read(api, op);
        if (op.staged.base_updated_at && current.updated_at !== op.staged.base_updated_at) {
            return (
                `${label} "${current.title ?? current.name ?? op.params.id}" changed since it was staged ` +
                `(updated_at ${op.staged.base_updated_at} -> ${current.updated_at}). Re-stage the operation.`
            );
        }
        // Refresh so a later revert restores the state from just before apply.
        op.staged.baseline = current;
        op.staged.base_updated_at = current.updated_at;
        return null;
    };
}

const POST_FIELDS = ["title", "html", "lexical", "status", "published_at", "custom_excerpt", "featured", "tags"];

function makePostEditExecutor(kind: OperationKind, allowed: string[]): Executor {
    return {
        kind,
        reversible: true,
        async stage(api, params) {
            const before = await readPost(api, params.id);
            const changes = pickChanges(params, allowed);
            if (Object.keys(changes).length === 0) throw new Error(`${kind}: no changes supplied.`);
            return {
                summary: `${kind} "${before.title}" (${Object.keys(changes).join(", ")})`,
                diff: fieldDiff(before, changes),
                baseline: before,
                base_updated_at: before.updated_at,
            };
        },
        preflight: lockedPreflight((api, op) => readPost(api, op.params.id), "Post"),
        async apply(api, op) {
            const changes = pickChanges(op.params, allowed);
            const options = changes.html !== undefined ? { source: "html" } : undefined;
            const updated = await api.posts.edit(
                { id: op.params.id, updated_at: op.staged.base_updated_at, ...changes },
                options
            );
            return `Updated "${updated.title}".`;
        },
        async revert(api, op) {
            const before = op.staged.baseline;
            const current = await readPost(api, op.params.id);
            const fields: Record<string, any> = {
                title: before.title,
                status: before.status,
                custom_excerpt: before.custom_excerpt,
                featured: before.featured,
                published_at: before.published_at,
                tags: (before.tags ?? []).map((t: any) => ({ name: t.name })),
            };
            if (before.lexical) fields.lexical = before.lexical;
            else if (before.html) fields.html = before.html;
            const options = !before.lexical && before.html ? { source: "html" } : undefined;
            await api.posts.edit({ id: current.id, updated_at: current.updated_at, ...fields }, options);
            return `Restored "${before.title}".`;
        },
    };
}

const postDelete: Executor = {
    kind: "post.delete",
    reversible: true,
    async stage(api, params) {
        const before = await readPost(api, params.id);
        return {
            summary: `post.delete "${before.title}"`,
            diff: `Post "${before.title}" (${before.status}) will be deleted. A full copy is kept for rollback.`,
            baseline: before,
            base_updated_at: before.updated_at,
        };
    },
    preflight: lockedPreflight((api, op) => readPost(api, op.params.id), "Post"),
    async apply(api, op) {
        await api.posts.delete({ id: op.params.id });
        return `Deleted "${op.staged.baseline.title}".`;
    },
    async revert(api, op) {
        const before = op.staged.baseline;
        const fields: Record<string, any> = {
            title: before.title,
            status: before.status,
            custom_excerpt: before.custom_excerpt,
            featured: before.featured,
            published_at: before.published_at,
            tags: (before.tags ?? []).map((t: any) => ({ name: t.name })),
        };
        if (before.lexical) fields.lexical = before.lexical;
        else if (before.html) fields.html = before.html;
        const options = !before.lexical && before.html ? { source: "html" } : undefined;
        const recreated = await api.posts.add(fields, options);
        return `Recreated "${before.title}" with a new ID (${recreated.id}).`;
    },
};

const postPublish: Executor = {
    kind: "post.publish",
    reversible: false,
    async stage(api, params) {
        const before = await readPost(api, params.id);
        if (before.status === "published") throw new Error(`Post "${before.title}" is already published.`);
        const emailNote = params.newsletter_slug
            ? ` and EMAIL it to newsletter "${params.newsletter_slug}"` +
              (params.email_segment ? ` (segment: ${params.email_segment})` : "")
            : "";
        return {
            summary: `post.publish "${before.title}"${emailNote}`,
            diff:
                `Post "${before.title}" will be PUBLISHED${emailNote}.\n` +
                `IRREVERSIBLE: publishing exposes the post publicly` +
                (params.newsletter_slug ? ` and the email cannot be recalled once sent.` : `.`),
            baseline: before,
            base_updated_at: before.updated_at,
        };
    },
    preflight: lockedPreflight((api, op) => readPost(api, op.params.id), "Post"),
    async apply(api, op) {
        const options: Record<string, any> = {};
        if (op.params.newsletter_slug) options.newsletter = op.params.newsletter_slug;
        if (op.params.email_segment) options.email_segment = op.params.email_segment;
        const updated = await api.posts.edit(
            {
                id: op.params.id,
                updated_at: op.staged.base_updated_at,
                status: "published",
                ...(op.params.published_at ? { published_at: op.params.published_at } : {}),
            },
            Object.keys(options).length ? options : undefined
        );
        return `Published "${updated.title}"${op.params.newsletter_slug ? " with email send" : ""}.`;
    },
};

export function executorFor(kind: OperationKind): Executor {
    const executor = REGISTRY[kind];
    if (!executor) throw new Error(`Unknown operation kind "${kind}".`);
    return executor;
}

const REGISTRY: Partial<Record<OperationKind, Executor>> = {
    "post.edit": makePostEditExecutor("post.edit", POST_FIELDS),
    "post.retag": makePostEditExecutor("post.retag", ["tags"]),
    "post.schedule": makePostEditExecutor("post.schedule", ["status", "published_at"]),
    "post.delete": postDelete,
    "post.publish": postPublish,
};

export const OPERATION_KINDS = Object.keys(REGISTRY) as OperationKind[];
```

Note: `OPERATION_KINDS` is derived from the registry, so the Task 2 "every kind has an executor" test passes now and automatically covers the kinds added in Tasks 3–4.

Step 5: Run tests to verify they pass

Run: `npm test`
Expected: PASS.

Step 6: Commit

```
git add src/lib/planExecutors.ts test/fakeGhost.mjs test/plans.test.mjs
git commit -m "Add plan executor interface and post operation executors"
```

---

## Task 3: Tag executors with cascade capture

Files:
- Modify: `src/lib/planExecutors.ts` (append executors, extend `REGISTRY`)
- Modify: `test/plans.test.mjs` (append)

Step 1: Write the failing tests

Append to `test/plans.test.mjs`:

```js
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
```

Step 2: Run tests to verify they fail

Run: `npm test`
Expected: FAIL — `Unknown operation kind "tag.delete"`.

Step 3: Write the implementation

Append to `src/lib/planExecutors.ts` (above `executorFor`), and add the new entries to `REGISTRY`:

```ts
async function browsePostsWithTag(api: GhostClientLike, slug: string): Promise<any[]> {
    const out: any[] = [];
    let page = 1;
    for (;;) {
        const batch = await api.posts.browse({
            filter: `tag:${slug}`,
            include: "tags",
            limit: 50,
            page,
        });
        out.push(...batch);
        if (!batch.meta?.pagination?.next) break;
        page = batch.meta.pagination.next;
    }
    return out;
}

function cascadeFromPosts(posts: any[]): CascadeEntry[] {
    return posts.map((p) => ({
        post_id: p.id,
        post_title: p.title,
        tag_names: (p.tags ?? []).map((t: any) => t.name),
    }));
}

// Restore each cascade post's tag list to exactly what it was at stage time.
async function restoreCascadeTags(api: GhostClientLike, cascade: CascadeEntry[]): Promise<string[]> {
    const failures: string[] = [];
    for (const entry of cascade) {
        try {
            const current = await api.posts.read({ id: entry.post_id });
            await api.posts.edit({
                id: entry.post_id,
                updated_at: current.updated_at,
                tags: entry.tag_names.map((name) => ({ name })),
            });
        } catch (error: any) {
            failures.push(`post ${entry.post_id} ("${entry.post_title}"): ${error?.message ?? error}`);
        }
    }
    return failures;
}

const TAG_FIELDS = ["name", "slug", "description"];

const tagAdd: Executor = {
    kind: "tag.add",
    reversible: true,
    async stage(_api, params) {
        if (!params.name) throw new Error("tag.add: name is required.");
        return {
            summary: `tag.add "${params.name}"`,
            diff: `New tag "${params.name}"${params.slug ? ` (slug: ${params.slug})` : ""} will be created.`,
        };
    },
    async preflight() {
        return null;
    },
    async apply(api, op) {
        const created = await api.tags.add(pickChanges(op.params, TAG_FIELDS));
        op.staged.created_id = created.id;
        return `Created tag "${created.name}" (${created.id}).`;
    },
    async revert(api, op) {
        if (!op.staged.created_id) return "Tag was never created; nothing to revert.";
        await api.tags.delete({ id: op.staged.created_id });
        return `Deleted created tag ${op.staged.created_id}.`;
    },
};

const tagEdit: Executor = {
    kind: "tag.edit",
    reversible: true,
    async stage(api, params) {
        const before = await api.tags.read({ id: params.id });
        const changes = pickChanges(params, TAG_FIELDS);
        if (Object.keys(changes).length === 0) throw new Error("tag.edit: no changes supplied.");
        return {
            summary: `tag.edit "${before.name}" (${Object.keys(changes).join(", ")})`,
            diff: fieldDiff(before, changes),
            baseline: before,
            base_updated_at: before.updated_at,
        };
    },
    preflight: lockedPreflight((api, op) => api.tags.read({ id: op.params.id }), "Tag"),
    async apply(api, op) {
        const updated = await api.tags.edit({
            id: op.params.id,
            updated_at: op.staged.base_updated_at,
            ...pickChanges(op.params, TAG_FIELDS),
        });
        return `Updated tag "${updated.name}".`;
    },
    async revert(api, op) {
        const before = op.staged.baseline;
        const current = await api.tags.read({ id: op.params.id });
        await api.tags.edit({
            id: current.id,
            updated_at: current.updated_at,
            name: before.name,
            slug: before.slug,
            description: before.description,
        });
        return `Restored tag "${before.name}".`;
    },
};

const tagDelete: Executor = {
    kind: "tag.delete",
    reversible: true,
    async stage(api, params) {
        const before = await api.tags.read({ id: params.id });
        const affected = await browsePostsWithTag(api, before.slug);
        const cascade = cascadeFromPosts(affected);
        return {
            summary: `tag.delete "${before.name}" (detaches from ${cascade.length} post(s))`,
            diff:
                `Tag "${before.name}" will be deleted and removed from ${cascade.length} post(s):\n` +
                (cascade.map((c) => `  - "${c.post_title}"`).join("\n") || "  (none)") +
                `\nRollback recreates the tag (new ID) and restores each post's tag list.`,
            baseline: before,
            base_updated_at: before.updated_at,
            cascade,
        };
    },
    preflight: lockedPreflight((api, op) => api.tags.read({ id: op.params.id }), "Tag"),
    async apply(api, op) {
        await api.tags.delete({ id: op.params.id });
        return `Deleted tag "${op.staged.baseline.name}" (was on ${op.staged.cascade?.length ?? 0} post(s)).`;
    },
    async revert(api, op) {
        const before = op.staged.baseline;
        await api.tags.add({ name: before.name, slug: before.slug, description: before.description });
        const failures = await restoreCascadeTags(api, op.staged.cascade ?? []);
        return failures.length
            ? `Recreated tag "${before.name}" (new ID) but failed to restore: ${failures.join("; ")}`
            : `Recreated tag "${before.name}" (new ID) and restored ${op.staged.cascade?.length ?? 0} post association(s).`;
    },
};

const tagMerge: Executor = {
    kind: "tag.merge",
    reversible: true,
    async stage(api, params) {
        const from = await api.tags.read(params.from_id ? { id: params.from_id } : { slug: params.from_slug });
        const into = await api.tags.read(params.into_id ? { id: params.into_id } : { slug: params.into_slug });
        const affected = await browsePostsWithTag(api, from.slug);
        const cascade = cascadeFromPosts(affected);
        return {
            summary: `tag.merge "${from.name}" -> "${into.name}" (${cascade.length} post(s))`,
            diff:
                `Every post tagged "${from.name}" will be retagged to "${into.name}", then "${from.name}" is deleted:\n` +
                (cascade.map((c) => `  - "${c.post_title}"`).join("\n") || "  (none)"),
            baseline: { from, into },
            base_updated_at: from.updated_at,
            cascade,
        };
    },
    preflight: lockedPreflight((api, op) => api.tags.read({ id: op.staged.baseline.from.id }), "Tag"),
    async apply(api, op) {
        const { from, into } = op.staged.baseline;
        for (const entry of op.staged.cascade ?? []) {
            const current = await api.posts.read({ id: entry.post_id });
            const names = new Set(entry.tag_names.filter((n: string) => n !== from.name));
            names.add(into.name);
            await api.posts.edit({
                id: entry.post_id,
                updated_at: current.updated_at,
                tags: [...names].map((name) => ({ name })),
            });
        }
        await api.tags.delete({ id: from.id });
        return `Merged "${from.name}" into "${into.name}" across ${op.staged.cascade?.length ?? 0} post(s).`;
    },
    async revert(api, op) {
        const { from } = op.staged.baseline;
        try {
            await api.tags.read({ slug: from.slug });
        } catch {
            await api.tags.add({ name: from.name, slug: from.slug, description: from.description });
        }
        const failures = await restoreCascadeTags(api, op.staged.cascade ?? []);
        return failures.length
            ? `Recreated "${from.name}" but failed to restore: ${failures.join("; ")}`
            : `Unmerged: recreated "${from.name}" and restored original tag lists.`;
    },
};
```

Add to `REGISTRY`:

```ts
    "tag.add": tagAdd,
    "tag.edit": tagEdit,
    "tag.delete": tagDelete,
    "tag.merge": tagMerge,
```

Step 4: Run tests to verify they pass

Run: `npm test`
Expected: PASS.

Step 5: Commit

```
git add src/lib/planExecutors.ts test/plans.test.mjs
git commit -m "Add tag executors with cascade capture for delete and merge"
```

---

## Task 4: Remaining executors (newsletter, member, tier, offer)

Files:
- Modify: `src/lib/planExecutors.ts` (append, extend `REGISTRY`)
- Modify: `test/plans.test.mjs` (append)

Step 1: Write the failing tests

Append to `test/plans.test.mjs`:

```js
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
```

Step 2: Run tests to verify they fail

Run: `npm test`
Expected: FAIL — `Unknown operation kind "member.edit"`.

Step 3: Write the implementation

Append to `src/lib/planExecutors.ts` and extend `REGISTRY`:

```ts
// Generic reversible field-edit executor for entities where a baseline
// restore is faithful (members, newsletters).
function makeFieldEditExecutor(
    kind: OperationKind,
    resource: keyof GhostClientLike,
    allowed: string[],
    label: string
): Executor {
    return {
        kind,
        reversible: true,
        async stage(api, params) {
            const before = await (api[resource] as any).read({ id: params.id });
            const changes = pickChanges(params, allowed);
            if (Object.keys(changes).length === 0) throw new Error(`${kind}: no changes supplied.`);
            return {
                summary: `${kind} "${before.name ?? before.email ?? params.id}" (${Object.keys(changes).join(", ")})`,
                diff: fieldDiff(before, changes),
                baseline: before,
                base_updated_at: before.updated_at,
            };
        },
        preflight: lockedPreflight((api, op) => (api[resource] as any).read({ id: op.params.id }), label),
        async apply(api, op) {
            const updated = await (api[resource] as any).edit({
                id: op.params.id,
                ...pickChanges(op.params, allowed),
            });
            return `Updated ${label.toLowerCase()} "${updated.name ?? updated.email ?? op.params.id}".`;
        },
        async revert(api, op) {
            const before = op.staged.baseline;
            const restore: Record<string, any> = { id: op.params.id };
            for (const field of allowed) restore[field] = before[field] ?? null;
            await (api[resource] as any).edit(restore);
            return `Restored ${label.toLowerCase()} "${before.name ?? before.email ?? op.params.id}".`;
        },
    };
}

// Irreversible field-edit executor: applies but offers no revert. The warning
// string is embedded in every staged diff so plans_diff cannot hide it.
function makeIrreversibleEditExecutor(
    kind: OperationKind,
    resource: keyof GhostClientLike,
    allowed: string[],
    label: string,
    warning: string
): Executor {
    return {
        kind,
        reversible: false,
        async stage(api, params) {
            const before = await (api[resource] as any).read({ id: params.id });
            const changes = pickChanges(params, allowed);
            if (Object.keys(changes).length === 0) throw new Error(`${kind}: no changes supplied.`);
            return {
                summary: `${kind} "${before.name ?? params.id}" (${Object.keys(changes).join(", ")})`,
                diff: `${fieldDiff(before, changes)}\nIRREVERSIBLE: ${warning}`,
                baseline: before,
                base_updated_at: before.updated_at,
            };
        },
        preflight: lockedPreflight((api, op) => (api[resource] as any).read({ id: op.params.id }), label),
        async apply(api, op) {
            const updated = await (api[resource] as any).edit({
                id: op.params.id,
                ...pickChanges(op.params, allowed),
            });
            return `Updated ${label.toLowerCase()} "${updated.name ?? op.params.id}" (irreversible).`;
        },
    };
}

const memberDelete: Executor = {
    kind: "member.delete",
    reversible: false,
    async stage(api, params) {
        const before = await api.members.read({ id: params.id });
        return {
            summary: `member.delete "${before.email}"`,
            diff:
                `Member "${before.name ?? before.email}" <${before.email}> will be DELETED.\n` +
                `IRREVERSIBLE: deleting a member destroys their Stripe linkage, subscription history, ` +
                `and email analytics. Recreating from a copy would be a hollow shell, so no rollback is offered.`,
            baseline: before,
        };
    },
    async preflight(api, op) {
        await api.members.read({ id: op.params.id });
        return null;
    },
    async apply(api, op) {
        await api.members.delete({ id: op.params.id });
        return `Deleted member "${op.staged.baseline.email}" (irreversible).`;
    },
};
```

Add to `REGISTRY`:

```ts
    "newsletter.edit": makeFieldEditExecutor(
        "newsletter.edit", "newsletters",
        ["name", "description", "sender_name", "sender_reply_to", "subject_prefix", "show_badge"],
        "Newsletter"
    ),
    "member.edit": makeFieldEditExecutor(
        "member.edit", "members", ["name", "note", "labels", "email"], "Member"
    ),
    "member.delete": memberDelete,
    "tier.edit": makeIrreversibleEditExecutor(
        "tier.edit", "tiers",
        ["name", "description", "monthly_price", "yearly_price", "currency", "benefits", "visibility", "active"],
        "Tier",
        "price changes create new Stripe prices; reverting would create a third price, not restore the original state."
    ),
    "offer.edit": makeIrreversibleEditExecutor(
        "offer.edit", "offers",
        ["name", "display_title", "display_description", "code"],
        "Offer",
        "offers cannot be deleted via the Admin API and redemption state cannot be rewound."
    ),
```

Step 4: Run tests to verify they pass

Run: `npm test`
Expected: PASS.

Step 5: Commit

```
git add src/lib/planExecutors.ts test/plans.test.mjs
git commit -m "Add member, newsletter, tier, and offer executors with irreversible class"
```

---

## Task 5: Apply engine — preflight, compensation, rollback (`src/lib/planEngine.ts`)

Files:
- Create: `src/lib/planEngine.ts`
- Modify: `test/plans.test.mjs` (append)

Step 1: Write the failing tests

Append to `test/plans.test.mjs`:

```js
const { stageOperation, applyPlan, rollbackPlan, renderPlanDiff } =
    await import("../build/lib/planEngine.js");

function twoPostPlan(api) {
    const plan = createPlan("two edits");
    return (async () => {
        for (const [id, title] of [["p1", "One B"], ["p2", "Two B"]]) {
            await stageOperation(api, plan.id, "post.edit", { id, changes: { title } });
        }
        return getPlan(plan.id);
    })();
}

test("applyPlan happy path applies in order and marks the plan applied", async () => {
    const api = makeFakeGhost({ posts: [post("p1", "One A"), post("p2", "Two A")] });
    const plan = await twoPostPlan(api);
    const report = await applyPlan(api, plan.id, []);
    assert.equal(report.plan.status, "applied");
    assert.deepEqual(api.posts.rows.map((p) => p.title), ["One B", "Two B"]);
    assert.ok(report.plan.ops.every((o) => o.result?.status === "applied"));
});

test("applyPlan aborts before any write when preflight finds a conflict", async () => {
    const api = makeFakeGhost({ posts: [post("p1", "One A"), post("p2", "Two A")] });
    const plan = await twoPostPlan(api);
    await api.posts.edit({ id: "p2", updated_at: api.posts.rows[1].updated_at, title: "Two changed" });
    const report = await applyPlan(api, plan.id, []);
    assert.equal(report.plan.status, "open");
    assert.match(report.text, /changed since/);
    assert.equal(api.posts.rows[0].title, "One A"); // op 1 was NOT applied
});

test("applyPlan compensates applied ops in reverse order on mid-plan failure", async () => {
    const api = makeFakeGhost({ posts: [post("p1", "One A"), post("p2", "Two A")] });
    const plan = await twoPostPlan(api);
    const realEdit = api.posts.edit.bind(api.posts);
    let editCalls = 0;
    api.posts.edit = async (data, options) => {
        editCalls += 1;
        if (editCalls === 2) throw new Error("boom: simulated API failure");
        return realEdit(data, options);
    };
    const report = await applyPlan(api, plan.id, []);
    assert.equal(report.plan.status, "failed");
    assert.equal(report.plan.ops[0].result.status, "reverted");
    assert.equal(report.plan.ops[1].result.status, "failed");
    assert.equal(api.posts.rows[0].title, "One A"); // compensated
    assert.equal(api.posts.rows[1].title, "Two A"); // never applied
    assert.match(report.text, /compensat/i);
});

test("applyPlan refuses irreversible ops without per-op acknowledgment", async () => {
    const api = makeFakeGhost({ posts: [post("p1", "Launch", { status: "draft" })] });
    const plan = createPlan("publish");
    await stageOperation(api, plan.id, "post.publish", { id: "p1" });
    const opId = getPlan(plan.id).ops[0].id;

    const refused = await applyPlan(api, plan.id, []);
    assert.equal(refused.plan.status, "open");
    assert.match(refused.text, /acknowledge/i);
    assert.equal(api.posts.rows[0].status, "draft");

    const accepted = await applyPlan(api, plan.id, [opId]);
    assert.equal(accepted.plan.status, "applied");
    assert.equal(api.posts.rows[0].status, "published");
});

test("rollbackPlan reverts reversible ops in reverse order and skips irreversible ones", async () => {
    const api = makeFakeGhost({ posts: [post("p1", "One A"), post("p2", "Launch", { status: "draft" })] });
    const plan = createPlan("mixed");
    await stageOperation(api, plan.id, "post.edit", { id: "p1", changes: { title: "One B" } });
    await stageOperation(api, plan.id, "post.publish", { id: "p2" });
    const pubId = getPlan(plan.id).ops[1].id;
    await applyPlan(api, plan.id, [pubId]);

    const report = await rollbackPlan(api, plan.id);
    assert.equal(report.plan.status, "rolled_back");
    assert.equal(api.posts.rows[0].title, "One A");
    assert.equal(api.posts.rows[1].status, "published"); // NOT silently reverted
    assert.equal(report.plan.ops[1].result.status, "skipped");
    assert.match(report.text, /irreversible/i);
});

test("renderPlanDiff flags irreversible ops and counts classes", async () => {
    const api = makeFakeGhost({ posts: [post("p1", "One A"), post("p2", "Launch", { status: "draft" })] });
    const plan = createPlan("diffing");
    await stageOperation(api, plan.id, "post.edit", { id: "p1", changes: { title: "One B" } });
    await stageOperation(api, plan.id, "post.publish", { id: "p2" });
    const out = renderPlanDiff(getPlan(plan.id));
    assert.match(out, /\[1\] post\.edit/);
    assert.match(out, /\[2\] post\.publish/);
    assert.match(out, /IRREVERSIBLE/);
    assert.match(out, /1 reversible, 1 irreversible/);
});
```

Step 2: Run tests to verify they fail

Run: `npm test`
Expected: FAIL — `Cannot find module '../build/lib/planEngine.js'`.

Step 3: Write the implementation

Create `src/lib/planEngine.ts`:

```ts
// Two-phase apply with best-effort compensation, plus rollback and the
// rollup diff. "Best-effort" is load-bearing: Ghost has no transactions, so
// a compensating write can itself fail and is reported, never hidden.
import { addOperation, getPlan, Operation, OperationKind, Plan, savePlan } from "./plans";
import { executorFor, GhostClientLike } from "./planExecutors";
import { shortId } from "./store";

export interface PlanReport {
    plan: Plan;
    text: string;
}

export async function stageOperation(
    api: GhostClientLike,
    planId: string,
    kind: OperationKind,
    params: Record<string, any>
): Promise<Operation> {
    const executor = executorFor(kind);
    const staged = await executor.stage(api, params);
    const op: Operation = {
        id: shortId("op"),
        kind,
        params,
        reversible: executor.reversible,
        staged,
    };
    addOperation(planId, op);
    return op;
}

export function renderPlanDiff(plan: Plan): string {
    const lines: string[] = [
        `Plan ${plan.id} "${plan.name}" (${plan.status})${plan.intent ? ` - ${plan.intent}` : ""}`,
    ];
    plan.ops.forEach((op, index) => {
        const flag = op.reversible ? "" : "  [IRREVERSIBLE - requires acknowledgment]";
        lines.push("", `[${index + 1}] ${op.kind} (${op.id})${flag}`, op.staged.summary);
        lines.push(op.staged.diff.split("\n").map((l) => `    ${l}`).join("\n"));
        if (op.result) {
            lines.push(`    -> ${op.result.status}${op.result.detail ? `: ${op.result.detail}` : ""}` +
                (op.result.error ? ` (${op.result.error})` : ""));
        }
    });
    const reversible = plan.ops.filter((o) => o.reversible).length;
    const irreversible = plan.ops.length - reversible;
    lines.push("", `${plan.ops.length} operation(s): ${reversible} reversible, ${irreversible} irreversible.`);
    if (irreversible > 0 && plan.status === "open") {
        const ids = plan.ops.filter((o) => !o.reversible).map((o) => `"${o.id}"`).join(", ");
        lines.push(`Applying requires acknowledge_irreversible: [${ids}].`);
    }
    return lines.join("\n");
}

async function compensate(api: GhostClientLike, applied: Operation[], lines: string[]): Promise<void> {
    for (const op of [...applied].reverse()) {
        const executor = executorFor(op.kind);
        if (!executor.revert) {
            op.result = {
                status: "skipped",
                detail: "irreversible - cannot auto-revert; manual attention needed",
            };
            lines.push(`  ${op.kind} (${op.id}): SKIPPED - irreversible, cannot compensate.`);
            continue;
        }
        try {
            const detail = await executor.revert(api, op);
            op.result = { status: "reverted", detail };
            lines.push(`  ${op.kind} (${op.id}): reverted - ${detail}`);
        } catch (error: any) {
            op.result = { status: "revert_failed", error: String(error?.message ?? error) };
            lines.push(
                `  ${op.kind} (${op.id}): COMPENSATION FAILED - ${error?.message ?? error}. ` +
                    `The site may be in a partial state; inspect this entity manually.`
            );
        }
    }
}

export async function applyPlan(
    api: GhostClientLike,
    planId: string,
    acknowledged: string[]
): Promise<PlanReport> {
    const plan = getPlan(planId);
    if (!plan) throw new Error(`No plan ${planId} found.`);
    if (plan.status !== "open") {
        return { plan, text: `Plan ${planId} is ${plan.status}; only open plans can be applied.` };
    }
    if (plan.ops.length === 0) {
        return { plan, text: `Plan ${planId} has no operations.` };
    }

    const unacked = plan.ops.filter((o) => !o.reversible && !acknowledged.includes(o.id));
    if (unacked.length > 0) {
        return {
            plan,
            text:
                `Refusing to apply: ${unacked.length} irreversible operation(s) need explicit acknowledgment:\n` +
                unacked.map((o) => `  - ${o.id}: ${o.staged.summary}`).join("\n") +
                `\nRe-run plans_apply with acknowledge_irreversible listing these op IDs after the user has approved each one.`,
        };
    }

    // Phase 1: preflight everything. Any conflict aborts before a single write.
    for (const [index, op] of plan.ops.entries()) {
        const conflict = await executorFor(op.kind).preflight(api, op);
        if (conflict) {
            savePlan(plan); // preflight may have refreshed other ops' baselines
            return {
                plan,
                text: `Preflight failed at operation ${index + 1} (${op.kind}); nothing was written.\n${conflict}`,
            };
        }
    }

    // Phase 2: execute sequentially, compensating on failure.
    plan.status = "applying";
    savePlan(plan);
    const lines: string[] = [];
    const applied: Operation[] = [];
    for (const [index, op] of plan.ops.entries()) {
        try {
            const detail = await executorFor(op.kind).apply(api, op);
            op.result = { status: "applied", detail };
            applied.push(op);
            lines.push(`[${index + 1}] ${op.kind}: ${detail}`);
            savePlan(plan); // persist progress so a crash mid-apply is inspectable
        } catch (error: any) {
            op.result = { status: "failed", error: String(error?.message ?? error) };
            lines.push(`[${index + 1}] ${op.kind}: FAILED - ${error?.message ?? error}`);
            lines.push(`Compensating ${applied.length} already-applied operation(s) in reverse order:`);
            await compensate(api, applied, lines);
            plan.status = "failed";
            savePlan(plan);
            return {
                plan,
                text: `Plan ${plan.id} FAILED at operation ${index + 1}.\n` + lines.join("\n"),
            };
        }
    }
    plan.status = "applied";
    savePlan(plan);
    return {
        plan,
        text:
            `Plan ${plan.id} "${plan.name}" applied: ${plan.ops.length} operation(s) succeeded.\n` +
            lines.join("\n") +
            `\nUndo the reversible operations any time with plans_rollback(plan_id: "${plan.id}").`,
    };
}

export async function rollbackPlan(api: GhostClientLike, planId: string): Promise<PlanReport> {
    const plan = getPlan(planId);
    if (!plan) throw new Error(`No plan ${planId} found.`);
    if (plan.status !== "applied") {
        return {
            plan,
            text: `Plan ${planId} is ${plan.status}; only fully applied plans can be rolled back. ` +
                `(Failed plans were already compensated during apply.)`,
        };
    }
    const lines: string[] = [];
    const appliedOps = plan.ops.filter((o) => o.result?.status === "applied");
    await compensate(api, appliedOps, lines);
    plan.status = "rolled_back";
    savePlan(plan);
    const skipped = appliedOps.filter((o) => o.result?.status === "skipped").length;
    return {
        plan,
        text:
            `Plan ${plan.id} rolled back.\n` +
            lines.join("\n") +
            (skipped > 0
                ? `\n${skipped} irreversible operation(s) were skipped and remain in effect.`
                : ""),
    };
}
```

Step 4: Run tests to verify they pass

Run: `npm test`
Expected: PASS. Pay particular attention to the compensation-order test — if it fails on ordering, the bug is in `compensate` (must iterate a *reversed copy*, `[...applied].reverse()`).

Step 5: Commit

```
git add src/lib/planEngine.ts test/plans.test.mjs
git commit -m "Add plan engine: two-phase apply, compensation, rollback, rollup diff"
```

---

## Task 6: MCP tools (`src/tools/plans.ts`) and server wiring

Files:
- Create: `src/tools/plans.ts`
- Modify: `src/server.ts` (after line 78, before `registerPrompts`)
- Modify: `test/plans.test.mjs` (append)

Step 1: Write the failing test

The smoke test in `test/smoke.test.mjs` asserts the server module loads; add a lighter structural check for the new tools module. Append to `test/plans.test.mjs`:

```js
test("plans tool module exports a register function", async () => {
    const mod = await import("../build/tools/plans.js");
    assert.equal(typeof mod.registerPlanTools, "function");
});
```

Step 2: Run test to verify it fails

Run: `npm test`
Expected: FAIL — `Cannot find module '../build/tools/plans.js'`.

Step 3: Write the implementation

Create `src/tools/plans.ts`:

```ts
// Site-wide change plans: batch operations across entities into one
// reviewable, approvable, compensating, rollback-able unit.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ghostApiClient } from "../ghostApi";
import { createPlan, discardPlan, getPlan, listPlans, OperationKind } from "../lib/plans";
import { OPERATION_KINDS } from "../lib/planExecutors";
import { applyPlan, renderPlanDiff, rollbackPlan, stageOperation } from "../lib/planEngine";
import { confirmWithUser } from "../lib/confirm";

function text(value: string) {
    return { content: [{ type: "text" as const, text: value }] };
}

export function registerPlanTools(server: McpServer) {
    server.tool(
        "plans_create",
        "Create an empty site change plan - a batch of operations across posts, tags, members, tiers, offers, and newsletters that is reviewed and applied as one unit, with automatic best-effort rollback. Add operations with plans_add_op.",
        {
            name: z.string().describe("Short human-readable name, e.g. 'merge tutorial tags'"),
            intent: z.string().optional().describe("Why this batch of changes is being made"),
        },
        async (args, _extra) => {
            const plan = createPlan(args.name, args.intent);
            return text(
                `Plan ${plan.id} "${plan.name}" created (open). ` +
                    `Add operations with plans_add_op, review with plans_diff, run with plans_apply.`
            );
        }
    );

    server.tool(
        "plans_add_op",
        "Stage one operation into an open plan. Nothing touches the live site until plans_apply. " +
            `Kinds: ${OPERATION_KINDS.join(", ")}. ` +
            "Params by kind: post.edit/post.retag/post.schedule {id, changes:{title|html|lexical|status|published_at|custom_excerpt|featured|tags}}; " +
            "post.delete {id}; post.publish {id, published_at?, newsletter_slug?, email_segment?} (IRREVERSIBLE); " +
            "tag.add {name, slug?, description?}; tag.edit {id, changes}; tag.delete {id}; " +
            "tag.merge {from_id|from_slug, into_id|into_slug}; " +
            "newsletter.edit {id, changes}; member.edit {id, changes}; member.delete {id} (IRREVERSIBLE); " +
            "tier.edit {id, changes} (IRREVERSIBLE); offer.edit {id, changes} (IRREVERSIBLE).",
        {
            plan_id: z.string(),
            kind: z.enum(OPERATION_KINDS as [string, ...string[]]),
            params: z.record(z.any()).describe("Operation parameters for the given kind (see tool description)"),
        },
        async (args, _extra) => {
            const op = await stageOperation(
                ghostApiClient,
                args.plan_id,
                args.kind as OperationKind,
                args.params
            );
            return text(
                [
                    `Staged ${op.id} (${op.kind})${op.reversible ? "" : " [IRREVERSIBLE]"} - live site untouched.`,
                    op.staged.summary,
                    op.staged.diff,
                ].join("\n")
            );
        }
    );

    server.tool(
        "plans_diff",
        "Show the full rollup diff of a plan: every staged operation, its rendered change, and irreversible-operation flags.",
        { plan_id: z.string() },
        async (args, _extra) => {
            const plan = getPlan(args.plan_id);
            if (!plan) return text(`No plan ${args.plan_id} found. Use plans_list.`);
            return text(renderPlanDiff(plan));
        }
    );

    server.tool(
        "plans_apply",
        "Apply an open plan. Preflights every operation against the live site first (any conflict aborts before writes), then applies sequentially, snapshot-first. On mid-plan failure, already-applied reversible operations are automatically compensated in reverse order (best effort - Ghost has no transactions). Irreversible operations require their IDs in acknowledge_irreversible. Asks for confirmation via elicitation when supported; otherwise requires confirm=true.",
        {
            plan_id: z.string(),
            confirm: z.boolean().optional()
                .describe("Explicit approval when the client does not support elicitation"),
            acknowledge_irreversible: z.array(z.string()).optional()
                .describe("Operation IDs of irreversible ops the user has explicitly approved"),
        },
        async (args, _extra) => {
            const plan = getPlan(args.plan_id);
            if (!plan) return text(`No plan ${args.plan_id} found. Use plans_list.`);
            if (plan.status !== "open") {
                return text(`Plan ${args.plan_id} is ${plan.status}; only open plans can be applied.`);
            }
            if (args.confirm !== true) {
                const result = await confirmWithUser(
                    server,
                    `Apply plan "${plan.name}" (${plan.ops.length} operation(s))?\n\n${renderPlanDiff(plan)}`
                );
                if (result === "declined") {
                    return text("The user declined. Plan kept as open; nothing was modified.");
                }
                if (result === "unsupported") {
                    return text(
                        "This plan needs explicit approval. Show the user the plans_diff output, then re-run plans_apply with confirm=true (and acknowledge_irreversible for any flagged ops) once they approve."
                    );
                }
            }
            const report = await applyPlan(ghostApiClient, args.plan_id, args.acknowledge_irreversible ?? []);
            return text(report.text);
        }
    );

    server.tool(
        "plans_rollback",
        "Roll back a fully applied plan: reverts its reversible operations in reverse order from the baselines captured at apply time. Irreversible operations are skipped and reported, never silently undone. Asks for confirmation; confirm=true as fallback.",
        {
            plan_id: z.string(),
            confirm: z.boolean().optional(),
        },
        async (args, _extra) => {
            const plan = getPlan(args.plan_id);
            if (!plan) return text(`No plan ${args.plan_id} found. Use plans_list.`);
            if (args.confirm !== true) {
                const result = await confirmWithUser(
                    server,
                    `Roll back plan "${plan.name}" (${plan.ops.length} operation(s), applied ${plan.created_at})?`
                );
                if (result === "declined") return text("Rollback declined; nothing changed.");
                if (result === "unsupported") {
                    return text(`Rollback needs approval. Re-run plans_rollback with confirm=true.`);
                }
            }
            const report = await rollbackPlan(ghostApiClient, args.plan_id);
            return text(report.text);
        }
    );

    server.tool(
        "plans_list",
        "List site change plans, newest first, with status and operation counts.",
        {},
        async (_args, _extra) => {
            const plans = listPlans();
            if (plans.length === 0) return text("No plans yet. Create one with plans_create.");
            return text(
                plans
                    .map((p) => {
                        const irreversible = p.ops.filter((o) => !o.reversible).length;
                        return `${p.id} - "${p.name}" [${p.status}] - ${p.ops.length} op(s)` +
                            (irreversible ? ` (${irreversible} irreversible)` : "") +
                            ` - created ${p.created_at}`;
                    })
                    .join("\n")
            );
        }
    );

    server.tool(
        "plans_discard",
        "Discard a plan that has not been applied. Applied plans cannot be discarded (their baselines are needed for rollback); applying plans cannot be discarded mid-flight.",
        { plan_id: z.string() },
        async (args, _extra) => {
            const plan = getPlan(args.plan_id);
            if (!plan) return text(`No plan ${args.plan_id} found.`);
            if (plan.status === "applied") {
                return text(
                    `Plan ${args.plan_id} is applied; keeping it so plans_rollback stays possible. ` +
                        `It will age out of the store naturally.`
                );
            }
            discardPlan(args.plan_id);
            return text(`Discarded plan ${args.plan_id}.`);
        }
    );
}
```

Step 4: Wire into the server

In `src/server.ts`, after the activity feed registration (line 78) and before `registerPrompts`, add:

```ts
// Site-wide change plans: plan -> diff -> approve -> apply -> rollback.
import { registerPlanTools } from "./tools/plans";
registerPlanTools(server);
```

Step 5: Run tests to verify they pass

Run: `npm test`
Expected: PASS, including the existing `smoke.test.mjs` (which exercises server module load — this catches registration-time errors like a bad zod schema).

Step 6: Commit

```
git add src/tools/plans.ts src/server.ts test/plans.test.mjs
git commit -m "Register site change plan MCP tools"
```

---

## Task 7: Documentation

Files:
- Modify: `FEATURES.md` (new section + tool reference rows + table-of-contents entry)
- Modify: `README.md` (feature bullet)

Step 1: README

Add to the README `## Features` list, after the "Safe editorial workflow" bullet:

```md
- **Site change plans**: batch operations across posts, tags, members, tiers, offers, and newsletters into one plan with a single rollup diff, one approval, sequential apply with automatic best-effort compensation on failure, and one-command rollback. Irreversible operations (email sends, Stripe-touching edits, member deletes) are flagged and require explicit per-operation acknowledgment.
```

Step 2: FEATURES.md

Add a section after "Safe editing" (renumber later sections or append as §12 to avoid renumbering churn — appending is fine) and add these rows to the complete tool reference:

```md
| `plans_create` | Open a named batch of operations across any entity type. Nothing touches the site until apply. |
| `plans_add_op` | Stage one operation (post edit/delete/publish, tag add/edit/delete/merge, member/newsletter/tier/offer edits, member delete) into an open plan, with an immediate per-op diff. |
| `plans_diff` | One rollup diff of the whole plan, with **irreversible operations flagged** for acknowledgment. |
| `plans_apply` | Preflight every operation against the live site (conflicts abort before any write), then apply sequentially. Mid-plan failure triggers **automatic best-effort compensation** of applied reversible ops in reverse order. |
| `plans_rollback` | Revert a fully applied plan's reversible operations from apply-time baselines. Irreversible ops are skipped and reported. |
| `plans_list` / `plans_discard` | Inspect and clean up plans. |
```

The section prose must state the honest limits verbatim from the header of this document: no server-side transactions, compensation is best-effort, recreated entities get new IDs, irreversible ops are never silently undone.

Step 3: Verify docs build nothing (markdown only), run full suite once more

Run: `npm test`
Expected: PASS.

Step 4: Commit

```
git add FEATURES.md README.md
git commit -m "Document site change plans in README and FEATURES"
```

---

## Task 8: Manual verification against a real Ghost instance (pre-release gate)

Not automatable in CI (needs a live Ghost site + Admin key). Run once before releasing:

1. `GHOST_API_URL=... GHOST_ADMIN_API_KEY=... npx @modelcontextprotocol/inspector node build/server.js`
2. Happy path: `plans_create` → two `plans_add_op` (`post.edit` on two draft posts) → `plans_diff` → `plans_apply` (confirm) → verify both posts changed in Ghost Admin → `plans_rollback` → verify both restored.
3. Conflict path: stage a `post.edit`, edit the same post in Ghost Admin by hand, `plans_apply` → expect preflight abort with "changed since" and **no** changes to either post.
4. Acknowledgment path: stage a `tier.edit` → `plans_apply` without acknowledgment → expect refusal listing the op ID; re-run with `acknowledge_irreversible` → expect apply.
5. Cascade path: `tag.merge` between two real tags with ≥3 tagged posts → verify retagging in Ghost Admin → `plans_rollback` → verify original tag lists restored (note: recreated tag has a new ID — expected).
6. Verify the real Admin API's browse pagination on a site with >50 posts under one tag (the fake returns a single page; the real client must loop — `browsePostsWithTag` handles `meta.pagination.next`).

Known risks to watch in step 6: `@tryghost/admin-api` browse responses are arrays with a `meta` property (matching the fake); tags may not enforce the `updated_at` lock as strictly as posts on some Ghost versions — if a tag edit succeeds where preflight should have caught a conflict, tighten `lockedPreflight` for tags by comparing field values, not just timestamps.

---

## Out of scope (deliberately)

- **True atomicity** — impossible against Ghost's API; compensation is the honest ceiling.
- **Post/page create ops inside plans** — `posts_add` already exists; creation has no baseline to protect.
- **Tier/offer archive ops** — the Admin API's archive semantics vary by Ghost version; add in v2 behind version detection.
- **Concurrent plan application** — the store has no lock; the `applying` status guard is enough for a single-user stdio server.
- **Cross-plan conflict detection** — two open plans touching the same entity are caught by preflight at apply time, which is sufficient.
