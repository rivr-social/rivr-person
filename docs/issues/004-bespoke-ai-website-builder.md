# Issue: AI-Powered Bespoke Website Builder at PM Core Root Domain

## Summary

The root domain of every PM Core instance should serve an AI-powered website builder. Users log in, talk to an AI that builds out their personal/group website, and it imports data from their Rivr profile (or Solid Pod URI) via API endpoints into a static site deployed publicly at that domain.

## Vision

### Person Instance (e.g. `camalot.me`)
- Root domain → login → conversational AI interface
- AI reads the user's public Rivr profile fields via MCP/API from `rivr.camalot.me`
- AI generates a static personal website with the user's bio, skills, posts, offerings, connections
- Site is deployed and served at the root domain
- User can iterate: "make it darker", "add my events", "show my groups"
- Can also import from Solid Pod URI if the user has one

### Group Instance (e.g. `boulderfoodcoop.org`)
- Root domain → login → conversational AI interface
- AI reads the group's public data from the group Rivr instance
- AI generates a group webpage: about, members, events, docs, offerings
- Deployed at the root domain as the group's public face

## Architecture

### Data Flow
```
User → Login at root domain → AI Chat Interface
  ↓
AI reads profile via:
  - MCP tools (rivr.profile.get_my_profile, rivr.instance.get_context)
  - Public API endpoints (/api/profile/[username], /api/myprofile/manifest)
  - Solid Pod URI (if configured)
  ↓
AI generates static site (HTML/CSS/JS)
  ↓
Static site deployed to root domain via PM Core reverse proxy
  ↓
Public visitors see the generated website
```

### Existing Infrastructure
The bespoke module system already exists in the codebase:

- **`src/lib/bespoke/types.ts`** — `BespokeModuleManifest` type system with:
  - Auth gates: `public | authenticated | owner`
  - Data sources with endpoints, schemas, auth requirements
  - Mutations with input schemas
  - Reusable components declared in manifest
  - Slot system for composable layouts

- **`src/lib/bespoke/modules/myprofile.ts`** — MyProfile module manifest:
  - Data sources: profile, wallet, transactions, posts, events, groups, marketplace, connections
  - Mutations: updateProfile, updateAvatar
  - Components: ProfileHeader, PostFeed, EventFeed, WalletCard, etc.

- **`src/lib/bespoke/modules/public-profile.ts`** — PublicProfile module manifest:
  - Read-only profile data for public visitors
  - Components: PublicProfileHeader, PostFeed, EventList, etc.

- **API endpoints already exist:**
  - `GET /api/myprofile` — authenticated profile data
  - `GET /api/myprofile/manifest` — bespoke module manifest
  - `GET /api/profile/[username]` — public profile data
  - `GET /api/profile/[username]/manifest` — public profile module manifest

### What Needs Building

1. **AI Chat Interface at root domain**
   - Conversational UI (AI SDK `useChat` + streamText)
   - System prompt that understands the bespoke module manifest
   - AI reads profile data via MCP or API, generates site layout
   - Iterative refinement: user says what they want, AI updates

2. **Static Site Generator**
   - AI produces HTML/CSS/JS (or Next.js static export)
   - Templates seeded from bespoke module manifest components
   - Data injected from profile API responses
   - Responsive, accessible, follows user's style preferences

3. **Deployment Pipeline**
   - Generated site stored in Blob/MinIO
   - PM Core Traefik serves static site at root domain
   - Rebuild on demand when user updates via AI chat
   - Version history so user can rollback

4. **Solid Pod Integration (optional)**
   - Read from user's Solid Pod URI if configured
   - Import structured data (foaf:Person, schema:Person, etc.)
   - Merge with Rivr profile data

5. **PM Core Root Route**
   - If no generated site exists → show login + AI builder
   - If generated site exists → serve it publicly
   - Owner can access `/admin` or `/builder` to re-enter AI chat

## Relationship to Bespoke Module System

The existing bespoke module manifests (`myprofile.ts`, `public-profile.ts`) define:
- What data is available
- What mutations are allowed
- What reusable components exist
- What auth level each part requires

The AI website builder consumes these manifests to understand what it can build. The manifest is the contract between the profile data layer and the AI generator.

## Instance Types

| Instance Type | Root Domain Behavior | Data Source |
|---|---|---|
| Person | Personal website | `rivr.profile.get_my_profile` + public profile API |
| Group | Group website | Group public data API + group docs/events |
| Locale | Locale/community page | Locale public data + member groups/events |
| Bioregional | Bioregion portal | Bioregional data + nested locales/groups |

## Priority

High — this is the "why" for the entire PM Core + sovereign instance stack. Every instance type gets a public face that's AI-generated from real data.

## Dependencies

- MCP server working (done)
- Public profile API working (done)
- Bespoke module manifests defined (done)
- AI SDK integration (needs setup — model provider, API keys or AI Gateway)
- Static site storage (MinIO/Blob — infrastructure exists)
- PM Core routing (Traefik — infrastructure exists)
