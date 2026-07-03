// Image upload - previously missing entirely, so the server could not create
// a complete post. Accepts a local file path or a remote URL.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync, existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, extname } from "path";
import { randomBytes } from "crypto";
import { ghostApiClient } from "../ghostApi";

const EXT_BY_TYPE: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
};

export function registerImageTools(server: McpServer) {
    server.tool(
        "images_upload",
        "Upload an image to Ghost from a local file path or a remote URL. Returns the hosted image URL to use as feature_image or inside post HTML.",
        {
            source: z.string().describe("Absolute local file path, or an http(s) URL to download and upload"),
            purpose: z
                .enum(["image", "profile_image", "icon"])
                .optional()
                .describe("What the image is for, default 'image'"),
            ref: z.string().optional().describe("Optional reference echoed back by Ghost"),
        },
        async (args, _extra) => {
            let filePath = args.source;
            let temp: string | null = null;

            if (/^https?:\/\//i.test(args.source)) {
                const response = await fetch(args.source);
                if (!response.ok) {
                    throw new Error(`Failed to download ${args.source}: HTTP ${response.status}`);
                }
                const contentType = response.headers.get("content-type")?.split(";")[0] ?? "";
                const ext =
                    EXT_BY_TYPE[contentType] ??
                    (extname(new URL(args.source).pathname) || ".jpg");
                temp = join(tmpdir(), `ghost-mcp-upload-${randomBytes(4).toString("hex")}${ext}`);
                writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
                filePath = temp;
            } else if (!existsSync(filePath)) {
                return {
                    content: [
                        { type: "text" as const, text: `File not found: ${filePath}` },
                    ],
                    isError: true,
                };
            }

            try {
                const result = await ghostApiClient.images.upload({
                    file: filePath,
                    purpose: args.purpose ?? "image",
                    ...(args.ref ? { ref: args.ref } : {}),
                });
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Uploaded. Image URL: ${result.url}${result.ref ? ` (ref: ${result.ref})` : ""}`,
                        },
                    ],
                };
            } finally {
                if (temp) {
                    try {
                        unlinkSync(temp);
                    } catch {
                        /* best effort cleanup */
                    }
                }
            }
        }
    );
}
