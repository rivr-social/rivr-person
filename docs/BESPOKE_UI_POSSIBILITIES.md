# Bespoke UI Possibilities: Complete Design Map

**Date:** 2026-03-31
**Status:** Vision / Architecture Document
**Scope:** All Rivr instance types, federation surfaces, and AI-powered generation patterns

This document maps every entity, relationship, and capability in the Rivr data ontology to the concrete UI surfaces it can power. It is grounded in what the schema, engine, and manifests actually support today, and extends forward to what the architecture makes possible.

---

## 1. Data Ontology Summary

### 1.1 Agents Table

The `agents` table is the identity backbone. Every actor in the system is an agent.

**Agent types:** `person`, `organization`, `org`, `project`, `event`, `place`, `system`, `bot`, `domain`, `ring`, `family`, `guild`, `community`

**Key columns and their UI implications:**

| Column(s) | UI Surface It Enables |
|---|---|
| `name`, `description`, `image`, `metadata` (bio, tagline, skills, socialLinks, profilePhotos) | Profile cards, hero sections, about pages, avatar displays, skill tag clouds |
| `type` | Type-specific rendering: person profiles vs. group pages vs. event cards vs. place maps |
| `metadata.geneKeys`, `metadata.humanDesign`, `metadata.westernAstrology`, `metadata.vedicAstrology`, `metadata.ocean`, `metadata.myersBriggs`, `metadata.enneagram` | Persona insights grid, compatibility visualizations, archetype cards |
| `parentId`, `pathIds`, `depth` | Hierarchical org charts, nested group trees, locale containment breadcrumbs |
| `location` (PostGIS geometry) | Map pins, proximity search results, geographic cluster views, AR anchor points |
| `embedding` (384-dim pgvector) | Semantic similarity recommendations, "people like you" discovery, intelligent search |
| `matrixUserId`, `matrixAccessToken` | Chat availability indicators, direct message buttons, room membership status |
| `website`, `xHandle`, `instagram`, `linkedin`, `telegram`, `signalHandle`, `phoneNumber` | Social links bar, contact cards, vCard exports |
| `peermeshHandle`, `peermeshDid`, `peermeshPublicKey` | Federation identity badges, DID verification displays, cross-network profile links |
| `atprotoHandle`, `atprotoDid` | Bluesky integration badges, AT Protocol cross-posting indicators |
| `parentAgentId` (persona parent) | Persona switcher UI, persona management panel (max 10 per account) |
| `visibility` (`public`, `locale`, `members`, `private`, `hidden`) | Access control indicators, privacy level selectors, gated content sections |
| `failedLoginAttempts`, `lockedUntil`, `totpEnabled` | Security dashboard, 2FA setup UI, account lockout status |

### 1.2 Resources Table

Resources are the content layer. Every piece of content, every tradeable asset, every document lives here.

**Resource types:** `document`, `image`, `video`, `audio`, `link`, `note`, `file`, `dataset`, `resource`, `skill`, `project`, `job`, `shift`, `task`, `training`, `place`, `venue`, `booking`, `asset`, `voucher`, `currency`, `thanks_token`, `listing`, `proposal`, `badge`, `post`, `event`, `group`, `permission_policy`, `receipt`

**Key columns and their UI implications:**

| Column(s) | UI Surface |
|---|---|
| `type='post'` + `content`, `metadata` | Post feeds, blog rolls, social timelines, writing pages |
| `type='event'` + `metadata` (startDate, endDate, location) | Event calendars, upcoming/past event lists, RSVP cards, meeting hubs |
| `type='listing'` + `metadata` (price, category) | Marketplace grids, offering cards, storefront pages, saved listings |
| `type='document'` + `content` | Document viewers, wiki pages, transcript displays, meeting notes |
| `type='proposal'` + `metadata` | Governance proposal cards, voting interfaces, deliberation threads |
| `type='badge'` | Achievement displays, skill verification badges, membership credentials |
| `type='receipt'` | Transaction receipt cards, purchase history, payment confirmation views |
| `type='image'`, `type='video'`, `type='audio'` | Gallery grids, media players, podcast/audio players, photo albums |
| `type='job'`, `type='shift'`, `type='task'` | Job boards, shift calendars, task kanban boards, work assignment views |
| `type='booking'` | Booking calendars, reservation management, scheduling interfaces |
| `type='voucher'`, `type='currency'`, `type='thanks_token'` | Wallet token displays, redeemable voucher cards, gratitude ledgers |
| `type='permission_policy'` | Access control editors, role permission matrices, policy audit views |
| `visibility` | Content gating indicators, access level selectors |
| `location` (PostGIS) | Resource map pins, geotagged content overlays |
| `embedding` (384-dim) | Semantic content search, related content recommendations |
| `tags` | Tag clouds, filtered views, category navigation |
| `ownerId` | Authored-by attribution, content ownership indicators |

### 1.3 Ledger Table

The ledger is the immutable action log. Every meaningful interaction between agents and resources is a ledger entry. This is the relational fabric.

**Verb types (50+):**

| Category | Verbs | UI Surfaces |
|---|---|---|
| **CRUD** | `create`, `update`, `delete`, `transfer`, `share`, `view`, `clone`, `merge`, `split` | Activity feeds, audit trails, version history, change logs |
| **Economic** | `transact`, `buy`, `sell`, `trade`, `gift`, `give`, `earn`, `redeem`, `fund`, `pledge` | Transaction ledgers, marketplace receipts, fundraising progress bars, gift acknowledgments |
| **Work** | `work`, `clock_in`, `clock_out`, `produce`, `consume` | Timesheet views, shift logs, productivity dashboards, resource consumption charts |
| **Governance** | `vote`, `propose`, `approve`, `reject` | Proposal voting UIs, governance dashboards, decision history, approval workflows |
| **Structural** | `join`, `manage`, `own`, `locate`, `follow`, `belong`, `assign`, `invite`, `employ`, `contain` | Member directories, org charts, follower counts, group membership lists, role assignments |
| **Lifecycle** | `start`, `complete`, `cancel`, `archive`, `publish` | Project status trackers, content publication status, archive browsers |
| **Spatial/Temporal** | `attend`, `host`, `schedule` | Attendance lists, event host attribution, calendar scheduling |
| **Social** | `endorse`, `mention`, `comment`, `react` | Endorsement counters, @mention notifications, comment threads, reaction displays |
| **Permissions** | `grant`, `revoke`, `rent`, `use`, `leave`, `request`, `refund` | Access grants log, permission audit trail, refund request UIs |

**Concrete query patterns and their UIs:**

