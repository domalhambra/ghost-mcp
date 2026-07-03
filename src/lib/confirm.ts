// In-protocol confirmation for destructive operations. Uses MCP elicitation
// when the client supports it; otherwise callers fall back to requiring an
// explicit confirm=true argument.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ConfirmResult = "accepted" | "declined" | "unsupported";

export async function confirmWithUser(
    server: McpServer,
    message: string
): Promise<ConfirmResult> {
    try {
        const capabilities = server.server.getClientCapabilities();
        if (!capabilities?.elicitation) return "unsupported";
        const result = await server.server.elicitInput({
            message,
            requestedSchema: {
                type: "object",
                properties: {
                    confirm: {
                        type: "boolean",
                        title: "Confirm",
                        description: "Set to true to approve this change.",
                    },
                },
                required: ["confirm"],
            },
        });
        return result.action === "accept" && (result.content as any)?.confirm === true
            ? "accepted"
            : "declined";
    } catch {
        // Clients that advertise elicitation but fail the request should not
        // block the fallback path.
        return "unsupported";
    }
}
