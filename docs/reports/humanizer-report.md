# Report: Humanizer (github.com/blader/humanizer)

Date: 2026-04-01

## What It Is

Humanizer is a Claude Code / OpenCode skill that detects and removes AI-generated writing patterns. It identifies 29 distinct patterns across 5 categories and rewrites text to sound natural and human. 11.9k stars, MIT license.

## How It Works

It's a **markdown-based skill file** (SKILL.md) — not a library, not an API. You install it into `~/.claude/skills/humanizer/` and invoke it via `/humanizer` in Claude Code or by asking "humanize this text." The skill prompt instructs the LLM to:

1. Scan text for 29 known AI writing artifacts
2. Rewrite to remove them
3. Run an "obviously AI generated" audit pass
4. Do a second rewrite to catch remaining patterns
5. Optionally match the user's personal voice (provide 2-3 paragraphs of your writing)

## The 29 Patterns

### Content (6)
- Significance inflation ("This groundbreaking...")
- Notability name-dropping (vague media references)
- Superficial -ing analyses ("showcasing", "highlighting")
- Promotional language (marketing-speak)
- Vague attributions ("experts say")
- Formulaic challenges ("despite challenges")

### Language (7)
- AI vocabulary (characteristic word choices like "delve", "landscape", "leverage")
- Copula avoidance (avoiding "is/was" by substituting awkward verbs)
- Negative parallelisms / tailing negations
- Rule of three (artificial triplets)
- Synonym cycling (excessive word variation to seem varied)
- False ranges (arbitrary topic grouping)
- Passive voice / subjectless fragments

### Style (10)
- Em dash overuse
- Boldface overuse
- Inline-header lists
- Title case headings
- Emojis
- Curly quotes
- Hyphenated word pairs
- Persuasive authority tropes
- Signposting announcements ("In this section we will...")
- Fragmented headers

### Communication (3)
- Chatbot artifacts ("I hope this helps!")
- Cutoff disclaimers
- Sycophantic tone

### Filler & Hedging (3)
- Filler phrases
- Excessive hedging
- Generic conclusions

## Installation

```bash
# Claude Code
mkdir -p ~/.claude/skills
git clone https://github.com/blader/humanizer.git ~/.claude/skills/humanizer

# OpenCode
mkdir -p ~/.config/opencode/skills
git clone https://github.com/blader/humanizer.git ~/.config/opencode/skills/humanizer
```

## Relevance to Rivr

### Autobot / OpenClaw Content Generation
When the autobot drafts posts, marketplace listings, event descriptions, or profile bios, the output will have AI artifacts. Humanizer could be integrated as a post-processing step:
- Autobot drafts content → humanizer pass → preview to user → post

### Site Builder
The bespoke website builder generates copy from profile data. Running humanizer on generated headings, bios, and section text would make the output sound like the actual person wrote it — especially with voice calibration from their existing Rivr posts.

### MCP Integration Possibility
Could be exposed as an MCP tool (`rivr.text.humanize`) so the autobot can self-apply it:
- Input: raw AI-generated text
- Output: humanized version
- Optional: voice sample from user's existing posts for calibration

### Implementation Options

1. **Skill-level integration**: Install in OpenClaw's skills directory so the agent can self-humanize before posting
2. **Server-side post-processing**: Apply humanizer patterns programmatically in the post creation pipeline
3. **Client-side toggle**: "Humanize" button in the post preview before confirming

Option 1 is the simplest — drop it into OpenClaw and the agent will naturally apply humanization when writing content.

## Technical Notes

- Zero dependencies — it's just a SKILL.md prompt file
- Works within any Claude Code or OpenCode environment
- The pattern list is based on Wikipedia's "Signs of AI writing" (WikiProject AI Cleanup)
- Voice calibration requires 2-3 paragraphs of the user's actual writing
- Multi-pass: initial rewrite → audit → second rewrite

## Recommendation

Install it in OpenClaw on Camalot immediately — it's a one-command install with zero risk:

```bash
ssh root@5.161.46.237 "docker exec pmdl_openclaw mkdir -p /home/node/.openclaw/skills && docker exec pmdl_openclaw git clone https://github.com/blader/humanizer.git /home/node/.openclaw/skills/humanizer"
```

Then the autobot will have `/humanizer` available as a skill for all content generation.
