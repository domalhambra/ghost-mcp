// In-memory content index over the whole published corpus.
// BM25 for query -> post search, TF-IDF cosine for post <-> post similarity.
// Rebuilt lazily and cached; refresh with content_reindex or after TTL.
import { ghostApiClient } from "../ghostApi";
import { htmlToText, tokenize, termCounts } from "../lib/html";

export interface IndexedPost {
    id: string;
    title: string;
    slug: string;
    url?: string;
    status: string;
    published_at?: string;
    excerpt: string;
    tags: string[];
    text: string;
    tokens: string[];
    counts: Map<string, number>;
    length: number;
    vector: Map<string, number>; // tf-idf, L2-normalized
}

export interface ContentIndex {
    builtAt: number;
    posts: IndexedPost[];
    documentFrequency: Map<string, number>;
    averageLength: number;
    idf(term: string): number;
}

const TTL_MS = 10 * 60 * 1000;
let cached: ContentIndex | null = null;
let building: Promise<ContentIndex> | null = null;

async function fetchAllPosts(): Promise<any[]> {
    const all: any[] = [];
    let page = 1;
    for (;;) {
        const batch: any = await ghostApiClient.posts.browse({
            limit: 100,
            page,
            include: "tags",
            formats: "html",
            filter: "status:[published,draft,scheduled]",
        });
        all.push(...batch);
        const pages = batch?.meta?.pagination?.pages ?? page;
        if (page >= pages || batch.length === 0) break;
        page++;
    }
    return all;
}

function buildIndex(rawPosts: any[]): ContentIndex {
    const posts: IndexedPost[] = rawPosts.map((post) => {
        const text = `${post.title ?? ""}\n${htmlToText(post.html)}`;
        const tokens = tokenize(text);
        const counts = termCounts(tokens);
        return {
            id: post.id,
            title: post.title ?? "(untitled)",
            slug: post.slug,
            url: post.url,
            status: post.status,
            published_at: post.published_at ?? undefined,
            excerpt: htmlToText(post.html).slice(0, 240),
            tags: (post.tags ?? []).map((tag: any) => tag.name),
            text,
            tokens,
            counts,
            length: tokens.length,
            vector: new Map(),
        };
    });

    const documentFrequency = new Map<string, number>();
    for (const post of posts) {
        for (const term of post.counts.keys()) {
            documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
        }
    }
    const total = posts.length || 1;
    const averageLength =
        posts.reduce((sum, post) => sum + post.length, 0) / total || 1;

    const idf = (term: string) => {
        const df = documentFrequency.get(term) ?? 0;
        return Math.log(1 + (total - df + 0.5) / (df + 0.5));
    };

    // Precompute normalized tf-idf vectors for similarity.
    for (const post of posts) {
        let norm = 0;
        for (const [term, tf] of post.counts) {
            const weight = (1 + Math.log(tf)) * idf(term);
            post.vector.set(term, weight);
            norm += weight * weight;
        }
        norm = Math.sqrt(norm) || 1;
        for (const [term, weight] of post.vector) {
            post.vector.set(term, weight / norm);
        }
    }

    return { builtAt: Date.now(), posts, documentFrequency, averageLength, idf };
}

export async function getIndex(force = false): Promise<ContentIndex> {
    if (!force && cached && Date.now() - cached.builtAt < TTL_MS) return cached;
    if (!building) {
        building = fetchAllPosts()
            .then((raw) => {
                cached = buildIndex(raw);
                return cached;
            })
            .finally(() => {
                building = null;
            });
    }
    return building;
}

/** BM25 score of a tokenized query against one indexed post. */
export function bm25Score(index: ContentIndex, post: IndexedPost, queryTokens: string[]): number {
    const k1 = 1.4;
    const b = 0.75;
    let score = 0;
    for (const term of new Set(queryTokens)) {
        const tf = post.counts.get(term) ?? 0;
        if (tf === 0) continue;
        score +=
            index.idf(term) *
            ((tf * (k1 + 1)) /
                (tf + k1 * (1 - b + b * (post.length / index.averageLength))));
    }
    return score;
}

/** Cosine similarity between two indexed posts (precomputed normalized vectors). */
export function cosine(a: IndexedPost, b: IndexedPost): number {
    const [small, large] = a.vector.size <= b.vector.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [term, weight] of small.vector) {
        const other = large.vector.get(term);
        if (other) dot += weight * other;
    }
    return dot;
}

/** Cosine similarity of an ad-hoc document (e.g. a draft) against a post. */
export function cosineForText(index: ContentIndex, text: string, post: IndexedPost): number {
    const counts = termCounts(tokenize(text));
    let norm = 0;
    const vector = new Map<string, number>();
    for (const [term, tf] of counts) {
        const weight = (1 + Math.log(tf)) * index.idf(term);
        vector.set(term, weight);
        norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    let dot = 0;
    for (const [term, weight] of vector) {
        const other = post.vector.get(term);
        if (other) dot += (weight / norm) * other;
    }
    return dot;
}

/** Top shared high-signal terms between a document and a post - used for anchor text hints. */
export function sharedTerms(index: ContentIndex, text: string, post: IndexedPost, limit = 5): string[] {
    const counts = termCounts(tokenize(text));
    return [...counts.keys()]
        .filter((term) => post.counts.has(term))
        .sort(
            (x, y) =>
                (post.vector.get(y) ?? 0) * index.idf(y) -
                (post.vector.get(x) ?? 0) * index.idf(x)
        )
        .slice(0, limit);
}
