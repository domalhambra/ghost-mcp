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
