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
