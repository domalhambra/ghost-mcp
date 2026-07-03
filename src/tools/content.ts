// Semantic content graph tools: site-wide search, internal link suggestions,
// overlap detection, and content gap analysis over the indexed corpus.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    getIndex,
    bm25Score,
    cosine,
    cosineForText,
    sharedTerms,
    IndexedPost,
} from "../content/indexer";
import { tokenize, htmlToText } from "../lib/html";

function text(value: string) {
    return { content: [{ type: "text" as const, text: value }] };
}

function label(post: IndexedPost): string {
    const where = post.url ?? `slug: ${post.slug}`;
    return `"${post.title}" [${post.status}] (id: ${post.id}, ${where})`;
}

export function registerContentTools(server: McpServer) {
    server.tool(
        "content_search",
        "Rank every post on the site against a natural-language query (BM25 over full text, not just titles). Use this to ground new writing in what the site already covers.",
        {
            query: z.string(),
            limit: z.number().optional().describe("Max results, default 8"),
            include_drafts: z.boolean().optional().describe("Also match drafts/scheduled posts"),
        },
        async (args, _extra) => {
            const index = await getIndex();
            const queryTokens = tokenize(args.query);
            if (queryTokens.length === 0) return text("Query contained no searchable terms.");
            const candidates = index.posts.filter(
                (post) => args.include_drafts || post.status === "published"
            );
            const ranked = candidates
                .map((post) => ({ post, score: bm25Score(index, post, queryTokens) }))
                .filter((entry) => entry.score > 0)
                .sort((x, y) => y.score - x.score)
                .slice(0, args.limit ?? 8);
            if (ranked.length === 0) {
                return text(`No posts matched "${args.query}" (${candidates.length} posts indexed).`);
            }
            return text(
                ranked
                    .map(
                        (entry, position) =>
                            `${position + 1}. ${label(entry.post)} - score ${entry.score.toFixed(2)}\n   ${entry.post.excerpt}`
                    )
                    .join("\n")
            );
        }
    );

    server.tool(
        "suggest_internal_links",
        "Given draft text (or an existing post id), suggest existing published posts it should link to, with anchor-text hints. Top-tier internal-linking SEO in one call.",
        {
            text: z.string().optional().describe("Draft content (HTML or plain text)"),
            post_id: z.string().optional().describe("Alternatively, analyze an existing post"),
            limit: z.number().optional().describe("Max suggestions, default 8"),
        },
        async (args, _extra) => {
            const index = await getIndex();
            let sourceText: string;
            let excludeId: string | undefined;
            if (args.post_id) {
                const post = index.posts.find((candidate) => candidate.id === args.post_id);
                if (!post) return text(`Post ${args.post_id} not found in the index.`);
                sourceText = post.text;
                excludeId = post.id;
            } else if (args.text) {
                sourceText = htmlToText(args.text) || args.text;
            } else {
                return text("Provide either text or post_id.");
            }

            const ranked = index.posts
                .filter((post) => post.status === "published" && post.id !== excludeId)
                .map((post) => ({ post, score: cosineForText(index, sourceText, post) }))
                .filter((entry) => entry.score > 0.05)
                .sort((x, y) => y.score - x.score)
                .slice(0, args.limit ?? 8);

            if (ranked.length === 0) return text("No sufficiently related published posts found.");
            return text(
                ranked
                    .map((entry, position) => {
                        const anchors = sharedTerms(index, sourceText, entry.post, 4);
                        return (
                            `${position + 1}. ${label(entry.post)} - relevance ${(entry.score * 100).toFixed(0)}%\n` +
                            `   link it where the draft discusses: ${anchors.join(", ") || entry.post.title}`
                        );
                    })
                    .join("\n")
            );
        }
    );

    server.tool(
        "find_overlapping_posts",
        "Detect pairs of published posts covering near-identical ground (potential SEO cannibalization or merge candidates).",
        {
            threshold: z
                .number()
                .optional()
                .describe("Cosine similarity cutoff 0-1, default 0.45"),
        },
        async (args, _extra) => {
            const index = await getIndex();
            const published = index.posts.filter((post) => post.status === "published");
            const threshold = args.threshold ?? 0.45;
            const pairs: { a: IndexedPost; b: IndexedPost; score: number }[] = [];
            for (let i = 0; i < published.length; i++) {
                for (let j = i + 1; j < published.length; j++) {
                    const score = cosine(published[i], published[j]);
                    if (score >= threshold) pairs.push({ a: published[i], b: published[j], score });
                }
            }
            pairs.sort((x, y) => y.score - x.score);
            if (pairs.length === 0) {
                return text(
                    `No pairs above similarity ${threshold} across ${published.length} published posts - no obvious cannibalization.`
                );
            }
            return text(
                pairs
                    .slice(0, 20)
                    .map(
                        (pair) =>
                            `${(pair.score * 100).toFixed(0)}% - ${label(pair.a)}\n      vs ${label(pair.b)}`
                    )
                    .join("\n")
            );
        }
    );

    server.tool(
        "content_gaps",
        "Map the site's topic coverage: greedy similarity clusters with their key terms, thin one-post topics, and tag usage - highlighting where the corpus is shallow.",
        {},
        async (_args, _extra) => {
            const index = await getIndex();
            const published = index.posts.filter((post) => post.status === "published");
            if (published.length === 0) return text("No published posts to analyze.");

            // Greedy clustering: assign each post to the first cluster whose seed is similar enough.
            const clusters: { seed: IndexedPost; members: IndexedPost[] }[] = [];
            for (const post of published) {
                const home = clusters.find((cluster) => cosine(cluster.seed, post) >= 0.3);
                if (home) home.members.push(post);
                else clusters.push({ seed: post, members: [post] });
            }
            clusters.sort((x, y) => y.members.length - x.members.length);

            const topTerms = (cluster: { members: IndexedPost[] }) => {
                const scores = new Map<string, number>();
                for (const member of cluster.members) {
                    for (const [term, weight] of member.vector) {
                        scores.set(term, (scores.get(term) ?? 0) + weight * index.idf(term));
                    }
                }
                return [...scores.entries()]
                    .sort((x, y) => y[1] - x[1])
                    .slice(0, 5)
                    .map(([term]) => term);
            };

            const strong = clusters.filter((cluster) => cluster.members.length >= 2);
            const thin = clusters.filter((cluster) => cluster.members.length === 1);

            const tagCounts = new Map<string, number>();
            for (const post of published) {
                for (const tag of post.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
            }
            const thinTags = [...tagCounts.entries()]
                .filter(([, count]) => count <= 1)
                .map(([tag]) => tag);

            const sections = [
                `Indexed ${published.length} published posts into ${clusters.length} topic clusters.`,
                ``,
                `Established topics (invest or interlink):`,
                ...strong
                    .slice(0, 10)
                    .map(
                        (cluster) =>
                            `- ${cluster.members.length} posts around [${topTerms(cluster).join(", ")}]: ` +
                            cluster.members.map((member) => `"${member.title}"`).join(", ")
                    ),
                ``,
                `Thin coverage (one post, candidates to expand into series or hubs):`,
                ...thin.slice(0, 15).map(
                    (cluster) => `- "${cluster.seed.title}" [${topTerms(cluster).join(", ")}]`
                ),
                thinTags.length ? `` : ``,
                thinTags.length ? `Tags used only once: ${thinTags.join(", ")}` : ``,
            ].filter((line) => line !== undefined);
            return text(sections.filter((line, i, arr) => line !== "" || arr[i - 1] !== "").join("\n"));
        }
    );

    server.tool(
        "content_reindex",
        "Force a rebuild of the local content index (it otherwise refreshes every 10 minutes).",
        {},
        async (_args, _extra) => {
            const index = await getIndex(true);
            return text(`Reindexed ${index.posts.length} posts (${index.documentFrequency.size} unique terms).`);
        }
    );
}
