// Safe editorial workflow: propose -> diff -> approve -> publish, with
// snapshot-backed rollback and first-class scheduling.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ghostApiClient } from "../ghostApi";
import { GHOST_API_URL } from "../config";
import { JsonStore, shortId } from "../lib/store";
import { renderDiff } from "../lib/diff";
import { htmlToText } from "../lib/html";
import { takeSnapshot, listSnapshots, getSnapshot } from "../lib/snapshots";
import { confirmWithUser } from "../lib/confirm";

interface Proposal {
    id: string;
    post_id: string;
    post_title: string;
    created_at: string;
    note?: string;
    base_updated_at: string;
    changes: Record<string, any>;
    diff: string;
}

interface ProposalFile {
    proposals: Proposal[];
}

const proposalStore = new JsonStore<ProposalFile>("proposals.json", { proposals: [] });

const EDITABLE_FIELDS = [
    "title",
    "html",
    "lexical",
    "status",
    "published_at",
    "custom_excerpt",
    "featured",
    "tags",
] as const;

function text(value: string) {
    return { content: [{ type: "text" as const, text: value }] };
}

function previewUrl(post: any): string | undefined {
    if (!post?.uuid) return undefined;
    return `${GHOST_API_URL.replace(/\/+$/, "")}/p/${post.uuid}/`;
}

function describeChanges(post: any, changes: Record<string, any>): string {
    const sections: string[] = [];
    for (const [field, next] of Object.entries(changes)) {
        if (field === "html" || field === "lexical") continue;
        const current = JSON.stringify(post[field] ?? null);
        sections.push(`* ${field}: ${current} -> ${JSON.stringify(next)}`);
    }
    if (changes.html !== undefined) {
        sections.push(
            "\nContent diff (rendered text):\n" +
                renderDiff(htmlToText(post.html), htmlToText(changes.html))
        );
    } else if (changes.lexical !== undefined) {
        sections.push("\nLexical content will be replaced (structured diff not available).");
    }
    return sections.join("\n") || "(no changes)";
}

