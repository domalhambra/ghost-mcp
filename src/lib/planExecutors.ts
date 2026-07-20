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
    // Custom preflight: tag.merge's baseline is a composite { from, into }, so
    // it must NOT be clobbered the way lockedPreflight replaces a single entity.
    async preflight(api, op) {
        const from = op.staged.baseline?.from;
        const current = await api.tags.read({ id: from.id });
        if (op.staged.base_updated_at && current.updated_at !== op.staged.base_updated_at) {
            return (
                `Tag "${current.name}" changed since it was staged ` +
                `(updated_at ${op.staged.base_updated_at} -> ${current.updated_at}). Re-stage the operation.`
            );
        }
        op.staged.base_updated_at = current.updated_at;
        return null;
    },
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
    "tag.add": tagAdd,
    "tag.edit": tagEdit,
    "tag.delete": tagDelete,
    "tag.merge": tagMerge,
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
};

export const OPERATION_KINDS = Object.keys(REGISTRY) as OperationKind[];
