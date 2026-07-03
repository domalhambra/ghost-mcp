# Ghost MCP Server

## ‼️ Important Notice: Python to TypeScript Migration
I've completely rewritten the Ghost MCP Server from Python to TypeScript in this v0.1.0 release. This major change brings several benefits:

- Simplified installation: Now available as an NPM package (@fanyangmeng/ghost-mcp)
- Improved reliability: Uses the official @tryghost/admin-api client instead of custom implementation
- Better maintainability: TypeScript provides type safety and better code organization
- Streamlined configuration: Simple environment variable setup

### Breaking Changes

- Python dependencies are no longer required
- Configuration method has changed (now using Node.js environment variables)
- Docker deployment has been simplified
- Different installation process (now using NPM)

Please see the below updated documentation for details on migrating from the Python version. If you encounter any issues, feel free to open an issue on GitHub.

---

A Model Context Protocol (MCP) server for interacting with Ghost CMS through LLM interfaces like Claude. This server provides secure and comprehensive access to your Ghost blog, leveraging JWT authentication and a rich set of MCP tools for managing posts, users, members, tiers, offers, and newsletters.

![demo](./assets/ghost-mcp-demo.gif)

## Features

- Secure Ghost Admin API requests with `@tryghost/admin-api`
- Comprehensive entity access including posts, users, members, tiers, offers, and newsletters
- Advanced search functionality with both fuzzy and exact matching options
- Detailed, human-readable output for Ghost entities
- Robust error handling using custom `GhostError` exceptions
- Integrated logging support via MCP context for enhanced troubleshooting
- **Safe editorial workflow**: propose → diff → approve → publish, with snapshot-backed rollback and scheduling
- **Semantic content graph**: site-wide full-text search, internal link suggestions, overlap detection, and content gap analysis
- **Business intelligence**: member growth, MRR trends, email performance, and a one-call weekly report
- **Live activity feed**: an `activity://feed` MCP resource with real subscription support (pushes updates when new posts or members appear)
- **Image uploads** from local paths or remote URLs

## Usage