- **"Who are the members of group X?"** -- `ledger WHERE verb='join' AND objectId=X AND objectType='agent' AND isActive=true` -- renders a Member Directory
- **"What roles does person Y hold?"** -- `ledger WHERE subjectId=Y AND verb='join' AND objectType='agent' AND isActive=true`, joined with `agents` for group names and `ledger.role` for position titles -- renders the Roles & Affiliations page
- **"What has person Y endorsed?"** -- `ledger WHERE subjectId=Y AND verb='endorse'` -- renders an Endorsements Given section
- **"Who endorsed person Y?"** -- `ledger WHERE objectId=Y AND verb='endorse'` -- renders an Endorsements Received / Social Proof section
- **"What events did Y attend?"** -- `ledger WHERE subjectId=Y AND verb='attend'` -- renders an Event History timeline
- **"Show all governance activity for group X"** -- `ledger WHERE objectId=X AND verb IN ('vote','propose','approve','reject')` -- renders a Governance Activity Feed
- **"Transaction history for wallet Z"** -- `walletTransactions WHERE fromWalletId=Z OR toWalletId=Z` cross-referenced with `ledger` -- renders a Transaction Ledger

### 1.4 Wallets + Transactions

**Tables:** `wallets`, `walletTransactions`, `capitalEntries`

**Wallet types:** `personal`, `group`

**Transaction types:** `stripe_deposit`, `p2p_transfer`, `marketplace_purchase`, `marketplace_payout`, `event_ticket`, `service_fee`, `group_deposit`, `group_withdrawal`, `group_transfer`, `refund`, `thanks`, `eth_record`, `connect_payout`

**UI surfaces:**

| Data Source | UI |
|---|---|
| `wallets.balanceCents` | Balance display cards, wallet overview |
| `wallets.ethAddress` | ETH address display, MetaMask connect button, on-chain transaction links |
| `walletTransactions` grouped by type | Transaction history with category filters (purchases, transfers, fees, thanks) |
| `walletTransactions` aggregated over time | Spending/earning charts, cash flow graphs, budget tracking |
| `capitalEntries` with `settlementStatus` | Pending settlement indicators, available balance vs. total balance |
| `walletTransactions` where `type='thanks'` | Gratitude ledger, thanks received/given feed |
| `walletTransactions` where `type='event_ticket'` | Ticket purchase history, event access passes |
| Group wallet (`type='group'`) + transactions | Group treasury dashboard, budget allocation views, spending by category |

### 1.5 Federation Tables

**Tables:** `nodes`, `nodePeers`, `nodeMemberships`, `federationEvents`, `federationEntityMap`, `federationAuditLog`

**Node roles:** `group`, `locale`, `basin`, `global`
**Instance types:** `global`, `person`, `group`, `locale`, `region`
**Peer trust states:** `pending`, `trusted`, `blocked`

| Data Source | UI Surface |
|---|---|
| `nodes` with `instanceType`, `baseUrl`, `displayName` | Instance directory, federation network map, instance admin dashboard |
| `nodePeers` with `trustState` | Peer trust management UI, federation health indicators, peering request inbox |
| `nodeMemberships` with `scope`, `role`, `status` | Cross-instance membership views, scope-aware member directories |
| `federationEvents` with `status`, `eventType` | Federation sync log, event import/export status, replication dashboard |
| `federationEntityMap` | Cross-instance entity resolution views, duplicate detection |
| `federationAuditLog` | Federation audit trail, security event log, peer activity monitor |
| `nodes.capabilities` | Instance capability matrix, feature availability indicators |
| `nodes.healthCheckUrl` + `lastHealthCheck` | Instance health dashboard, uptime monitors |
| `nodes.eventSequence` | Sync progress bars, replication lag indicators |

### 1.6 Personas

**Backed by:** `agents.parentAgentId` (persona -> parent account), cookie-based switching via `rivr-active-persona`

| Capability | UI Surface |
|---|---|
| Up to 10 personas per account | Persona manager panel with create/switch/delete |
| Cookie-based active persona | Persona switcher dropdown in nav, active persona indicator |
| Persona-specific content authoring | "Post as..." selector, persona attribution on content |
| Persona-scoped MCP operations | Autobot activity log filtered by persona |
| `getOperatingAgentId()` resolution | Transparent persona context in all write operations |

### 1.7 Contract Rules (WHEN/THEN Automation)

**Table:** `contractRules`
**Shape:** WHEN [determiner] [subject] [verb] [determiner] [object] THEN [action chain] IF [condition]
**Determiners:** `any`, `my`, `the`, `that`, `a`, `all`
**Max chain depth:** 5 (loop prevention)

| Capability | UI Surface |
|---|---|
| Rule definition (trigger + condition + actions) | Visual rule builder with subject/verb/object pickers and determiner selectors |
| Fire count + max fires | Rule execution counter, auto-disable indicators |
| Enabled/disabled toggle | Rule activation switches in a rules dashboard |
| Action chains (multiple actions per rule) | Chained action visualizer, THEN-chain editor |
| Scope binding (`scopeId`) | Group-scoped rule management, per-group automation dashboards |
| Determiner resolution (any/my/the/that) | Natural-language rule preview ("WHEN any member joins my group, THEN assign the onboarding task") |

### 1.8 Subscriptions

**Table:** `subscriptions`
**Tiers:** `basic`, `host`, `seller`, `organizer`, `steward`
**Statuses:** `active`, `past_due`, `canceled`, `incomplete`, `incomplete_expired`, `trialing`, `unpaid`, `paused`

| Data | UI |
|---|---|
| Current tier + status | Membership badge, tier indicator on profile |
| `currentPeriodEnd` | Renewal date display, days-remaining countdown |
| `cancelAtPeriodEnd` | Cancellation warning, reactivation prompt |
| Stripe integration fields | Billing management portal link, payment method display |

---

## 2. Instance-Type Specific UIs

### 2.1 Person Instance (rivr-person -> camalot.me)

The person instance serves a single human identity. Its `PRIMARY_AGENT_ID` points to one `agents` row of `type='person'`.

#### Currently Built (8 person pages, 6 group pages)

The site generator (`site-generator.ts`) today produces:

**Person pages:**
1. **Home (index.html)** -- Hero section with avatar, name, tagline, location, bio excerpt, skills tags, and a "Selected Focus" grid pulling from top groups + marketplace listings
2. **About (about.html)** -- Full bio, skills, location, persona insights grid (Gene Keys, Human Design, Western/Vedic Astrology, OCEAN, Myers-Briggs, Enneagram), social links
3. **Roles (roles.html)** -- Groups the person belongs to, pulled from `bundle.groups` (which queries `ledger WHERE verb='join' AND subjectId=personId AND objectType='agent'`), showing group name, role title, and description
4. **Offerings (offerings.html)** -- Marketplace listings owned by or associated with this person, with title, description, price, category
5. **Writing (writing.html)** -- Posts feed from `bundle.posts`, showing title, content preview, date, group attribution
6. **Events (events.html)** -- Split into Upcoming and Past, with date blocks, titles, locations, group names
7. **Connections (connections.html)** -- Grid of connected people with avatars, names, relationship context
8. **Contact (contact.html)** -- Email, location, social links, contact form placeholder

