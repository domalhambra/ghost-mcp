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

> 📖 **New here?** See [`FEATURES.md`](./FEATURES.md) for a full feature & usage guide — a workflow-oriented walkthrough from publishing your first post to site-wide insights, with a complete tool reference.

## Features

- Secure Ghost Admin API requests with `@tryghost/admin-api`
- Comprehensive entity access including posts, users, members, tiers, offers, and newsletters
- Advanced search functionality with both fuzzy and exact matching options
- Detailed, human-readable output for Ghost entities
- Robust error handling using custom `GhostError` exceptions
- Integrated logging support via MCP context for enhanced troubleshooting
- **Safe editorial workflow**: propose → diff → approve → publish, with snapshot-backed rollback and scheduling
- **Site change plans**: batch operations across posts, tags, members, tiers, offers, and newsletters into one plan with a single rollup diff, one approval, sequential apply with automatic best-effort compensation on failure, and one-command rollback. Irreversible operations (email sends, Stripe-touching edits, member deletes) are flagged and require explicit per-operation acknowledgment.
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

The `GHOST_ADMIN_API_KEY` comes from **Ghost Admin → Settings → Integrations → Add custom integration**. It is read only from the environment at runtime and is never stored in this repository. `GHOST_API_VERSION` is optional and defaults to a current v5 API.

## How to use it

Once the server is connected, you drive it in plain language from your MCP client — you don't call tools by name yourself; the assistant selects them. The overall process follows a few recommended paths depending on what you're doing:

1. **Reading and reporting** — Ask questions and the assistant uses the read-only tools (`*_browse`, `*_read`, the analytics tools, `content_search`) to answer. Nothing is modified. Good starting points: *"How many paid members do I have?"*, *"What have I written about onboarding?"*, *"Give me this week's site report."*

2. **Creating content** — For new posts, the assistant uses `posts_add` (drafts by default), `images_upload` for media, and `posts_schedule` or a status change to publish. New tags, members, tiers, offers, and newsletters have their own `*_add` tools.

3. **Changing existing content safely (single item)** — Rather than editing a live post blind, the recommended path is **propose → review → approve → (optionally) rollback**: `posts_propose_edit` stages the change and returns a diff, you review it, `posts_apply_edit` applies it after your approval, and `posts_rollback` undoes it from the automatic snapshot if needed. Every destructive operation snapshots first.

4. **Changing many things at once (batch)** — When a request spans multiple posts/tags/entities, use a **site change plan**: `plans_create` → one `plans_add_op` per change → `plans_diff` to review the whole batch → `plans_apply` to run it with one approval (and automatic best-effort rollback if any step fails) → `plans_rollback` to undo it later. See [Site Change Plans](#site-change-plans-transactional-batch-editing) below.

5. **Approvals** — Any operation that writes to your site asks for confirmation. If your MCP client supports *elicitation*, you approve or decline in the client itself; if it doesn't, the tool refuses until you re-run it with `confirm: true` (and, for irreversible plan operations, an explicit acknowledgment). This means an assistant can never quietly change your live site.

For a workflow-oriented walkthrough with concrete example prompts, see [`FEATURES.md`](./FEATURES.md).

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

### Site Change Plans (transactional batch editing)

The editorial workflow above protects a *single* post. **Site change plans** extend the same propose → review → approve → rollback model to a whole batch of changes spanning multiple entity types (posts, tags, members, tiers, offers, newsletters), reviewed as one diff, approved once, and undone as a unit. This is the tool to reach for when a request touches many things at once — e.g. *"merge two tags, retag the affected posts, and fix the newsletter sender name"* — where running a dozen individual API calls would leave the site half-migrated if one fails.

The flow is always the same: **create** an empty plan → **add operations** to it (nothing touches the live site yet) → review the **diff** → **apply** (with confirmation) → optionally **rollback**.

- **plans_create**: Open a new, empty plan. Takes a `name` (e.g. `"merge tutorial tags"`) and an optional `intent` describing why. Returns a `plan_id` used by every other plan tool. The plan starts in the `open` state; nothing is written to Ghost until you apply it.
- **plans_add_op**: Stage one operation into an open plan and return an immediate per-operation diff — the live site is untouched. Takes the `plan_id`, an operation `kind`, and a `params` object whose shape depends on the kind:
  - **Reversible operations** (full rollback supported): `post.edit`, `post.retag`, `post.schedule` — `{id, changes:{title|html|lexical|status|published_at|custom_excerpt|featured|tags}}`; `post.delete` — `{id}`; `tag.add` — `{name, slug?, description?}`; `tag.edit` — `{id, changes}`; `tag.delete` — `{id}` (captures every affected post so associations can be restored); `tag.merge` — `{from_id|from_slug, into_id|into_slug}` (retags all affected posts, then deletes the source tag); `newsletter.edit` and `member.edit` — `{id, changes}`.
  - **Irreversible operations** (flagged, require acknowledgment, never auto-undone): `post.publish` — `{id, published_at?, newsletter_slug?, email_segment?}` (an email send cannot be recalled); `member.delete` — `{id}` (destroys Stripe linkage and history); `tier.edit` and `offer.edit` — `{id, changes}` (price changes mint new Stripe prices).
- **plans_diff**: Show the full rollup diff of a plan — every staged operation, its rendered change, and a clear flag on each irreversible operation, plus a summary count of reversible vs. irreversible ops. Review this before applying.
- **plans_apply**: Apply an open plan. First **preflights every operation** against the live site using Ghost's `updated_at` optimistic lock; if anything changed since it was staged, the whole plan aborts **before any write**. Then it applies operations sequentially. If a step fails mid-plan, already-applied reversible operations are **automatically compensated in reverse order** (best-effort — Ghost has no true transactions, so a compensating write can itself fail and is reported rather than hidden). Asks for approval via MCP elicitation when the client supports it; otherwise requires `confirm: true`. Irreversible operations must have their operation IDs passed in `acknowledge_irreversible: [...]` or the apply refuses to run.
- **plans_rollback**: Undo a fully applied plan. Reverts its reversible operations in reverse order from the baselines captured at apply time. Irreversible operations are **skipped and reported**, never silently undone. Note that recreated entities (e.g. a rolled-back post or tag delete) come back with a new ID, matching `posts_rollback` behavior.
- **plans_list**: List all plans, newest first, with each plan's status (`open` / `applying` / `applied` / `failed` / `rolled_back`), operation count, and how many operations are irreversible.
- **plans_discard**: Delete a plan that has not been applied. Applied plans are kept so `plans_rollback` stays possible; a plan mid-apply cannot be discarded.

Plans are stored locally in `~/.ghost-mcp/` alongside snapshots and proposals (override with `GHOST_MCP_DATA_DIR`).

**Honest limits** (also enforced in the tool output): there are no true transactions, so rollback is best-effort compensation, not atomicity; recreated entities get new IDs; and irreversible operations always stay applied.

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