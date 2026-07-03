// Business intelligence layer: member growth, MRR, email performance,
// attribution-flavored activity, and a one-call weekly report.
// Uses raw signed Admin API requests for the stats endpoints the official
// client does not expose; every endpoint degrades gracefully when a Ghost
// version does not provide it.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ghostApiClient } from "../ghostApi";
import { adminGetOptional } from "../lib/adminRequest";

function text(value: string) {
    return { content: [{ type: "text" as const, text: value }] };
}

function isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString();
}

function nqlTimestamp(iso: string): string {
    // NQL date filters want 'YYYY-MM-DD HH:MM:SS'
    return `'${iso.slice(0, 19).replace("T", " ")}'`;
}

async function countMembers(filter?: string): Promise<number | null> {
    try {
        const result: any = await ghostApiClient.members.browse({ limit: 1, ...(filter ? { filter } : {}) });
        return result?.meta?.pagination?.total ?? result.length ?? null;
    } catch {
        return null;
    }
}

function pct(numerator: number, denominator: number): string {
    if (!denominator) return "n/a";
    return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

async function emailRows(limit: number): Promise<any[] | null> {
    const data = await adminGetOptional("emails/", { limit, order: "submitted_at DESC" });
    return data?.emails ?? null;
}

function describeEmail(email: any): string {
    const delivered = email.delivered_count ?? email.email_count ?? 0;
    const opened = email.opened_count ?? 0;
    return (
        `- "${email.subject ?? "(no subject)"}" - ${email.submitted_at ?? "unknown date"} - ` +
        `sent ${email.email_count ?? "?"}, delivered ${delivered}, opened ${opened} (${pct(opened, delivered)})` +
        (email.status && email.status !== "submitted" ? ` [status: ${email.status}]` : "")
    );
}

export function registerAnalyticsTools(server: McpServer) {
    server.tool(
        "analytics_summary",
        "Snapshot of the business: total/paid/free members, member growth over the period, and MRR trend. Read-only.",
        { days: z.number().optional().describe("Lookback window in days, default 30") },
        async (args, _extra) => {
            const days = args.days ?? 30;
            const lines: string[] = [`Site analytics - last ${days} days`, ``];

            const [total, paid, free] = await Promise.all([
                countMembers(),
                countMembers("status:paid"),
                countMembers("status:free"),
            ]);
            if (total !== null) {
                lines.push(
                    `Members: ${total} total` +
                        (paid !== null ? `, ${paid} paid` : "") +
                        (free !== null ? `, ${free} free` : "")
                );
            }
            const newMembers = await countMembers(`created_at:>${nqlTimestamp(isoDaysAgo(days))}`);
            if (newMembers !== null) lines.push(`New members in window: ${newMembers}`);

            const memberStats = await adminGetOptional("stats/member_count/");
            const series: any[] = memberStats?.stats ?? memberStats?.member_count ?? [];
            if (Array.isArray(series) && series.length > 1) {
                const window = series.slice(-days);
                const first = window[0];
                const last = window[window.length - 1];
                const sum = (row: any) => (row.paid ?? 0) + (row.free ?? 0) + (row.comped ?? 0);
                lines.push(
                    `Member count trend: ${sum(first)} (${first.date}) -> ${sum(last)} (${last.date}), ` +
                        `paid ${first.paid ?? 0} -> ${last.paid ?? 0}`
                );
            }

            const mrrStats = await adminGetOptional("stats/mrr/");
            const mrrSeries: any[] = mrrStats?.stats ?? [];
            if (Array.isArray(mrrSeries) && mrrSeries.length > 0) {
                const window = mrrSeries.slice(-days);
                const first = window[0];
                const last = window[window.length - 1];
                const fmt = (row: any) =>
                    `${((row.mrr ?? 0) / 100).toFixed(2)} ${String(row.currency ?? "").toUpperCase()}`;
                lines.push(`MRR: ${fmt(first)} (${first.date}) -> ${fmt(last)} (${last.date})`);
            } else {
                lines.push(`MRR: not available (no paid tiers, or this Ghost version does not expose /stats/mrr/).`);
            }

            return text(lines.join("\n"));
        }
    );

    server.tool(
        "email_performance",
        "Open/delivery performance for recent newsletter sends, newest first. Read-only.",
        { limit: z.number().optional().describe("How many sends, default 10") },
        async (args, _extra) => {
            const rows = await emailRows(args.limit ?? 10);
            if (rows === null) {
                return text("This Ghost site does not expose the /emails/ endpoint (or no newsletters are configured).");
            }
            if (rows.length === 0) return text("No newsletter sends found.");
            const delivered = rows.reduce((sum, e) => sum + (e.delivered_count ?? e.email_count ?? 0), 0);
            const opened = rows.reduce((sum, e) => sum + (e.opened_count ?? 0), 0);
            return text(
                [
                    `Last ${rows.length} newsletter sends (aggregate open rate ${pct(opened, delivered)}):`,
                    ...rows.map(describeEmail),
                ].join("\n")
            );
        }
    );

    server.tool(
        "top_posts",
        "Recently published posts ranked by newsletter engagement (opens per delivery). Read-only.",
        {
            limit: z.number().optional().describe("How many posts to return, default 10"),
            days: z.number().optional().describe("Lookback window in days, default 90"),
        },
        async (args, _extra) => {
            const days = args.days ?? 90;
            const posts: any = await ghostApiClient.posts.browse({
                filter: `status:published+published_at:>${nqlTimestamp(isoDaysAgo(days))}`,
                include: "email",
                order: "published_at DESC",
                limit: 50,
            });
            if (!posts.length) return text(`No posts published in the last ${days} days.`);
            const ranked = posts
                .map((post: any) => {
                    const email = post.email;
                    const delivered = email?.delivered_count ?? email?.email_count ?? 0;
                    const opened = email?.opened_count ?? 0;
                    return { post, delivered, opened, rate: delivered ? opened / delivered : -1 };
                })
                .sort((x: any, y: any) => y.rate - x.rate || y.opened - x.opened)
                .slice(0, args.limit ?? 10);
            return text(
                [
                    `Top posts of the last ${days} days by email engagement:`,
                    ...ranked.map((entry: any, position: number) =>
                        entry.rate >= 0
                            ? `${position + 1}. "${entry.post.title}" - ${entry.opened}/${entry.delivered} opened (${pct(entry.opened, entry.delivered)}) - ${entry.post.url ?? entry.post.slug}`
                            : `${position + 1}. "${entry.post.title}" - not sent as email - ${entry.post.url ?? entry.post.slug}`
                    ),
                ].join("\n")
            );
        }
    );

    server.tool(
        "member_activity",
        "Recent member events (signups, payments, email opens...) from the activity feed. Read-only.",
        { limit: z.number().optional().describe("Max events, default 20") },
        async (args, _extra) => {
            const data = await adminGetOptional("members/events/", { limit: args.limit ?? 20 });
            const events: any[] = data?.events ?? [];
            if (!data) return text("This Ghost version does not expose the member events endpoint.");
            if (events.length === 0) return text("No recent member activity.");
            return text(
                events
                    .map((event) => {
                        const who =
                            event.data?.member?.email ?? event.data?.member?.name ?? "unknown member";
                        const when = event.data?.created_at ?? "";
                        const extra =
                            event.type === "signup_event" && event.data?.attribution?.title
                                ? ` (attributed to "${event.data.attribution.title}")`
                                : "";
                        return `- ${event.type} - ${who} ${when}${extra}`;
                    })
                    .join("\n")
            );
        }
    );

    server.tool(
        "site_weekly_report",
        "One-call composite: what happened on the site in the last 7 days - publishing, member growth, and newsletter performance. Read-only.",
        {},
        async (_args, _extra) => {
            const since = isoDaysAgo(7);
            const lines: string[] = [`Weekly report (since ${since.slice(0, 10)})`, ``];

            try {
                const posts: any = await ghostApiClient.posts.browse({
                    filter: `status:published+published_at:>${nqlTimestamp(since)}`,
                    order: "published_at DESC",
                    limit: 25,
                });
                lines.push(`Published ${posts.length} post(s):`);
                for (const post of posts) lines.push(`- "${post.title}" (${post.published_at})`);
                if (posts.length === 0) lines[lines.length - 1] = "Published 0 posts this week.";
            } catch {
                lines.push("Could not fetch this week's posts.");
            }
            lines.push("");

            const [newMembers, newPaid, total] = await Promise.all([
                countMembers(`created_at:>${nqlTimestamp(since)}`),
                countMembers(`created_at:>${nqlTimestamp(since)}+status:paid`),
                countMembers(),
            ]);
            lines.push(
                `Members: ${newMembers ?? "?"} new this week` +
                    (newPaid ? ` (${newPaid} paid)` : "") +
                    (total !== null ? `, ${total} total` : "")
            );

            const mrrStats = await adminGetOptional("stats/mrr/");
            const mrrSeries: any[] = mrrStats?.stats ?? [];
            if (mrrSeries.length > 0) {
                const window = mrrSeries.slice(-7);
                const delta = (window[window.length - 1].mrr ?? 0) - (window[0].mrr ?? 0);
                const currency = String(window[window.length - 1].currency ?? "").toUpperCase();
                lines.push(
                    `MRR change this week: ${delta >= 0 ? "+" : ""}${(delta / 100).toFixed(2)} ${currency} ` +
                        `(now ${((window[window.length - 1].mrr ?? 0) / 100).toFixed(2)} ${currency})`
                );
            }
            lines.push("");

            const rows = await emailRows(5);
            const recentSends = (rows ?? []).filter(
                (email) => email.submitted_at && email.submitted_at >= since
            );
            if (recentSends.length > 0) {
                lines.push(`Newsletter sends this week:`);
                for (const email of recentSends) lines.push(describeEmail(email));
            } else {
                lines.push(`No newsletter sends this week.`);
            }

            return text(lines.join("\n"));
        }
    );
}
