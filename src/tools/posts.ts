// src/tools/posts.ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ghostApiClient } from "../ghostApi";
import { takeSnapshot } from "../lib/snapshots";

// Best-effort snapshot before a destructive operation so posts_rollback can
// undo it. Never blocks the operation itself.
async function snapshotBefore(postId: string, reason: string): Promise<void> {
  try {
    const post = await ghostApiClient.posts.read(
      { id: postId },
      { formats: ["html", "lexical"] }
    );
    takeSnapshot(post, reason);
  } catch {
    // Post may not exist or formats may be unavailable; proceed anyway.
  }
}

// Parameter schemas as ZodRawShape (object literals)
const browseParams = {
  filter: z.string().optional(),
  limit: z.number().optional(),
  page: z.number().optional(),
  order: z.string().optional(),
};
const readParams = {
  id: z.string().optional(),
  slug: z.string().optional(),
};
const addParams = {
  title: z.string(),
  html: z.string().optional(),
  lexical: z.string().optional(),
  status: z.string().optional(),
};
const editParams = {
  id: z.string(),
  title: z.string().optional(),
  html: z.string().optional(),
  lexical: z.string().optional(),
  status: z.string().optional(),
  updated_at: z.string(),
};
const deleteParams = {
  id: z.string(),
};

export function registerPostTools(server: McpServer) {
  // Browse posts
  server.tool(
    "posts_browse",
    browseParams,
    async (args, _extra) => {
      const posts = await ghostApiClient.posts.browse(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(posts, null, 2),
          },
        ],
      };
    }
  );

  // Read post
  server.tool(
    "posts_read",
    readParams,
    async (args, _extra) => {
      const post = await ghostApiClient.posts.read(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(post, null, 2),
          },
        ],
      };
    }
  );

  // Add post
  server.tool(
    "posts_add",
    addParams,
    async (args, _extra) => {
      // If html is present, use source: "html" to ensure Ghost uses the html content
      const options = args.html ? { source: "html" } : undefined;
      const post = await ghostApiClient.posts.add(args, options);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(post, null, 2),
          },
        ],
      };
    }
  );

  // Edit post
  server.tool(
    "posts_edit",
    editParams,
    async (args, _extra) => {
      await snapshotBefore(args.id, "before posts_edit");
      // If html is present, use source: "html" to ensure Ghost uses the html content for updates
      const options = args.html ? { source: "html" } : undefined;
      const post = await ghostApiClient.posts.edit(args, options);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(post, null, 2),
          },
        ],
      };
    }
  );

  // Delete post
  server.tool(
    "posts_delete",
    deleteParams,
    async (args, _extra) => {
      await snapshotBefore(args.id, "before posts_delete");
      await ghostApiClient.posts.delete(args);
      return {
        content: [
          {
            type: "text",
            text: `Post with id ${args.id} deleted.`,
          },
        ],
      };
    }
  );
}