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
