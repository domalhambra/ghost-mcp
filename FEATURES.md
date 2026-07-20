# Ghost MCP Server — Features & Usage Guide

A [Model Context Protocol](https://modelcontextprotocol.io) server that turns your
Ghost CMS into something you can operate in plain language from any MCP client
(Claude Desktop, Claude Code, and others). It goes well beyond a thin API wrapper:
alongside full CRUD for every Ghost entity, it adds a **safe editing workflow**, a
**semantic content graph** for search and SEO, a **business-intelligence layer**, a
**live activity feed**, and **image uploads**.

This guide walks from the simplest task (publishing a post) through to the most
advanced (site-wide insights and automation). For install/config, see
[`README.md`](./README.md).

---

## Table of contents

1. [What you can do at a glance](#what-you-can-do-at-a-glance)
2. [Setup in 30 seconds](#setup-in-30-seconds)
3. [Publishing & content creation](#1-publishing--content-creation)
4. [Safe editing: propose → diff → approve → rollback](#2-safe-editing-propose--diff--approve--rollback)
   - [Site change plans](#2b-site-change-plans-batch-many-edits-into-one-reviewable-unit)
5. [Media & images](#3-media--images)
6. [Content strategy & SEO](#4-content-strategy--seo)
7. [Audience & membership](#5-audience--membership)
8. [Monetization: tiers & offers](#6-monetization-tiers--offers)
9. [Newsletters & email](#7-newsletters--email)
10. [Insights & reporting](#8-insights--reporting)
11. [Live activity feed](#9-live-activity-feed)
12. [Site administration](#10-site-administration)
13. [Automation with webhooks](#11-automation-with-webhooks)
14. [Resources & prompts](#resources--prompts)
15. [Complete tool reference](#complete-tool-reference)
16. [Where data is stored](#where-data-is-stored)

---

## What you can do at a glance

| Capability | Example ask to your assistant |
|---|---|
| **Publish** | "Draft a post titled *Summer Roadmap* with these three sections and save it as a draft." |
| **Edit safely** | "Propose tightening the intro of my *Summer Roadmap* post and show me the diff before anything goes live." |
| **Schedule** | "Schedule the *Summer Roadmap* post to publish next Tuesday at 9am." |
| **Undo** | "That last edit was wrong — roll the post back to before I changed it." |
| **Upload media** | "Upload this cover image and set it as the post's feature image." |
| **Search your archive** | "What have I already written about onboarding?" |
| **Improve SEO** | "Suggest internal links for this draft, and tell me if it overlaps with anything I've published." |
| **Understand your audience** | "How many paid members do I have, and how fast is that growing?" |
| **Measure email** | "Which of my last 10 newsletters had the best open rate?" |
| **Get the big picture** | "Give me a report of everything that happened on the site this week." |
| **Automate** | "Register a webhook that fires when a post is published." |

---

## Setup in 30 seconds

Point your MCP client at the server and provide three environment variables:

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

Your Admin API key never lives in this repo — it's read from the environment at
runtime. The key comes from **Ghost Admin → Settings → Integrations → Add custom
integration**.

---

## 1. Publishing & content creation

The core loop: create, read, list, and remove posts.

| Tool | What it does |
|---|---|
| `posts_add` | Create a post from a title plus `html` or `lexical` content, with a `status` of `draft`, `published`, or `scheduled`. |
| `posts_browse` | List posts with NQL `filter`, `limit`, `page`, and `order`. |
| `posts_read` | Fetch one post by `id` or `slug`. |
| `posts_edit` | Update a post in place. **Automatically snapshots the prior version first** (see rollback). |
| `posts_delete` | Remove a post. **Also snapshots first**, so a delete is recoverable. |

**Typical flow — "Write and publish a post":**
1. Ask the assistant to draft the content → it calls `posts_add` with `status: "draft"`.
2. Review it (`posts_read`).
3. Publish when ready — either `posts_edit` to flip status to `published`, or `posts_schedule` for later.

> Tip: content can be supplied as HTML (simplest for generated text) or Ghost's
> native Lexical format. When you pass HTML, the server tells Ghost to render it correctly.

---

## 2. Safe editing: propose → diff → approve → rollback

Letting an assistant edit a *live, revenue-generating* blog is the scary part.
This server makes destructive changes reviewable and reversible.

| Tool | What it does |
|---|---|
| `posts_propose_edit` | Stage an edit **without touching the live post**. Returns a human-readable diff of the rendered content and a `proposal_id`. |
| `posts_list_proposals` | Show all staged, not-yet-applied proposals. |
| `posts_discard_proposal` | Throw away a proposal. |
| `posts_apply_edit` | Apply a proposal to the live post — **after your approval**. |
| `posts_schedule` | Set a draft to auto-publish at a future ISO timestamp. |
| `posts_list_snapshots` | List local snapshots taken before destructive operations (newest first). |
| `posts_rollback` | Restore a post to a snapshot. If the post was deleted, it's **recreated**. |

**How approval works.** When your MCP client supports *elicitation*, `posts_apply_edit`
pops a confirmation prompt in the client itself — you approve or decline in the
protocol, not on trust that the assistant asked nicely. If the client doesn't support
elicitation, the tool refuses to proceed until you re-run it with `confirm: true`.

**Safety extras baked in:**
- **Drift detection** — if the post changed between proposing and applying, the apply is
  blocked (override with `force: true`) so you never clobber a concurrent edit.
- **Snapshot-before-write** — every `posts_edit`, `posts_delete`, and applied proposal
  stores the previous state locally first. `posts_rollback` is your undo button.

**Typical flow — "Tighten this intro, but let me see it first":**
1. `posts_propose_edit` → assistant shows you a red/green diff, live post untouched.
2. You read it, then approve → `posts_apply_edit`.
3. Changed your mind after the fact → `posts_rollback` restores the snapshot.

---

## 2b. Site change plans: batch many edits into one reviewable unit

The propose → approve → rollback loop above protects a *single* post. **Site change
plans** extend the same safety model to a whole batch of changes spanning different
entity types — posts, tags, members, tiers, offers, and newsletters — reviewed as one
diff, approved once, and undoable as a unit.

The motivating case: *"Merge my `tutorials` and `guides` tags, retag the affected posts,
and fix the newsletter sender name."* That's a dozen-plus individually irreversible API
calls. If call 8 fails, a plain sequence leaves your site half-migrated with no undo. A
plan turns it into: stage everything, review one rollup diff, approve once, and if any
step fails mid-way the already-applied steps are automatically rolled back.

| Tool | What it does |
|---|---|
| `plans_create` | Open a named batch. Nothing touches the site until apply. |
| `plans_add_op` | Stage one operation (post edit/delete/publish/schedule/retag, tag add/edit/delete/merge, member/newsletter edits, member delete, tier/offer edits) into an open plan, with an immediate per-op diff. |
| `plans_diff` | One rollup diff of the whole plan, with **irreversible operations flagged**. |
| `plans_apply` | Preflight every operation against the live site (conflicts abort **before any write**), then apply sequentially. Mid-plan failure triggers **automatic best-effort compensation** of applied reversible ops in reverse order. |
| `plans_rollback` | Revert a fully applied plan's reversible operations from apply-time baselines. Irreversible ops are skipped and reported. |
| `plans_list` / `plans_discard` | Inspect and clean up plans. |

**Reversible vs irreversible.** Content operations (post edits/deletes/retags/scheduling,
tag add/edit/delete/merge, member and newsletter edits) are fully reversible — the plan
captures a baseline of every entity it touches, including the affected-post list for a tag
delete or merge, so rollback restores associations, not just the entity. Some operations
cannot be truly undone and are treated as a distinct class: **publishing with an email send**
(the email can't be recalled), **member deletes** (Stripe linkage and history are destroyed),
and **tier/offer edits** (price changes mint new Stripe prices). These are allowed in a plan
but flagged in the diff and require you to pass their operation IDs in `acknowledge_irreversible`
before `plans_apply` will proceed; they are never silently rolled back.

**Honest limits — worth stating plainly:**
- **No true transactions.** Ghost's Admin API has none, so "apply with automatic rollback"
  is *best-effort compensation*, not atomicity. A compensating write can itself fail; when it
  does, the tool says so and points you at the entity to inspect, rather than hiding it.
- **Recreated entities get new IDs.** Rolling back a deleted post or tag recreates it — with a
  new ID, exactly as `posts_rollback` already does.
- **Irreversible operations stay applied.** They are skipped during rollback and reported, never
  quietly undone.
- **Concurrency.** Preflight uses Ghost's `updated_at` optimistic lock to catch anything a human
  changed in Ghost Admin between staging and applying, and aborts the whole plan before writing.

**Typical flow — "Merge two tags and clean up":**
1. `plans_create` → `plans_add_op` (tag.merge) → `plans_add_op` (newsletter.edit) → …
2. `plans_diff` → review the whole batch, note any `IRREVERSIBLE` flags.
3. `plans_apply` (with `acknowledge_irreversible` for flagged ops) → applied atomically-ish,
   compensated automatically if any step fails.
4. Changed your mind → `plans_rollback` restores the reversible operations.

---

## 3. Media & images

| Tool | What it does |
|---|---|
| `images_upload` | Upload an image to Ghost from a **local file path** or a **remote URL**. Returns the hosted URL to use as a `feature_image` or inside post HTML. |

Before this existed, the server couldn't produce a *complete* post. Now the flow
"generate a cover image elsewhere → upload it → attach it to the post" works end to end.

---

## 4. Content strategy & SEO

The server builds a local, full-text index of your **entire** corpus (BM25 for
query search, TF-IDF cosine similarity for post-to-post comparison). It refreshes
every ~10 minutes and needs no external service or embeddings API.

| Tool | What it does |
|---|---|
| `content_search` | Rank **all** posts against a natural-language query — full text, not just titles. Ground new writing in what you've already said. |
| `suggest_internal_links` | Given a draft (or an existing post's `id`), suggest published posts to link to, **with anchor-text hints**. |
| `find_overlapping_posts` | Detect pairs of posts covering near-identical ground — SEO cannibalization or merge candidates. |
| `content_gaps` | Cluster the corpus into topics; surface thin, one-post topics and single-use tags where coverage is shallow. |
| `content_reindex` | Force an index rebuild now instead of waiting for the refresh. |

**Typical flow — "Make this draft fit my site":**
1. `content_search` — "have I written about this before?"
2. `suggest_internal_links` — wire the draft into existing posts for SEO.
3. `find_overlapping_posts` — make sure you're not competing with your own archive.
4. Zoom out with `content_gaps` to plan what to write next.

---

## 5. Audience & membership

| Tool | What it does |
|---|---|
| `members_browse` | List members with filters and pagination. |
| `members_read` | Fetch a member by `id` or `email`. |
| `members_add` | Create a member. |
| `members_edit` | Update a member's details. |
| `members_delete` | Remove a member. |

Pair these with the analytics tools below to move from "who are my members" to
"how is my membership *performing*."

---

## 6. Monetization: tiers & offers

| Tool | What it does |
|---|---|
| `tiers_browse` / `tiers_read` | List or fetch subscription tiers. |
| `tiers_add` / `tiers_edit` / `tiers_delete` | Manage tiers and their pricing. |
| `offers_browse` / `offers_read` | List or fetch promotional offers. |
| `offers_add` / `offers_edit` / `offers_delete` | Create and manage discounts. |

**Typical flow — "Run a launch promo":** create a discounted `offer` on your paid
`tier`, then track its impact with `member_activity` and `analytics_summary`.

---

## 7. Newsletters & email

| Tool | What it does |
|---|---|
| `newsletters_browse` / `newsletters_read` | List or fetch newsletters. |
| `newsletters_add` / `newsletters_edit` / `newsletters_delete` | Manage newsletters. |

For how sent emails *performed*, see `email_performance` and `top_posts` below.

---

## 8. Insights & reporting

A read-only business-intelligence layer. These reach Ghost's stats, email, and
member-event endpoints (via a signed Admin API helper) and **degrade gracefully**
on Ghost versions that don't expose a given endpoint.

| Tool | What it does |
|---|---|
| `analytics_summary` | Total / paid / free members, member growth over a window, and MRR trend. |
| `email_performance` | Delivery and open rates for recent newsletter sends, newest first. |
| `top_posts` | Recent posts ranked by newsletter engagement (opens per delivery). |
| `member_activity` | Recent member events — signups, payments, opens — with signup **attribution** when available. |
| `site_weekly_report` | **One call** that summarizes publishing, member growth, MRR change, and newsletter sends for the last 7 days. |

**Typical flow — "What happened this week?":** a single `site_weekly_report` gives
you a narratable summary instead of fifteen separate lookups. Drill in with
`analytics_summary` (growth/MRR), `email_performance` (which sends landed), and
`top_posts` (what drove engagement).

---

## 9. Live activity feed

The `activity://feed` resource summarizes recent posts and newest members. Clients
that support **MCP resource subscriptions** can subscribe to it — while subscribed,
the server polls Ghost about once a minute and pushes a `resources/updated`
notification whenever a new post or member appears.

This means an assistant session can react to "you just got a new paid member" or
"a post just went live" **without you asking** — a genuinely push-driven experience
that most MCP servers don't offer.

---

## 10. Site administration

| Tool | What it does |
|---|---|
| `users_browse` / `users_read` | List or fetch staff users. |
| `users_edit` / `users_delete` | Update or remove staff users. |
| `roles_browse` / `roles_read` | Inspect roles and permissions. |
| `invites_browse` / `invites_add` / `invites_delete` | Manage staff invitations. |
| `tags_browse` / `tags_read` | List or fetch tags. |
| `tags_add` / `tags_edit` / `tags_delete` | Organize content with tags. |

---

## 11. Automation with webhooks

| Tool | What it does |
|---|---|
| `webhooks_add` | Register a webhook that fires on a Ghost event (e.g. `post.published`). |
| `webhooks_edit` | Update a webhook's target or event. |
| `webhooks_delete` | Remove a webhook. |

Use these to connect Ghost to external services — notify Slack on publish, trigger a
rebuild of a static front end, sync members to a CRM, and so on.

---

## Resources & prompts

Beyond tools, the server exposes **resources** (addressable, readable objects) and a
starter **prompt**:

**Resources**

| URI | Contents |
|---|---|
| `blog://info` | General site information. |
| `post://{post_id}` | A single post. |
| `member://{member_id}` | A single member. |
| `newsletter://{newsletter_id}` | A single newsletter. |
| `tier://{tier_id}` | A single tier. |
| `offer://{offer_id}` | A single offer. |
| `user://{user_id}` | A single staff user. |
| `activity://feed` | Recent posts + members — **subscribable** (see §9). |

**Prompts**

| Name | What it does |
|---|---|
| `summarize-post` | Given a `postId`, produces a ready-to-run prompt that summarizes that post. |

---

## Complete tool reference

**Posts (CRUD):** `posts_browse` · `posts_read` · `posts_add` · `posts_edit` · `posts_delete`

**Editorial workflow:** `posts_propose_edit` · `posts_list_proposals` · `posts_discard_proposal` · `posts_apply_edit` · `posts_schedule` · `posts_list_snapshots` · `posts_rollback`

**Site change plans:** `plans_create` · `plans_add_op` · `plans_diff` · `plans_apply` · `plans_rollback` · `plans_list` · `plans_discard`

**Content intelligence:** `content_search` · `suggest_internal_links` · `find_overlapping_posts` · `content_gaps` · `content_reindex`

**Analytics (read-only):** `analytics_summary` · `email_performance` · `top_posts` · `member_activity` · `site_weekly_report`

**Media:** `images_upload`

**Members:** `members_browse` · `members_read` · `members_add` · `members_edit` · `members_delete`

**Newsletters:** `newsletters_browse` · `newsletters_read` · `newsletters_add` · `newsletters_edit` · `newsletters_delete`

**Tiers:** `tiers_browse` · `tiers_read` · `tiers_add` · `tiers_edit` · `tiers_delete`

**Offers:** `offers_browse` · `offers_read` · `offers_add` · `offers_edit` · `offers_delete`

**Tags:** `tags_browse` · `tags_read` · `tags_add` · `tags_edit` · `tags_delete`

**Users:** `users_browse` · `users_read` · `users_edit` · `users_delete`

**Invites:** `invites_browse` · `invites_add` · `invites_delete`

**Roles:** `roles_browse` · `roles_read`

**Webhooks:** `webhooks_add` · `webhooks_edit` · `webhooks_delete`

---

## Where data is stored

Proposals, snapshots, and change plans are kept **locally**, not in Ghost, under `~/.ghost-mcp/`.
Override the location with the `GHOST_MCP_DATA_DIR` environment variable. Nothing
sensitive is committed to the repository — your Admin API key is read only from the
environment at runtime.