export function registerEditorialTools(server: McpServer) {
    server.tool(
        "posts_propose_edit",
        "Stage an edit to a post WITHOUT touching the live version. Returns a human-readable diff and a proposal_id to pass to posts_apply_edit after review. Prefer this over posts_edit for published posts.",
        {
            id: z.string().describe("Post ID to edit"),
            title: z.string().optional(),
            html: z.string().optional().describe("New HTML content (full replacement)"),
            lexical: z.string().optional().describe("New lexical content (full replacement)"),
            status: z.enum(["draft", "published", "scheduled"]).optional(),
            published_at: z.string().optional().describe("ISO timestamp; required when scheduling"),
            custom_excerpt: z.string().optional(),
            featured: z.boolean().optional(),
            note: z.string().optional().describe("Why this change is being proposed"),
        },
        async (args, _extra) => {
            const post = await ghostApiClient.posts.read({ id: args.id }, { formats: ["html", "lexical"] });
            const changes: Record<string, any> = {};
            for (const field of EDITABLE_FIELDS) {
                if (field in args && (args as any)[field] !== undefined) {
                    changes[field] = (args as any)[field];
                }
            }
            if (Object.keys(changes).length === 0) {
                return text("No changes supplied - nothing to propose.");
            }
            const proposal: Proposal = {
                id: shortId("prop"),
                post_id: post.id,
                post_title: post.title,
                created_at: new Date().toISOString(),
                note: args.note,
                base_updated_at: post.updated_at,
                changes,
                diff: describeChanges(post, changes),
            };
            proposalStore.update((file) => {
                file.proposals.push(proposal);
                if (file.proposals.length > 100) file.proposals.shift();
            });
            const preview = previewUrl(post);
            return text(
                [
                    `Proposal ${proposal.id} staged for "${post.title}" (post ${post.id}). The live post is untouched.`,
                    ``,
                    proposal.diff,
                    ``,
                    preview ? `Current post preview: ${preview}` : ``,
                    `Apply with posts_apply_edit(proposal_id: "${proposal.id}") or discard with posts_discard_proposal.`,
                ]
                    .filter(Boolean)
                    .join("\n")
            );
        }
    );

    server.tool(
        "posts_list_proposals",
        "List staged edit proposals that have not been applied yet.",
        {},
        async (_args, _extra) => {
            const proposals = proposalStore.read().proposals;
            if (proposals.length === 0) return text("No pending proposals.");
            return text(
                proposals
                    .map(
                        (p) =>
                            `${p.id} - "${p.post_title}" (post ${p.post_id}), created ${p.created_at}` +
                            (p.note ? ` - ${p.note}` : "") +
                            ` - fields: ${Object.keys(p.changes).join(", ")}`
                    )
                    .join("\n")
            );
        }
    );

    server.tool(
        "posts_discard_proposal",
        "Discard a staged proposal without applying it.",
        { proposal_id: z.string() },
        async (args, _extra) => {
            let found = false;
            proposalStore.update((file) => {
                const before = file.proposals.length;
                file.proposals = file.proposals.filter((p) => p.id !== args.proposal_id);
                found = file.proposals.length < before;
            });
            return text(found ? `Discarded ${args.proposal_id}.` : `No proposal ${args.proposal_id} found.`);
        }
    );

    server.tool(
        "posts_apply_edit",
        "Apply a staged proposal to the live post. Asks the user for confirmation via elicitation when the client supports it; otherwise requires confirm=true. Snapshots the current post first so posts_rollback can undo it.",
        {
            proposal_id: z.string(),
            confirm: z
                .boolean()
                .optional()
                .describe("Explicit approval when the client does not support elicitation"),
            force: z
                .boolean()
                .optional()
                .describe("Apply even if the post changed since the proposal was created"),
        },
        async (args, _extra) => {
            const proposal = proposalStore.read().proposals.find((p) => p.id === args.proposal_id);
            if (!proposal) return text(`No proposal ${args.proposal_id} found. Use posts_list_proposals.`);

            const post = await ghostApiClient.posts.read(
                { id: proposal.post_id },
                { formats: ["html", "lexical"] }
            );
            if (post.updated_at !== proposal.base_updated_at && !args.force) {
                return text(
                    `The post changed since this proposal was created (updated_at ${proposal.base_updated_at} -> ${post.updated_at}). ` +
                        `Re-propose against the current version, or re-run with force=true to apply anyway.`
                );
            }

            if (args.confirm !== true) {
                const result = await confirmWithUser(
                    server,
                    `Apply proposal ${proposal.id} to "${post.title}"?\n\n${proposal.diff}`
                );
                if (result === "declined") {
                    return text("The user declined the change. Proposal kept; nothing was modified.");
                }
                if (result === "unsupported") {
                    return text(
                        "This change needs explicit approval. Show the user the diff from posts_propose_edit, then re-run posts_apply_edit with confirm=true once they approve."
                    );
                }
            }

            const snapshot = takeSnapshot(post, `before applying ${proposal.id}`);
            const payload: Record<string, any> = {
                id: post.id,
                updated_at: post.updated_at,
                ...proposal.changes,
            };
            // Editing content requires telling Ghost which source format to use.
            const options = proposal.changes.html !== undefined ? { source: "html" } : undefined;
            const updated = await ghostApiClient.posts.edit(payload, options);
            proposalStore.update((file) => {
                file.proposals = file.proposals.filter((p) => p.id !== proposal.id);
            });
            const preview = previewUrl(updated);
            return text(
                [
                    `Applied ${proposal.id} to "${updated.title}" (status: ${updated.status}).`,
                    `Snapshot ${snapshot.id} saved - undo with posts_rollback(post_id: "${post.id}").`,
                    updated.url ? `URL: ${updated.url}` : preview ? `Preview: ${preview}` : ``,
                ]
                    .filter(Boolean)
                    .join("\n")
            );
        }
    );

    server.tool(
        "posts_schedule",
        "Schedule a draft post to publish automatically at a future time.",
        {
            id: z.string(),
            published_at: z.string().describe("ISO 8601 timestamp in the future, e.g. 2026-07-08T09:00:00.000Z"),
        },
        async (args, _extra) => {
            const when = new Date(args.published_at);
            if (isNaN(when.getTime())) return text(`"${args.published_at}" is not a valid timestamp.`);
            if (when.getTime() <= Date.now()) return text(`published_at must be in the future.`);
            const post = await ghostApiClient.posts.read({ id: args.id }, { formats: ["html", "lexical"] });
            takeSnapshot(post, "before scheduling");
            const updated = await ghostApiClient.posts.edit({
                id: post.id,
                updated_at: post.updated_at,
                status: "scheduled",
                published_at: when.toISOString(),
            });
            return text(`"${updated.title}" is scheduled to publish at ${updated.published_at}.`);
        }
    );

    server.tool(
        "posts_list_snapshots",
        "List locally stored snapshots taken before destructive post operations (newest first).",
        { post_id: z.string().optional() },
        async (args, _extra) => {
            const snapshots = listSnapshots(args.post_id);
            if (snapshots.length === 0) return text("No snapshots stored yet.");
            return text(
                snapshots
                    .map((s) => `${s.id} - "${s.post_title}" (post ${s.post_id}) - ${s.reason} - ${s.taken_at}`)
                    .join("\n")
            );
        }
    );

    server.tool(
        "posts_rollback",
        "Restore a post to a previously snapshotted state. Uses the newest snapshot for the post unless snapshot_id is given. If the post was deleted, it is recreated (with a new ID).",
        {
            post_id: z.string(),
            snapshot_id: z.string().optional(),
            confirm: z.boolean().optional(),
        },
        async (args, _extra) => {
            const snapshot = args.snapshot_id
                ? getSnapshot(args.snapshot_id)
                : listSnapshots(args.post_id)[0];
            if (!snapshot || snapshot.post_id !== args.post_id) {
                return text(`No matching snapshot found for post ${args.post_id}. Use posts_list_snapshots.`);
            }

            if (args.confirm !== true) {
                const result = await confirmWithUser(
                    server,
                    `Roll back "${snapshot.post_title}" to the snapshot from ${snapshot.taken_at} (${snapshot.reason})?`
                );
                if (result === "declined") return text("Rollback declined by the user; nothing changed.");
                if (result === "unsupported") {
                    return text(
                        `Rollback needs approval. Re-run posts_rollback with confirm=true to restore the ${snapshot.taken_at} snapshot (${snapshot.id}).`
                    );
                }
            }

            const restore = snapshot.post;
            const fields: Record<string, any> = {
                title: restore.title,
                status: restore.status,
                custom_excerpt: restore.custom_excerpt,
                featured: restore.featured,
                published_at: restore.published_at,
            };
            if (restore.lexical) fields.lexical = restore.lexical;
            else if (restore.html) fields.html = restore.html;
            const options = !restore.lexical && restore.html ? { source: "html" } : undefined;

            try {
                const current = await ghostApiClient.posts.read({ id: args.post_id });
                takeSnapshot(
                    await ghostApiClient.posts.read({ id: args.post_id }, { formats: ["html", "lexical"] }),
                    `before rollback to ${snapshot.id}`
                );
                const updated = await ghostApiClient.posts.edit(
                    { id: current.id, updated_at: current.updated_at, ...fields },
                    options
                );
                return text(`Restored "${updated.title}" to the ${snapshot.taken_at} snapshot (${snapshot.id}).`);
            } catch (error: any) {
                if (error?.response?.status === 404 || /notfound/i.test(String(error?.name ?? ""))) {
                    const recreated = await ghostApiClient.posts.add(fields, options);
                    return text(
                        `Original post no longer exists; recreated it from snapshot ${snapshot.id} as post ${recreated.id} (status: ${recreated.status}).`
                    );
                }
                throw error;
            }
        }
    );
}