**Group pages (when `instanceType='group'`):**
1. **Home** -- Group hero with avatar, name, bio
2. **Members** -- Member grid from connections
3. **Events** -- Shared with person events renderer
4. **Docs** -- Document-type posts filtered by `type='document'`
5. **Offerings** -- Shared marketplace renderer
6. **Contact** -- Shared contact renderer

#### New Person Instance UIs to Build

**A. Portfolio / CV Site**

Data sources:
- `agents.metadata.skills` for skills section
- `ledger WHERE subjectId=personId AND verb='join'` cross-referenced with `agents` for work history (organization names, role titles, date ranges from `ledger.timestamp`)
- `resources WHERE ownerId=personId AND type IN ('project','document')` for portfolio pieces
- `resources WHERE ownerId=personId AND type='badge'` for certifications/achievements
- `ledger WHERE objectId=personId AND verb='endorse'` for testimonials/endorsements

Sections: Summary, Work Experience (from group memberships with role data), Skills (from metadata.skills), Projects (from project resources), Education (from group memberships with education-flagged groups), Certifications (from badge resources), References (from endorsement ledger entries).

Export formats: PDF, vCard, JSON-LD (schema.org/Person).

**B. Digital Business Card / vCard**

A single-page, mobile-optimized card pulling:
- `agents.name`, `agents.image` for identity
- `agents.metadata.tagline` for title/role
- `agents.email`, `agents.phoneNumber` for contact
- `agents.website`, `agents.xHandle`, `agents.instagram`, `agents.linkedin`, `agents.telegram`, `agents.signalHandle` for social
- `agents.peermeshHandle` for decentralized identity
- `wallets.ethAddress` for crypto payments
- QR code generation from the above data

**C. Personal Blog**

Data sources:
- `resources WHERE ownerId=personId AND type='post'` ordered by `createdAt DESC`
- `resources.metadata` for post type (article, note, essay), featured image, tags
- `ledger WHERE verb='react' AND objectId=postId` for reaction counts per post
- `ledger WHERE verb='comment' AND objectId=postId` for comment counts

Pages: Blog index (paginated), individual post pages (with content, reactions, comments), tag archive pages, RSS feed.

**D. Freelancer / Consultant Landing Page**

Data sources:
- `resources WHERE ownerId=personId AND type='listing'` for service offerings
- `agents.metadata` for bio, tagline, skills
- `ledger WHERE objectId=personId AND verb='endorse'` for testimonials
- `walletTransactions WHERE type='marketplace_purchase'` count for "X projects completed"
- `resources WHERE type='project' AND ownerId=personId` for case studies

Sections: Hero (tagline + CTA), Services (from listings), Testimonials (from endorsements), Case Studies (from projects), Contact/Book (calendar integration placeholder).

**E. Artist / Creator Portfolio**

Data sources:
- `resources WHERE ownerId=personId AND type IN ('image','video','audio')` for gallery
- `resources.metadata` for titles, descriptions, dimensions, medium
- `resources WHERE type='listing' AND ownerId=personId` for pieces available for purchase
- Posts filtered to art/creative content for artist statement / process blog

Sections: Gallery grid (masonry layout), individual piece lightbox, artist statement (from bio), available works (from listings), exhibitions (from events), press/writing.

**F. Personal Dashboard (private, auth='self')**

This is the authenticated owner's command center. Data from the full `MyProfileModuleBundle`:
- `wallet.balanceCents` -- balance display
- `walletTransactions` -- recent transaction feed
- `ticketPurchases` -- upcoming event tickets
- `subscriptions` -- membership tier status
- `receipts` -- purchase receipts
- `savedListingIds` cross-referenced with listings -- saved items
- `reactionCounts` -- engagement metrics
- `connections` -- recent connection activity
- Persona manager (from `agents WHERE parentAgentId=ownerId`)
- Contract rules dashboard (from `contractRules WHERE ownerId=personId`)
- Federation status (home instance info, projection status)

**G. Autobot Command Center**

Data sources:
- MCP provenance log (via `rivr.audit.recent` tool) for recent autobot activity
- Active persona context (`rivr.personas.list` tool output)
- Contract rules that the autobot operates under
- Federation context (`rivr.instance.get_context`)

Sections: Autobot status indicator, recent activity log (filterable by tool, actor type, status), persona switcher, active rules list, MCP endpoint health, voice session controls (future), AR asset manager (future).

**H. Personal Knowledge Graph Visualization**

Data sources:
- `agents` connected to this person via ledger (groups, events, places, projects)
- `resources` owned by this person (posts, documents, listings)
- `ledger` entries for relationship edges (join, endorse, attend, follow, manage)

Renderer: D3 force-directed graph (extending existing `AgentGraph` component). Person at center, radiating connections color-coded by type (group=green, event=orange, person=blue, offering=yellow, post=gray). Edge labels show verb (member of, attended, endorsed by). Click to navigate.

### 2.2 Group Instance (rivr-group -> boulderfoodcoop.org)

The group instance serves a collective identity. Its `PRIMARY_AGENT_ID` points to an `agents` row of `type` in (`organization`, `org`, `ring`, `family`, `guild`, `community`).

#### Currently Built (6 group pages)

Home, Members, Events, Docs, Offerings, Contact (described above in 2.1).

#### New Group Instance UIs to Build

**A. Organization Website (enhanced)**

Extending the current 6-page generator with:
- **About page** -- mission statement (from `agents.description`), founding story (from a pinned document resource), leadership team (from `ledger WHERE verb='manage' AND objectId=groupId`)
- **News/Updates page** -- posts scoped to this group (`resources WHERE type='post' AND metadata.groupId=groupId`)
- **Gallery page** -- images/videos posted to the group

**B. Member Directory**

Data sources:
- `ledger WHERE verb='join' AND objectId=groupId AND isActive=true` for active members
- Joined with `agents` for member profiles (name, image, metadata.skills, metadata.location)
- `ledger.role` for member roles (admin, member, moderator, viewer)
- `agents.location` for member map view

Views: Grid view (cards), list view (table), map view (PostGIS pins), filtered by role, searchable by name/skill (pgvector semantic search).

**C. Event Calendar Site**

Data sources:
- `resources WHERE type='event' AND ownerId=groupId` (or via ledger `host` verb)
- `resources.metadata` for startDate, endDate, location, RSVP count
- `ledger WHERE verb='attend' AND objectId=eventId` for attendee count/list
- `resources WHERE type='document' AND metadata.linkedEventId=eventId` for meeting transcripts

Views: Monthly calendar grid, week view, list view, individual event detail page (with RSVP button, attendee list, linked transcript, location map).

**D. Group Wiki / Docs Site**

Data sources:
- `resources WHERE type='document' AND ownerId=groupId` for documents
- `resources.tags` for categorization
- `resources.metadata` for document hierarchy/ordering
- `ledger WHERE verb='create' AND resourceId=docId` for authorship
- `ledger WHERE verb='update' AND resourceId=docId` for edit history

