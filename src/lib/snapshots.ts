// Snapshot-before-write safety net. Every destructive post operation stores
// the prior state locally so it can be rolled back with posts_rollback.
import { JsonStore, shortId } from "./store";

export interface PostSnapshot {
    id: string;
    post_id: string;
    post_title: string;
    reason: string;
    taken_at: string;
    post: any; // full post object as returned by the Admin API
}

interface SnapshotFile {
    snapshots: PostSnapshot[];
}

const MAX_PER_POST = 20;
const MAX_TOTAL = 400;

const store = new JsonStore<SnapshotFile>("snapshots.json", { snapshots: [] });

export function takeSnapshot(post: any, reason: string): PostSnapshot {
    const snapshot: PostSnapshot = {
        id: shortId("snap"),
        post_id: post.id,
        post_title: post.title ?? "(untitled)",
        reason,
        taken_at: new Date().toISOString(),
        post,
    };
    store.update((file) => {
        file.snapshots.push(snapshot);
        // Trim per-post history, then global history (oldest first).
        const forPost = file.snapshots.filter((s) => s.post_id === post.id);
        if (forPost.length > MAX_PER_POST) {
            const drop = new Set(
                forPost.slice(0, forPost.length - MAX_PER_POST).map((s) => s.id)
            );
            file.snapshots = file.snapshots.filter((s) => !drop.has(s.id));
        }
        if (file.snapshots.length > MAX_TOTAL) {
            file.snapshots = file.snapshots.slice(file.snapshots.length - MAX_TOTAL);
        }
    });
    return snapshot;
}

export function listSnapshots(postId?: string): PostSnapshot[] {
    const all = store.read().snapshots;
    const filtered = postId ? all.filter((s) => s.post_id === postId) : all;
    return filtered.slice().reverse(); // newest first
}

export function getSnapshot(snapshotId: string): PostSnapshot | undefined {
    return store.read().snapshots.find((s) => s.id === snapshotId);
}
