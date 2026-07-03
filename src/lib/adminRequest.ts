// Raw Ghost Admin API requests for endpoints not covered by @tryghost/admin-api
// (stats, emails, member events). Signs a short-lived HS256 JWT the same way
// the official client does.
import { createHmac } from "crypto";
import { GHOST_API_URL, GHOST_ADMIN_API_KEY } from "../config";

function base64url(input: Buffer | string): string {
    return Buffer.from(input)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

export function makeAdminToken(apiKey: string = GHOST_ADMIN_API_KEY): string {
    const [id, secret] = apiKey.split(":");
    if (!id || !secret) {
        throw new Error("GHOST_ADMIN_API_KEY must be in <id>:<secret> format");
    }
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }));
    const payload = base64url(
        JSON.stringify({ iat: now, exp: now + 5 * 60, aud: "/admin/" })
    );
    const signature = createHmac("sha256", Buffer.from(secret, "hex"))
        .update(`${header}.${payload}`)
        .digest();
    return `${header}.${payload}.${base64url(signature)}`;
}

export class GhostAdminRequestError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        public readonly endpoint: string
    ) {
        super(message);
        this.name = "GhostAdminRequestError";
    }
}

/**
 * Perform a GET against the Ghost Admin API, e.g. adminGet("stats/member_count/").
 * Returns the parsed JSON body.
 */
export async function adminGet(
    endpoint: string,
    params?: Record<string, string | number | undefined>
): Promise<any> {
    const base = GHOST_API_URL.replace(/\/+$/, "");
    const url = new URL(`${base}/ghost/api/admin/${endpoint.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
        headers: {
            Authorization: `Ghost ${makeAdminToken()}`,
            "Accept-Version": "v5.0",
        },
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new GhostAdminRequestError(
            `Ghost Admin API ${endpoint} returned ${response.status}: ${body.slice(0, 300)}`,
            response.status,
            endpoint
        );
    }
    return response.json();
}

/**
 * Like adminGet, but returns null instead of throwing when the endpoint is
 * unavailable (404/403) — used for stats endpoints that vary by Ghost version.
 */
export async function adminGetOptional(
    endpoint: string,
    params?: Record<string, string | number | undefined>
): Promise<any | null> {
    try {
        return await adminGet(endpoint, params);
    } catch (error) {
        if (error instanceof GhostAdminRequestError && [403, 404, 501].includes(error.status)) {
            return null;
        }
        throw error;
    }
}
