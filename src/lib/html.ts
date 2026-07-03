// Lightweight HTML -> text utilities for indexing and diffing.

export function htmlToText(html: string | null | undefined): string {
    if (!html) return "";
    return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

const STOPWORDS = new Set(
    (
        "a an and are as at be but by for from has have how i if in into is it its " +
        "of on or that the their there these they this to was we were what when where " +
        "which who will with you your not can our more all one just so than then them " +
        "do does did been being also about after before over under out up down my me"
    ).split(" ")
);

export function tokenize(text: string): string[] {
    return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter(
        (token) => token.length > 2 && !STOPWORDS.has(token)
    );
}

/** Term frequency map for a document. */
export function termCounts(tokens: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const token of tokens) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return counts;
}