Features: Searchable document index, tag-based navigation, document viewer with edit history sidebar, linked transcript viewer for meeting documents.

**E. Marketplace / Storefront**

Data sources:
- `resources WHERE type='listing' AND ownerId=groupId` for group-owned listings
- Plus listings from members: `resources WHERE type='listing' AND ownerId IN (SELECT subjectId FROM ledger WHERE verb='join' AND objectId=groupId AND isActive=true)`
- `resources.metadata` for price, category, images, availability
- `walletTransactions WHERE type='marketplace_purchase' AND referenceId=listingId` for sales count
- Group wallet for treasury view

Pages: Product/service grid with category filters, individual listing detail pages (description, price, images, seller profile link, purchase button), cart/checkout flow (Stripe integration), seller dashboard.

**F. Community Bulletin Board**

Data sources:
- `resources WHERE type='post' AND metadata.groupId=groupId` for all group posts
- `resources.metadata.postType` for categorization (announcement, discussion, question, event, listing)
- `ledger WHERE verb='react' AND objectId=postId` for reactions
- `ledger WHERE verb='comment' AND objectId=postId` for comments

Views: Threaded discussion format, category tabs (Announcements, Discussion, Questions, Classifieds), pinned posts, new post composer.

**G. Governance Dashboard**

Data sources:
- `resources WHERE type='proposal' AND ownerId=groupId` for proposals
- `ledger WHERE verb='vote' AND objectId=proposalId` for votes, with `metadata` containing vote choice
- `ledger WHERE verb='propose' AND objectId=groupId` for proposal submissions
- `ledger WHERE verb='approve' OR verb='reject'` for outcomes
- Group wallet for budget proposals
- `contractRules WHERE scopeId=groupId` for active governance automation

Sections: Active proposals with vote progress bars, proposal detail pages (description, votes cast, outcome), proposal submission form, governance history timeline, budget allocation view (from wallet transactions tagged as governance), active contract rules.

**H. Project Management View**

Data sources:
- `resources WHERE type IN ('project','task','job','shift') AND ownerId=groupId`
- `ledger WHERE verb='assign' AND objectId=taskId` for task assignments
- `ledger WHERE verb IN ('start','complete','cancel') AND objectId=taskId` for status tracking
- `ledger WHERE verb='work' AND objectId=taskId` for work logs
- `ledger WHERE verb='clock_in' OR verb='clock_out'` for time tracking

Views: Kanban board (columns: todo, in-progress, done, derived from lifecycle verbs), Gantt chart (from start/complete timestamps), task detail (assignees, work log, status history), team workload view (tasks per member).

**I. Meeting Hub**

Data sources:
- `resources WHERE type='event' AND ownerId=groupId AND metadata.isLiveInvitation=true` for meetings
- `resources WHERE type='document' AND metadata.linkedEventId=eventId` for transcripts
- `ledger WHERE verb='attend' AND objectId=eventId` for attendees
- Transcript segments (from `appendEventTranscriptAction`) with speaker labels

Pages: Meeting list (upcoming + past), individual meeting page (agenda, attendees, live transcript viewer, recording playback), meeting search (full-text across transcripts via pgvector embeddings).

**J. Group Treasury / Economics Dashboard**

Data sources:
- `wallets WHERE ownerId=groupId AND type='group'` for group wallet balance
- `walletTransactions` involving the group wallet for transaction history
- `capitalEntries WHERE walletId=groupWalletId` for settlement tracking
- `walletTransactions` aggregated by `type` and time period for category breakdowns
- `ledger WHERE verb='fund' OR verb='pledge'` for fundraising tracking

Views: Balance overview card, income vs. expenses chart (line/bar), transaction ledger with filters, category breakdown pie chart, pending settlements list, fundraising progress tracker, budget vs. actual comparison.

### 2.3 Locale Instance (rivr-locale-commons)

The locale instance serves a geographic community. It aggregates data from groups, people, and events within a spatial boundary.

**Data foundations:**
- `agents.pathIds` -- hierarchical locale containment (city > neighborhood > block)
- `agents.location` -- PostGIS point geometry for all agents
- `nodes WHERE instanceType='locale'` -- locale node identity
- `nodeMemberships WHERE scope='locale'` -- locale membership roster

#### Locale UIs

**A. Community Portal**

Data sources:
- All agents where `pathIds` contains the locale's agent ID
- Groups, events, people within the locale boundary
- Recent posts scoped to locale

Sections: Welcome hero (locale name, description, member count), featured groups carousel, upcoming events list, recent community posts, local statistics (member count, group count, event count).

**B. Local Event Aggregator**

Data sources:
- `resources WHERE type='event'` owned by groups within the locale
- `resources.location` for event map pins
- `resources.metadata` for dates, categories, RSVP status

Views: Calendar view (all local events), map view (event pins with popups), list view with date/group filters, featured events section.

**C. Local Business / Group Directory**

Data sources:
- `agents WHERE type IN ('organization','org','guild','community') AND pathIds @> ARRAY[localeId]`
- `agents.metadata` for business category, hours, contact
- `agents.location` for map placement
- `agents.embedding` for semantic search ("find a carpenter near me")

Views: Alphabetical list, category browse, map view with pins, search with semantic matching, individual group profile cards.

**D. Neighborhood Bulletin Board**

Data sources:
- `resources WHERE type='post' AND metadata.localeId=localeId`
- Posts from groups within the locale
- `resources.metadata.postType` for categorization

Views: Chronological feed, category tabs (For Sale, Events, Wanted, Discussion), post composer scoped to locale.

**E. Local Resource Exchange**

Data sources:
- `resources WHERE type='listing'` from members/groups in locale
- `resources WHERE type IN ('asset','voucher')` for shareable resources
- `ledger WHERE verb IN ('trade','gift','lend')` for exchange history

Views: Available items grid, request board, exchange history, mutual aid tracker.

**F. Community Map**

Data sources:
- `agents.location` for all agents in locale (groups, people, places, events)
- `resources.location` for geotagged resources
- `resources WHERE type='place' OR type='venue'` for points of interest

Renderer: Interactive map (Cesium/Mapbox) with layers toggleable by entity type (groups, events, places, people). Click to view details. Cluster at zoom-out. Heat map for activity density.

### 2.4 Bioregional Instance (rivr-bioregional)

The bioregional instance spans multiple locales within a natural/cultural boundary (territory, bioregion, cultural region).

**Data foundations:**
- `nodes WHERE role='basin'` -- basin/bioregion node
- `nodeMemberships WHERE scope='basin'` -- cross-locale membership
- `agents.pathIds` -- hierarchical containment across locales

#### Bioregional UIs

**A. Territory / Bioregion Dashboard**

Data sources:
- All locale nodes within the bioregion (via `nodeMemberships` or `agents.pathIds`)
- Aggregated statistics: total members, groups, events across locales
- Cross-locale activity feed

