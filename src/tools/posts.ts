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
  // Optional overrides so callers can request richer output (e.g. plaintext
  // body + authors) in one round trip instead of browsing then reading each
  // post individually. Defaults preserve prior behavior exactly.
  include: z.string().optional(),
  formats: z.array(z.string()).optional(),
};
const readParams = {
  id: z.string().optional(),
  slug: z.string().optional(),
  include: z.string().optional(),
  formats: z.array(z.string()).optional(),
};
const addParams = {
  title: z.string(),
  html: z.string().optional(),
  lexical: z.string().optional(),
  status: z.string().optional(),
  tags: z.array(z.union([z.object({ id: z.string() }), z.object({ slug: z.string() }), z.object({ name: z.string() })])).optional(),
};
const editParams = {
  id: z.string(),
  title: z.string().optional(),
  html: z.string().optional(),
  lexical: z.string().optional(),
  status: z.string().optional(),
  updated_at: z.string(),
  tags: z.array(z.union([z.object({ id: z.string() }), z.object({ slug: z.string() }), z.object({ name: z.string() })])).optional(),
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
      const { include, formats, ...rest } = args;
      const posts = await ghostApiClient.posts.browse({
        ...rest,
        include: include ?? 'tags',
        ...(formats ? { formats } : {}),
      } as any);
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
      const { include, formats, ...data } = args;
      const post = await ghostApiClient.posts.read(data, {
        include: include ?? 'tags',
        ...(formats ? { formats } : {}),
      } as any);
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
      // If tags not provided, read existing post to preserve its tags.
      // Ghost silently strips all tags if the tags field is absent from the payload.
      let tags = args.tags;
      if (tags === undefined) {
        const existing = await ghostApiClient.posts.read({ id: args.id }, { include: 'tags' } as any);
        tags = (existing as any).tags ?? [];
      }
      // If html is present, use source: "html" to ensure Ghost uses the html content for updates
      const options = args.html ? { source: "html" } : undefined;
      const post = await ghostApiClient.posts.edit({ ...args, tags } as any, options);
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