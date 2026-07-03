// Spins up the built server over stdio with fake credentials and verifies the
// MCP handshake, tool registration, and the local-only tools end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("server boots, registers new tools, and local tools work", async () => {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "build/server.js")],
        env: {
            ...process.env,
            GHOST_API_URL: "https://example.invalid",
            GHOST_ADMIN_API_KEY: "0123456789abcdef01234567:" + "00".repeat(32),
            GHOST_MCP_DATA_DIR: mkdtempSync(join(tmpdir(), "ghost-mcp-smoke-")),
        },
    });
    const client = new Client({ name: "smoke", version: "0.0.0" });
    await client.connect(transport);
    try {
        const { tools } = await client.listTools();
        const names = tools.map((tool) => tool.name);
        for (const expected of [
            // editorial workflow
            "posts_propose_edit",
            "posts_apply_edit",
            "posts_rollback",
            "posts_schedule",
            "posts_list_snapshots",
            // content graph
            "content_search",
            "suggest_internal_links",
            "find_overlapping_posts",
            "content_gaps",
            "content_reindex",
            // analytics
            "analytics_summary",
            "email_performance",
            "top_posts",
            "member_activity",
            "site_weekly_report",
            // images
            "images_upload",
            // pre-existing tools still present
            "posts_browse",
            "members_browse",
        ]) {
            assert.ok(names.includes(expected), `missing tool ${expected}`);
        }

        // Resources: activity feed is registered and subscribable.
        const { resources } = await client.listResources();
        assert.ok(resources.some((resource) => resource.uri === "activity://feed"));
        const caps = client.getServerCapabilities();
        assert.equal(caps.resources?.subscribe, true);

        // Local-only tools run without a reachable Ghost instance.
        const proposals = await client.callTool({ name: "posts_list_proposals", arguments: {} });
        assert.match(proposals.content[0].text, /No pending proposals/);
        const snapshots = await client.callTool({ name: "posts_list_snapshots", arguments: {} });
        assert.match(snapshots.content[0].text, /No snapshots/);
    } finally {
        await client.close();
    }
});