Sections: Bioregion map with locale boundaries, statistics overview, locale directory, recent cross-locale activity, seasonal event calendar.

**B. Cross-Locale Coordination View**

Data sources:
- Groups that span multiple locales (via `pathIds` or membership in multiple locale scopes)
- Proposals/votes with bioregional scope
- Shared resources across locales

Views: Multi-locale group directory, shared governance dashboard, inter-locale resource sharing tracker.

**C. Regional Event Calendar**

Aggregated calendar from all locales within the bioregion. Same renderer as locale events but with locale-label grouping and a broader map view.

**D. Bioregional Resource Map**

Data sources:
- All geotagged agents and resources within the bioregion boundary
- `resources WHERE type='asset'` for shared infrastructure
- `agents WHERE type='place'` for significant locations

Renderer: Cesium 3D terrain view with resource pins, territory overlay, locale boundary polygons, elevation-aware asset placement.

**E. Environmental Data + Group Overlay**

Data sources:
- Groups tagged as environmental/ecological (via `agents.metadata.tags` or `resources.tags`)
- Spatial assets with environmental metadata
- Activity within eco-focused groups

Views: Environmental monitoring dashboard, restoration project map, species/habitat overlay (from external data + internal group activity).

---

## 3. Cross-Instance / Federation UIs

### 3.1 Federated Profile Viewer (Projection Rendering)

When a person visits a group instance, the group instance renders a "projection" of that person's profile using data from their home instance.

Data flow:
1. Visitor arrives at `boulderfoodcoop.org/members/alice`
2. Group instance checks `federationEntityMap` for Alice's local entity mapping
3. If mapped, renders local projection; if not, queries Alice's home instance via federation API
4. Renders read-only profile card using the `PublicProfileModuleManifest` with data from the remote instance

UI: Profile card with "home instance" badge (e.g., "Home: camalot.me"), federated identity verification indicator, link to canonical profile, locally-scoped activity (what Alice has done within this group).

### 3.2 Cross-Instance Search / Discovery

Data sources:
- Local `agents.embedding` and `resources.embedding` for semantic search
- Federation peer queries for cross-instance results
- `federationEntityMap` for deduplication

UI: Unified search bar with results grouped by instance origin, relevance-ranked via pgvector cosine similarity, filters by entity type and instance.

### 3.3 Federation Network Graph

Data sources:
- `nodes` table for all known instances
- `nodePeers` for trust relationships between instances
- `federationEvents` aggregated for activity volume per edge
- `nodes.instanceType` for node categorization

Renderer: D3 force-directed graph (similar to `AgentGraph` but at the federation level). Nodes = instances, sized by member count, colored by instance type (person=blue, group=green, locale=amber, region=purple, global=white). Edges = peer trust relationships, thickness proportional to federation event volume. Click to navigate to instance.

### 3.4 Global Activity Stream

Data sources:
- `federationEvents WHERE status='imported'` from all peer instances
- Filtered by `visibility` to respect access controls
- `federationEvents.eventType` for categorization

UI: Real-time feed of cross-instance activity (new groups, events, posts, marketplace listings) with instance-of-origin badges and deep links.

### 3.5 Cross-Instance Marketplace

Data sources:
- Listings from federated instances via `federationEvents WHERE entityType='resource' AND eventType='listing_published'`
- Local listings from `resources WHERE type='listing'`
- Deduplication via `federationEntityMap`

