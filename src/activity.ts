// Live activity feed: an MCP resource (activity://feed) with real
// subscription support. While at least one client is subscribed, the server
// polls Ghost for new posts/members and pushes notifications/resources/updated
// so "you just got a new member" arrives without the user asking.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ghostApiClient } from "./ghostApi";

export const ACTIVITY_URI = "activity://feed";
const POLL_MS = 60_000;

interface FeedState {
    latestPostUpdatedAt?: string;
    latestMemberCreatedAt?: string;
    totalMembers?: number;
}

async function readFeedState(): Promise<FeedState> {
    const state: FeedState = {};
    try {
        const posts: any = await ghostApiClient.posts.browse({ limit: 1, order: "updated_at DESC" });
        state.latestPostUpdatedAt = posts[0]?.updated_at;
    } catch {
        /* site may have no posts */
    }
    try {
        const members: any = await ghostApiClient.members.browse({ limit: 1, order: "created_at DESC" });
        state.latestMemberCreatedAt = members[0]?.created_at;
        state.totalMembers = members?.meta?.pagination?.total;
    } catch {
        /* members API may be disabled */
    }
    return state;
}

export function registerActivityFeed(server: McpServer) {
    // The high-level McpServer only advertises subscribe support if we say so.
    server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });

    server.resource("activity-feed", ACTIVITY_URI, async (uri) => {
        const [posts, members]: any[] = await Promise.all([
            ghostApiClient.posts
                .browse({ limit: 5, order: "updated_at DESC", fields: "id,title,status,updated_at,url" })
                .catch(() => []),
            ghostApiClient.members
                .browse({ limit: 5, order: "created_at DESC" })
                .catch(() => []),
        ]);
        const lines = [
            `Recent site activity (${new Date().toISOString()})`,
            ``,
            `Latest posts:`,
            ...posts.map((post: any) => `- "${post.title}" [${post.status}] updated ${post.updated_at}`),
            ``,
            `Newest members (${members?.meta?.pagination?.total ?? "?"} total):`,
            ...members.map(
                (member: any) =>
                    `- ${member.email ?? member.name ?? member.id} joined ${member.created_at} (${member.status})`
            ),
        ];
        return { contents: [{ uri: uri.href, text: lines.join("\n") }] };
    });

    const subscriptions = new Set<string>();
    let lastState: FeedState | null = null;
    let timer: NodeJS.Timeout | null = null;

    async function poll() {
        try {
            const state = await readFeedState();
            const changed =
                lastState !== null &&
                (state.latestPostUpdatedAt !== lastState.latestPostUpdatedAt ||
                    state.latestMemberCreatedAt !== lastState.latestMemberCreatedAt);
            lastState = state;
            if (changed && subscriptions.has(ACTIVITY_URI)) {
                await server.server.notification({
                    method: "notifications/resources/updated",
                    params: { uri: ACTIVITY_URI },
                });
            }
        } catch {
            /* transient polling errors are fine; try again next tick */
        }
    }

    function ensurePolling() {
        if (subscriptions.size > 0 && !timer) {
            void poll(); // establish the baseline immediately
            timer = setInterval(poll, POLL_MS);
            timer.unref?.();
        } else if (subscriptions.size === 0 && timer) {
            clearInterval(timer);
            timer = null;
            lastState = null;
        }
    }

    server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
        subscriptions.add(request.params.uri);
        ensurePolling();
        return {};
    });

    server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
        subscriptions.delete(request.params.uri);
        ensurePolling();
        return {};
    });
}
