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