UI: Unified marketplace grid with instance-origin indicators, cross-instance purchase flow (payment routed to seller's home instance wallet), federated review/endorsement display.

---

## 4. Functional UI Patterns (Reusable Across Instance Types)

These are composable UI patterns that can be embedded in any instance type's pages.

### 4.1 Chat Interface (Autobot / AI Assistant)

Backed by: MCP tool definitions (`MCP_TOOL_DEFINITIONS`), AI SDK `useChat` + `streamText`

Available tools the chat can invoke:
- `rivr.instance.get_context` -- understand where the user is
- `rivr.personas.list` -- list/switch personas
- `rivr.profile.get_my_profile` -- read full profile bundle
- `rivr.profile.update_basic` -- update profile fields
- `rivr.posts.create` -- create posts
- `rivr.posts.create_live_invite` -- create meeting invitations
- `rivr.groups.join` -- join/leave groups
- `rivr.events.rsvp` -- RSVP to events
- `rivr.events.append_transcript` -- add transcript segments
- `rivr.audit.recent` -- review autobot activity

UI: Chat panel (slide-out or embedded), message thread with tool-call result cards, persona selector, voice input toggle (future), conversation history.

### 4.2 Voice Interface

Backed by: WhisperX transcription service, OpenClaw voice clone engine (Autobot sidecar)

Pipeline: Record audio -> WhisperX diarized transcription -> NLP parsing -> MCP tool execution

UI: Voice record button, live waveform display, transcript display with speaker labels, voice clone playback controls, voice session history.

### 4.3 AR Overlay (3D Assets on Map)

Backed by: Cesium/Three.js renderer, `resources.location` (PostGIS), `resources WHERE type='asset'` with 3D model metadata

Domain model (from cross-app plan):
- `spatial_asset` -- 3D model resource with lat/lon anchor, height_meters, belongs_to_group
- `ar_scene` -- collection of spatial assets for a view
- Authorization via ledger (grant/revoke on the asset resource)

UI: Map view with 3D asset overlay, AR camera view (mobile), asset placement editor, permission management per asset.

### 4.4 Command Bar (NLP -> Entity Creation)

Backed by: `nlp-parser-v2.ts` with entity types (person, organization, project, event, place, job, asset) and relationship types

Pipeline:
1. User types natural language in command bar: "Create a potluck event for the Boulder Food Co-op next Saturday at the community center"
2. NLP parser extracts: intent=creation, entity=event, name="potluck", existingReferences=[{type: "organization", name: "Boulder Food Co-op"}], properties=[{key: "date", value: next Saturday}, {key: "location", value: "community center"}]
3. Scaffold preview shows parsed entities with edit-before-confirm UI
4. On confirm, entities created via `processSentence` in transaction engine, ledger entries written

UI: Global command bar (Cmd+K), real-time parse preview, entity scaffold preview modal, confirmation step, success feedback with links to created entities.

### 4.5 Graph Visualization (D3 Force-Directed)

Already built: `AgentGraph` component rendering person/group/event/post/offering nodes with colored shapes and labeled edges.

Extensible to: Full knowledge graph explorer, federation network view, locale community map overlay, project dependency graph, governance decision tree.

### 4.6 Calendar View

Data sources: `resources WHERE type='event'` with `metadata.startDate`, `metadata.endDate`

Views: Month grid, week view, day view, agenda list. Filterable by group, event type, RSVP status. Supports multi-group event aggregation for locale/bioregional views.

### 4.7 Notification Center

Backed by:
- Ledger entries for in-app notifications (new endorsement, group invite, event RSVP, etc.)
- TextBee SMS gateway for outbound SMS
- Email log (`emailLog` table) for email notifications
- Matrix for real-time messaging notifications

UI: Bell icon with unread count, notification dropdown with categorized items (social, events, governance, economic), notification preferences editor, SMS/email delivery status indicators.

### 4.8 Wallet / Treasury Dashboard

(Detailed in section 1.4 above.) Reusable across person dashboards and group treasury views. Supports both personal and group wallet types with appropriate transaction filtering.

### 4.9 Document Editor

Data sources: `resources WHERE type='document'`, with `content` field for document body

Features: Markdown/rich text editor, transcript-linked view (for meeting documents), version history (from ledger `update` entries), collaborative editing indicator (via Matrix or websocket), resource attachment (link other resources to document).

### 4.10 Meeting Room

Combines: Event detail (RSVP, attendees) + live transcript viewer + document editor + voice controls

Data flow:
1. Live invite post creates event + transcript document (`rivr.posts.create_live_invite`)
2. Members join, audio recording begins
3. WhisperX transcribes with speaker diarization
4. Transcript segments appended via `rivr.events.append_transcript`
5. Post-meeting: transcript document available for review, linked to event

UI: Meeting header (event title, time, group), attendee sidebar, live transcript panel (auto-scrolling, speaker-labeled), recording controls, linked document viewer, post-meeting summary.

---

## 5. AI-Powered Generation Patterns

### 5.1 Chat-to-Website

Pipeline:
1. User opens AI chat at PM Core root domain (e.g., `camalot.me/builder`)
2. AI reads profile via MCP (`rivr.profile.get_my_profile`)
3. AI reads module manifest to understand available data/sections
4. User describes desired site via conversation: "I want a dark portfolio site with my offerings and recent writing"
5. AI generates `SitePreferences` (preset, visibleSections, customTokens, overrides)
6. `generateSite()` produces static HTML + CSS files
7. Files deployed to MinIO, served by Traefik at root domain

Iteration: User says "make the accent color gold" -> AI updates `customTokens.accent` -> regenerate -> redeploy. User says "hide the persona insights section" -> AI removes from `visibleSections` -> regenerate.

The manifest drives what the AI knows is possible. `BespokeModuleManifest.fields` tells the AI what data exists. `sections` tells it what sections can be shown/hidden. `theme.editableTokens` tells it what can be customized. `mutations` tells it what the user can change.

### 5.2 Profile-to-Resume (Auto-Generate CV)

Data assembly:
- `agents` row for name, contact, skills, bio -> header + summary
- `ledger WHERE verb='join' AND isActive=true` joined with `agents` -> work history entries (organization name from `agents.name`, role from `ledger.role`, start date from `ledger.timestamp`)
- `ledger WHERE verb='join' AND isActive=false` -> past positions
- `resources WHERE type='badge'` -> certifications section
- `resources WHERE type='project'` -> projects section
- `ledger WHERE objectId=personId AND verb='endorse'` joined with `agents` -> references
- `agents.metadata.skills` -> skills section

Output formats: Styled HTML page (via bespoke site generator), PDF export (server-side render), JSON-LD (schema.org/Person), plain text.

### 5.3 Data-to-Dashboard (Auto-Generate Monitoring Views)

Given any collection of data sources from the ontology, AI generates a dashboard layout:

Example: "Show me a dashboard for Boulder Food Co-op"
- AI reads group profile, member count, recent events, wallet balance, active proposals, recent posts
- Generates: Stats row (members, events, balance), activity feed, upcoming events card, treasury chart, active proposals list
- Layout is responsive grid with each card mapped to a manifest section

### 5.4 NLP-to-Entity (Command Bar Semantic Creation)

Already described in section 4.4. The AI enhancement layer:
- Ambiguity resolution: "Schedule a meeting" -> AI asks "Which group?" if user belongs to multiple
- Defaults inference: "Create an event next Tuesday" -> AI fills in default location from group metadata, default duration from similar past events
- Batch creation: "Set up the quarterly planning cycle with 4 monthly check-ins and a final review" -> AI generates 5 events with appropriate dates and relationships

### 5.5 Voice-to-Action

Pipeline: Speak -> WhisperX transcribe -> NLP parse -> MCP tool call -> confirm -> execute

Example: User says "Post to Boulder Food Co-op that the potluck is moved to 6pm"
1. WhisperX: "Post to Boulder Food Co-op that the potluck is moved to 6pm"
2. NLP parse: intent=create, entity=post, group="Boulder Food Co-op", content="the potluck is moved to 6pm"
3. MCP: `rivr.posts.create({ content: "the potluck is moved to 6pm", groupId: resolvedGroupId })`
4. Confirm step (visual or voice confirmation)
5. Execute and return success

### 5.6 Contract-to-Automation (WHEN/THEN Rule Builder)

AI-assisted rule creation:
- User describes automation in natural language: "When someone joins the co-op, send them the welcome document"
- AI parses: trigger=(any agent, joins, my group), action=(share, the welcome document, that agent)
- AI translates to `contractRules` row: `triggerSubjectDeterminer='any'`, `triggerVerb='join'`, `triggerObjectDeterminer='my'`, `triggerObjectId=groupId`, `actions=[{ verb: 'share', objectDeterminer: 'the', objectId: welcomeDocId, targetDeterminer: 'that' }]`
- Visual preview: flowchart showing trigger -> condition check -> action chain
- User confirms, rule is saved and enabled

---

## 6. Theme System

### 6.1 Token-Based Theming

All visual properties are controlled via CSS custom properties (tokens). The `BespokeThemeManifest` declares which tokens are editable:

```
editableTokens: [
  "color.background",    // Page background
  "color.foreground",    // Text color
  "color.primary",       // Primary action/brand color
  "color.accent",        // Secondary highlight color
  "color.border",        // Border color
  "radius.card",         // Card border radius
  "shadow.card",         // Card box shadow
]
```

Additional tokens resolved internally: `primaryForeground`, `mutedForeground`, `surfaceBg`.

### 6.2 Built-In Presets

| Preset | Background | Primary | Accent | Character |
|---|---|---|---|---|
| `default` | `#0a0a0a` (near-black) | `#7c3aed` (violet) | `#a78bfa` (lavender) | Clean, modern, tech-forward |
| `red-gold` | `#0f0808` (dark maroon) | `#dc2626` (red) | `#d4a017` (gold) | Bold, regal, high-contrast |
| `forest-brass` | `#060d06` (dark forest) | `#16a34a` (green) | `#b8860b` (brass) | Natural, earthy, ecological |
| `earth-clay` | `#0d0a08` (dark earth) | `#b45309` (amber) | `#92400e` (clay) | Warm, grounded, artisanal |

### 6.3 Instance-Type Appropriate Defaults

Suggested default presets per instance type:
- **Person:** `default` (neutral starting point, encourages customization)
- **Group (co-op/community):** `forest-brass` (earthy, collective feel)
- **Group (professional/org):** `default` (clean, professional)
- **Locale:** `earth-clay` (place-connected, warm)
- **Bioregional:** `forest-brass` (ecological, natural)

### 6.4 Dark/Light Mode

Current implementation is dark-mode only. Extension path:
- Add a `mode` token (`dark` | `light` | `auto`)
- Define light-mode token inversions for each preset
- Support `prefers-color-scheme` media query for `auto` mode
- Store preference in cookie or agent metadata

### 6.5 Typography Pairs

Current: Inter (body and display).
Extension: Support configurable `font.display` and `font.body` tokens.

Suggested pairs per site archetype:
- **Personal editorial (camalot.me style):** Cormorant Garamond (display) + Manrope (body)
- **Professional/corporate:** Instrument Serif (display) + Inter (body)
- **Community/grassroots:** Fraunces (display) + Source Sans 3 (body)
- **Technical/developer:** JetBrains Mono (display) + Inter (body)
- **Artisan/handmade:** Playfair Display (display) + Lora (body)

---

## 7. Manifest-Driven Architecture

### 7.1 How BespokeModuleManifest Enables Everything

The `BespokeModuleManifest` is the contract between data and UI. It is the reason an AI agent, a human developer, or a code generator can all build interfaces without hardcoding assumptions.

```typescript
interface BespokeModuleManifest {
  moduleId: string;           // Unique identifier (e.g., "rivr.myprofile")
  version: string;            // SemVer for compatibility checking
  title: string;              // Human-readable name
  auth: BespokeAuthGate;      // "public" | "authenticated" | "self"
  dataEndpoint: string;       // Where to fetch the data bundle
  manifestEndpoint: string;   // Where to fetch this manifest
  fields: BespokeFieldManifest[];        // What data exists
  mutations: BespokeMutationManifest[];  // What can be changed
  components: BespokeComponentManifest[]; // What UI pieces are available
  sections: BespokeSectionManifest[];    // What page sections exist
  theme: BespokeThemeManifest;           // What visual tokens exist
}
```

### 7.2 Data Sources: Declared, Not Hardcoded

Every field in the manifest includes a `dataPath` that points into the data bundle. The site generator (or any builder) resolves data by walking the path:

```
field.dataPath = "profile.agent.metadata.skills"
bundle.profile.agent.metadata.skills = ["permaculture", "typescript", "facilitation"]
```

This means:
- A new data source appears -> add a field to the manifest -> every builder can now use it
- No code changes required in the renderer; it reads whatever the manifest declares

### 7.3 Mutations: Gated by Auth Level

Each mutation declares its `auth` gate:
- `"self"` -- only the profile owner can invoke (e.g., `updateProfileAction`)
- `"authenticated"` -- any logged-in user can invoke
- `"public"` -- no auth required

The `kind: "server-action"` field with `importPath` and `exportName` provides the exact function reference. An AI builder can read the manifest and know: "I can offer a bio edit form because mutation `action:updateMyProfile` accepts a `bio` field with auth=self."

### 7.4 Components: Registered as References

Components are declared with import paths, not inlined. This allows:
- Lazy loading (import only what a page needs)
- Swapping (replace `post-feed` component with a custom one)
- AI awareness (the manifest tells AI what visual components exist and what they render)

Current registered components for MyProfile:
`profile-header-card`, `post-feed`, `event-feed`, `profile-group-feed`, `profile-calendar`, `offerings-tab`, `persona-manager`, `user-connections`, `receipt-card`, `eth-address-form`, `metamask-connect-button`

Current registered components for PublicProfile:
`profile-header-card`, `post-feed`, `event-feed`, `profile-group-feed`, `agent-graph`, `thank-module`

### 7.5 Sections: Composable and Hideable

Each section maps a `dataPath` to a `defaultComponentId` and declares whether it is `hideable` and `themeable`. The site generator checks `preferences.visibleSections` to decide what to render.

This enables:
- User customization: "I want to hide the Persona Insights section" -> remove from `visibleSections`
- AI customization: AI reads sections, decides which are relevant, generates appropriate `SitePreferences`
- Per-instance defaults: A professional profile hides `persona-insights` by default; a holistic practitioner shows it

### 7.6 Any Instance Type Can Define Its Own Manifest

Today: `rivr.myprofile` (self, person) and `rivr.public-profile` (public, person).

Extension path:
- `rivr.group-profile` -- manifest for group instance pages (fields: group name, mission, member count; sections: about, members, events, docs, treasury; mutations: update group info, manage members)
- `rivr.locale-portal` -- manifest for locale instances (fields: locale name, boundary, population; sections: map, directory, events, bulletin; mutations: post to locale, register group)
- `rivr.bioregional-dashboard` -- manifest for bioregional instances
- Custom manifests per deployment (a food co-op defines a manifest with sections specific to their operations)

### 7.7 AI Reads Manifests to Understand What Is Buildable

The manifest is the AI's instruction manual. When an autobot reads `GET /api/myprofile/manifest`, it receives:
- What fields exist and their types (string, string[], url, image[], boolean, json)
- What mutations are available and their required/optional parameters
- What sections can be shown/hidden
- What theme tokens can be customized
- What components are available for rendering

This makes the AI-powered bespoke website builder possible without the AI needing to understand the database schema. The manifest is the abstraction layer.

---

## 8. Roadmap Priorities

### Phase 1: Complete Person Instance Bespoke Builder (Weeks 1-3)

**What exists:** Site generator with 8 person pages, 4 theme presets, MyProfile + PublicProfile manifests, MCP tools for profile read/write.

**Build:**
1. AI chat interface at PM Core root domain consuming manifests
2. Enhanced `SitePreferences` with typography pair selection
3. Dark/light mode token support
4. MinIO deployment pipeline (generated site -> static hosting)
5. Personal Dashboard page (private, auth=self) assembling wallet + activity + connections

**Why first:** This is the most immediately visible user-facing feature and validates the entire manifest-driven AI builder pipeline.

### Phase 2: Expand Group Instance Pages (Weeks 3-5)

**What exists:** 6 group pages (home, members, events, docs, offerings, contact).

**Build:**
1. `rivr.group-profile` module manifest
2. Governance dashboard (proposals + votes from ledger)
3. Group treasury view (wallet + transactions)
4. Meeting hub (events + transcripts linking)
5. Enhanced member directory with map view

**Why second:** Groups are the core social unit. Governance and treasury are the strongest differentiators for the platform.

### Phase 3: Cross-Instance Federation UIs (Weeks 5-7)

**What exists:** Federation tables, entity maps, event sync, peer trust states.

**Build:**
1. Federated profile projection renderer
2. Federation network graph visualization
3. Cross-instance search (pgvector semantic across peers)
4. Instance health dashboard

**Why third:** Federation is the architectural differentiator. Making it visible and usable proves the decentralized model works.

### Phase 4: Locale Instance (Weeks 7-9)

**Build:**
1. `rivr.locale-portal` manifest
2. Community portal with aggregated events/groups/posts
3. Community map (Cesium/Mapbox with agent/resource pins)
4. Local business directory with semantic search
5. Neighborhood bulletin board

**Why fourth:** Locale instances demonstrate the geographic community use case, which is a key adoption vector.

### Phase 5: Contract Rules + Command Bar (Weeks 9-10)

**Build:**
1. Visual WHEN/THEN rule builder UI
2. Rule management dashboard
3. NLP command bar integration with `nlp-parser-v2`
4. Entity scaffold preview + confirm workflow

**Why fifth:** Automation and NLP creation are power-user features that increase retention and engagement depth.

### Phase 6: Voice + AR Integration (Weeks 10-12)

**Build:**
1. WhisperX transcription integration (deploy service, wire `WHISPER_TRANSCRIBE_URL`)
2. Voice-to-action pipeline (record -> transcribe -> parse -> execute)
3. Spatial asset model for group-owned 3D objects
4. Cesium 3D terrain view with asset placement
5. AR sidecar alignment

**Why sixth:** Voice and spatial are the most ambitious features. They depend on infrastructure (WhisperX, Cesium assets) that should be deployed after core UIs are solid.

### Phase 7: Bioregional Instance + Advanced Federation (Weeks 12+)

**Build:**
1. `rivr.bioregional-dashboard` manifest
2. Cross-locale coordination views
3. Bioregional resource map with territory overlay
4. Global activity stream from federated events
5. Cross-instance marketplace

**Why last:** Bioregional is the most abstract scale. It requires locale instances to be functioning first, and benefits from all prior federation work.

---

## Appendix A: Complete Entity-to-UI Matrix

| Entity / Table | Primary UI Surfaces | Instance Types |
|---|---|---|
| `agents` (person) | Profile pages, connection cards, member directories, persona manager | All |
| `agents` (organization/org/guild/community) | Group pages, org charts, directory listings | Group, Locale, Bioregional |
| `agents` (event) | Event cards, calendar entries, RSVP interfaces | All |
| `agents` (place) | Map pins, location cards, venue pages | Locale, Bioregional, Group |
| `agents` (project) | Project dashboards, kanban boards, portfolio entries | Person, Group |
| `agents` (bot) | Autobot status cards, AI assistant interfaces | Person |
| `agents` (ring/family) | Intimate group pages, family trees, circle dashboards | Person, Group |
| `resources` (post) | Post feeds, blog rolls, bulletin boards, timelines | All |
| `resources` (event) | Event detail pages, calendar entries, meeting hubs | All |
| `resources` (listing) | Marketplace grids, storefront pages, offering cards | All |
| `resources` (document) | Document viewers, wiki pages, transcript displays | Group, Person |
| `resources` (proposal) | Governance cards, voting interfaces, deliberation threads | Group, Locale |
| `resources` (badge) | Achievement displays, certification cards | Person, Group |
| `resources` (receipt) | Transaction receipts, purchase history | Person |
| `resources` (image/video/audio) | Gallery grids, media players, portfolio pieces | Person, Group |
| `resources` (job/shift/task) | Job boards, shift calendars, task kanban | Group |
| `resources` (booking) | Booking calendars, reservation management | Group |
| `resources` (voucher/currency/thanks_token) | Wallet token displays, gratitude ledger | Person, Group |
| `ledger` | Activity feeds, audit trails, relationship graphs, endorsement counts | All |
| `wallets` + `walletTransactions` | Balance displays, transaction histories, treasury dashboards | Person, Group |
| `capitalEntries` | Settlement tracking, available balance calculations | Person, Group |
| `nodes` + `nodePeers` | Federation maps, instance directories, peer management | All |
| `nodeMemberships` | Cross-instance membership views | All |
| `federationEvents` | Sync logs, replication dashboards | All |
| `contractRules` | Rule builders, automation dashboards | Person, Group |
| `subscriptions` | Tier badges, billing management, feature gating | Person |
| `groupMatrixRooms` | Chat interfaces, messaging status | Group |

## Appendix B: MCP Tool to UI Mapping

| MCP Tool | UI Surfaces It Powers |
|---|---|
| `rivr.instance.get_context` | Instance identity display, federation status badge, autobot context panel |
| `rivr.personas.list` | Persona manager dropdown, persona switcher, active persona indicator |
| `rivr.profile.get_my_profile` | All dashboard sections, site generation, AI profile reading |
| `rivr.profile.update_basic` | Inline profile editor, AI-assisted profile updates, command bar profile edits |
| `rivr.posts.create` | Post composer, blog editor, bulletin board, AI-assisted posting |
| `rivr.posts.create_live_invite` | Meeting creation wizard, live invite flow, voice-initiated meetings |
| `rivr.groups.join` | Group join/leave buttons, directory CTA, invitation acceptance |
| `rivr.events.rsvp` | RSVP buttons on event cards, calendar event actions |
| `rivr.events.append_transcript` | Live transcript viewer, WhisperX integration, voice-to-transcript |
| `rivr.audit.recent` | Autobot activity log, MCP provenance viewer, security audit dashboard |

## Appendix C: Verb-to-UI Pattern Reference

For each verb type, the specific UI pattern it drives:

| Verb | Query Pattern | UI Output |
|---|---|---|
| `join` | `WHERE verb='join' AND objectId=groupId AND isActive=true` | Member count badge, member directory entry, role assignment |
| `follow` | `WHERE verb='follow' AND objectId=agentId AND isActive=true` | Follower count, follow/unfollow button state |
| `endorse` | `WHERE verb='endorse' AND objectId=agentId` | Endorsement count, testimonial display, social proof section |
| `attend` | `WHERE verb='attend' AND objectId=eventId` | Attendee list, attendance count, RSVP status |
| `vote` | `WHERE verb='vote' AND objectId=proposalId` | Vote tally, voting progress bar, voter list |
| `propose` | `WHERE verb='propose' AND objectId=groupId` | Proposal list, governance feed entry |
| `react` | `WHERE verb='react' AND objectId=resourceId` | Reaction counts by type, reaction button state |
| `buy` | `WHERE verb='buy' AND subjectId=personId` | Purchase history entry, receipt generation trigger |
| `work` + `clock_in`/`clock_out` | `WHERE verb IN ('clock_in','clock_out') AND subjectId=agentId` | Timesheet entries, hours worked calculation |
| `share` | `WHERE verb='share' AND objectId=resourceId` | Share count, shared-with list |
| `grant`/`revoke` | `WHERE verb IN ('grant','revoke') AND objectId=resourceId` | Permission audit trail, access control status |
| `host` | `WHERE verb='host' AND subjectId=agentId` | "Hosted by" attribution on events |
| `manage` | `WHERE verb='manage' AND objectId=groupId AND isActive=true` | Admin/leadership badges, org chart hierarchy |
