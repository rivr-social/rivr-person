# Issue: Wire NLP Parser V2 into Command Bar

## Summary

The command bar currently only supports `pay [name] [amount]` via regex. The full NLP parser v2 (`nlp-parser-v2.ts`) and entity scaffold system (`nlp-input.tsx` + `entity-scaffold-preview.tsx`) exist but are disconnected from the command bar. Wire them together so the `$` command bar becomes the primary natural language creation surface.

## Context

### What Exists (Disconnected)
- **Command bar** (`CommandBar.tsx`): `$` input, keyboard shortcuts (`/` to focus, `Esc` to cancel), form submit
- **NLP parser v2** (`nlp-parser-v2.ts`): Full entity/relationship extraction with REA model mapping, verb categories, determiner analysis, chrono-node temporal extraction
- **NLP input** (`nlp-input.tsx`): Parse → DB enhancement → confirm → create workflow
- **Entity scaffold preview** (`entity-scaffold-preview.tsx`): User review/edit before persistence
- **Create entities action** (`create-entities.ts`): Transactional DB write with ledger recording
- **Transaction engine** (`engine.ts`): 34+ verb types, sentence grammar, reputation system
- **Contract engine** (`contract-engine.ts`): WHEN/THEN rule chains that fire on ledger entries

### What the Command Bar Does Today
- Regex: `/^pay\s+([a-zA-Z0-9_-]+)\s+(\d+(?:\.\d+)?)$/i`
- Only `pay alice 50` works
- Everything else fails with "invalid command format"

## Requirements

- Command bar should accept any natural language input the NLP parser v2 can handle
- For payment commands (`pay X Y`), preserve the fast regex path
- For entity creation ("create a meetup in Pioneer Square for Friday"), route through NLP parser v2
- Show entity scaffold preview inline or in a sheet/dialog when entities are parsed
- User confirms before creation (never auto-create from ambiguous input)
- After creation, the new entities appear in the graph tab
- Existing DB entities should be linked (determiner analysis: "the Portland chapter" vs "a new chapter")

## Technical Approach

1. In `CommandBar.tsx`, after form submit:
   - Try `PAY_COMMAND_PATTERN` regex first (fast path)
   - If no match, call `parseNaturalLanguageV2(input)`
   - If parse yields entities, show `EntityScaffoldPreview` in a sheet
   - On confirm, call `createEntitiesFromScaffold()`
2. Optionally: add inline suggestions/autocomplete as user types (future)
3. The command bar becomes the universal input surface for the entire app

## Files to Modify

- `src/components/CommandBar.tsx` — add NLP parser fallback and preview rendering
- `src/app/actions/commands.ts` — route non-payment commands to NLP parser
- Possibly extract shared logic from `src/components/nlp-input.tsx` into a hook

## Priority

Medium-high — this activates a large amount of existing unused code and makes the command bar the central creation interface.
