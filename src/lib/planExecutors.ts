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
