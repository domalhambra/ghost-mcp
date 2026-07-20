// src/tools/pages.ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ghostApiClient } from "../ghostApi";

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

export function registerPageTools(server: McpServer) {
  // Browse pages
  server.tool(
    "pages_browse",
    browseParams,
    async (args, _extra) => {
      const pages = await ghostApiClient.pages.browse({ ...args, include: 'tags' } as any);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(pages, null, 2),
          },
        ],
      };
    }
  );

  // Read page
  server.tool(
    "pages_read",
    readParams,
    async (args, _extra) => {
      const page = await ghostApiClient.pages.read(args, { include: 'tags' } as any);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(page, null, 2),
          },
        ],
      };
    }
  );

  // Add page
  server.tool(
    "pages_add",
    addParams,
    async (args, _extra) => {
      const options = args.html ? { source: "html" } : undefined;
      const page = await ghostApiClient.pages.add(args, options);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(page, null, 2),
          },
        ],
      };
    }
  );

  // Edit page
  server.tool(
    "pages_edit",
    editParams,
    async (args, _extra) => {
      // If tags not provided, read existing page to preserve its tags.
      // Ghost silently strips all tags if the tags field is absent from the payload.
      let tags = args.tags;
      if (tags === undefined) {
        const existing = await ghostApiClient.pages.read({ id: args.id }, { include: 'tags' } as any);
        tags = (existing as any).tags ?? [];
      }
      const options = args.html ? { source: "html" } : undefined;
      const page = await ghostApiClient.pages.edit({ ...args, tags } as any, options);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(page, null, 2),
          },
        ],
      };
    }
  );

  // Delete page
  server.tool(
    "pages_delete",
    deleteParams,
    async (args, _extra) => {
      await ghostApiClient.pages.delete(args);
      return {
        content: [
          {
            type: "text",
            text: `Page with id ${args.id} deleted.`,
          },
        ],
      };
    }
  );
}
