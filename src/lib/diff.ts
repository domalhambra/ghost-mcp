// Minimal line-based diff (LCS) producing a unified-style, human-readable diff.
// Kept dependency-free on purpose.

function lcsMatrix(a: string[], b: string[]): number[][] {
    const matrix: number[][] = Array.from({ length: a.length + 1 }, () =>
        new Array(b.length + 1).fill(0)
    );
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            matrix[i][j] =
                a[i] === b[j]
                    ? matrix[i + 1][j + 1] + 1
                    : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
        }
    }
    return matrix;
}

export interface DiffLine {
    kind: "same" | "add" | "del";
    text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
    const a = before.split("\n");
    const b = after.split("\n");
    // Guard against pathological inputs (very long documents): fall back to a
    // whole-document replace representation beyond ~4M cell comparisons.
    if (a.length * b.length > 4_000_000) {
        return [
            ...a.map((text) => ({ kind: "del" as const, text })),
            ...b.map((text) => ({ kind: "add" as const, text })),
        ];
    }
    const matrix = lcsMatrix(a, b);
    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            out.push({ kind: "same", text: a[i] });
            i++;
            j++;
        } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
            out.push({ kind: "del", text: a[i] });
            i++;
        } else {
            out.push({ kind: "add", text: b[j] });
            j++;
        }
    }
    while (i < a.length) out.push({ kind: "del", text: a[i++] });
    while (j < b.length) out.push({ kind: "add", text: b[j++] });
    return out;
}

/**
 * Render a compact unified-style diff with `context` lines of surrounding
 * unchanged text. Returns "(no changes)" when the inputs are identical.
 */
export function renderDiff(before: string, after: string, context = 2): string {
    const lines = diffLines(before, after);
    if (!lines.some((line) => line.kind !== "same")) return "(no changes)";

    const keep = new Array(lines.length).fill(false);
    lines.forEach((line, index) => {
        if (line.kind === "same") return;
        for (
            let k = Math.max(0, index - context);
            k <= Math.min(lines.length - 1, index + context);
            k++
        ) {
            keep[k] = true;
        }
    });

    const out: string[] = [];
    let inGap = false;
    lines.forEach((line, index) => {
        if (!keep[index]) {
            if (!inGap) {
                out.push("  ...");
                inGap = true;
            }
            return;
        }
        inGap = false;
        const prefix = line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  ";
        out.push(prefix + line.text);
    });
    return out.join("\n");
}
