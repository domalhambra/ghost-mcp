// Simple JSON file persistence for proposals and snapshots.
// Data lives in GHOST_MCP_DATA_DIR or ~/.ghost-mcp/.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

export function dataDir(): string {
    const dir = process.env.GHOST_MCP_DATA_DIR || join(homedir(), ".ghost-mcp");
    mkdirSync(dir, { recursive: true });
    return dir;
}

export function shortId(prefix: string): string {
    return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export class JsonStore<T> {
    private readonly path: string;

    constructor(fileName: string, private readonly empty: T) {
        this.path = join(dataDir(), fileName);
    }

    read(): T {
        try {
            return JSON.parse(readFileSync(this.path, "utf8")) as T;
        } catch {
            return structuredClone(this.empty);
        }
    }

    write(value: T): void {
        const tmp = `${this.path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(value, null, 2));
        renameSync(tmp, this.path);
    }

    update(mutate: (value: T) => void): T {
        const value = this.read();
        mutate(value);
        this.write(value);
        return value;
    }
}