To use this with MCP clients, for instance, Claude Desktop, add the following to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
      "ghost-mcp": {
        "command": "npx",
        "args": ["-y", "@fanyangmeng/ghost-mcp"],
        "env": {
            "GHOST_API_URL": "https://yourblog.com",
            "GHOST_ADMIN_API_KEY": "your_admin_api_key",
            "GHOST_API_VERSION": "v5.0"
        }
      }
    }
}
```

## Available Resources

The following Ghost CMS resources are available through this MCP server:

- **Posts**: Articles and content published on your Ghost site.
- **Members**: Registered users and subscribers of your site.
- **Newsletters**: Email newsletters managed and sent via Ghost.
- **Offers**: Promotional offers and discounts for members.
- **Invites**: Invitations for new users or staff to join your Ghost site.
- **Roles**: User roles and permissions within the Ghost admin.
- **Tags**: Organizational tags for posts and content.
- **Tiers**: Subscription tiers and plans for members.
- **Users**: Admin users and staff accounts.
- **Webhooks**: Automated event notifications to external services.

## Available Tools

This MCP server exposes a comprehensive set of tools for managing your Ghost CMS via the Model Context Protocol. Each resource provides a set of operations, typically including browsing, reading, creating, editing, and deleting entities. Below is a summary of the available tools:

### Posts
- **Browse Posts**: List posts with optional filters, pagination, and ordering.
- **Read Post**: Retrieve a post by ID or slug.
- **Add Post**: Create a new post with title, content, and status.
- **Edit Post**: Update an existing post by ID.
- **Delete Post**: Remove a post by ID.

### Members
- **Browse Members**: List members with filters and pagination.
- **Read Member**: Retrieve a member by ID or email.
- **Add Member**: Create a new member.
- **Edit Member**: Update member details.
- **Delete Member**: Remove a member.

### Newsletters
- **Browse Newsletters**: List newsletters.
- **Read Newsletter**: Retrieve a newsletter by ID.
- **Add Newsletter**: Create a new newsletter.
- **Edit Newsletter**: Update newsletter details.
- **Delete Newsletter**: Remove a newsletter.

### Offers
- **Browse Offers**: List offers.
- **Read Offer**: Retrieve an offer by ID.
- **Add Offer**: Create a new offer.
- **Edit Offer**: Update offer details.
- **Delete Offer**: Remove an offer.

### Invites
- **Browse Invites**: List invites.
- **Add Invite**: Create a new invite.
- **Delete Invite**: Remove an invite.

### Roles
- **Browse Roles**: List roles.
- **Read Role**: Retrieve a role by ID.

### Tags
- **Browse Tags**: List tags.
- **Read Tag**: Retrieve a tag by ID or slug.
- **Add Tag**: Create a new tag.
- **Edit Tag**: Update tag details.
- **Delete Tag**: Remove a tag.

### Tiers
- **Browse Tiers**: List tiers.
- **Read Tier**: Retrieve a tier by ID.
- **Add Tier**: Create a new tier.
- **Edit Tier**: Update tier details.
- **Delete Tier**: Remove a tier.

### Users
- **Browse Users**: List users.
- **Read User**: Retrieve a user by ID or slug.
- **Edit User**: Update user details.
- **Delete User**: Remove a user.

### Webhooks
- **Browse Webhooks**: List webhooks.
- **Add Webhook**: Create a new webhook.
- **Delete Webhook**: Remove a webhook.

### Editorial Workflow (safe editing)

Editing a live post directly from an LLM is risky, so destructive operations are wrapped in a review-first workflow:

- **posts_propose_edit**: Stage an edit without touching the live post. Returns a human-readable diff of the rendered content plus a `proposal_id`.
- **posts_apply_edit**: Apply a staged proposal. Asks the user for approval via MCP elicitation when the client supports it; otherwise requires an explicit `confirm: true`. Detects when the post changed since the proposal was created. Snapshots the prior state first.
- **posts_list_proposals / posts_discard_proposal**: Manage staged proposals.
- **posts_schedule**: Schedule a draft to publish at a future time.
- **posts_list_snapshots / posts_rollback**: Every destructive operation (including plain `posts_edit` and `posts_delete`) stores a local snapshot first. Rollback restores the snapshotted state — and recreates the post if it was deleted.

Snapshots and proposals are stored locally in `~/.ghost-mcp/` (override with the `GHOST_MCP_DATA_DIR` environment variable).

### Content Intelligence

The server builds a local full-text index of your entire corpus (BM25 + TF-IDF cosine similarity, refreshed every 10 minutes):

- **content_search**: Rank all posts against a natural-language query — full text, not just titles.
- **suggest_internal_links**: Given a draft (or an existing post), suggests published posts to link to with anchor-text hints.
- **find_overlapping_posts**: Detect near-duplicate posts that may cannibalize each other in search.
- **content_gaps**: Cluster the corpus into topics and highlight thin, one-post topics and single-use tags.
- **content_reindex**: Force an index rebuild.

### Analytics & Reporting (read-only)

- **analytics_summary**: Total/paid/free members, growth over a window, and MRR trend.
- **email_performance**: Delivery and open rates for recent newsletter sends.
- **top_posts**: Recent posts ranked by newsletter engagement.
- **member_activity**: Recent signups/payments from the member activity feed, with signup attribution when available.
- **site_weekly_report**: One call that summarizes publishing, member growth, MRR change, and newsletter sends for the last 7 days.

Stats endpoints vary between Ghost versions; each tool degrades gracefully when an endpoint is unavailable.

### Live Activity Feed

The `activity://feed` resource summarizes recent posts and new members. Clients that support MCP resource subscriptions can subscribe to it: while subscribed, the server polls Ghost once a minute and pushes `notifications/resources/updated` when a new post or member appears.

### Images

- **images_upload**: Upload an image from a local file path or a remote URL; returns the hosted URL to use as `feature_image` or inside post HTML.

> Each tool is accessible via the MCP protocol and can be invoked from compatible clients. For detailed parameter schemas and usage, see the source code in `src/tools/`.


## Error Handling

Ghost MCP Server employs a custom `GhostError` exception to handle API communication errors and processing issues. This ensures clear and descriptive error messages to assist with troubleshooting.

## Contributing

1. Fork repository
2. Create feature branch
3. Commit changes
4. Create pull request

## License

MIT