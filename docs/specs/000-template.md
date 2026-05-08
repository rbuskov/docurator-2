# Slice NNN: <Name>

**Status:** draft

## Observable result

One sentence — what a user can do or see at the end of this slice that they couldn't before. Lifted from `initial-feature-slices.md`, refined if needed.

## Prerequisites (Consumes)

What must already exist when this slice begins. Every item here must be produced by some earlier spec. Use "—" for empty categories; don't drop categories silently.

- **DB tables / columns:** —
- **Migrations:** —
- **API endpoints:** —
- **UI views / components:** —
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:** —
- **External services:** —
- **Other:** —

## Deliverables (Produces)

What this slice adds. Same categories as Prerequisites. Be concrete: name the table, give the endpoint path and request/response shape, name the component, name the env var. A reader should be able to scan this list and know exactly what code will land.

- **DB tables / columns:** —
- **Migrations:** —
- **API endpoints:** —
- **UI views / components:** —
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:** —
- **External services:** —
- **Other:** —

## Out of scope

Things a reader might reasonably expect to see in this slice but that are deliberately left to a later slice. Each item names the slice that will handle it.

- … → Slice NNN

## Detailed design

Narrative + bullets covering each Deliverable. Reference `architecture.md` sections by name rather than duplicating them. Capture the decisions specific to this slice, not background.

## Acceptance criteria

Testable conditions for slice "done". Phrased as observable behavior, not implementation. One per bullet.

- …

## Risks / open questions

Known unknowns. Anything where `architecture.md` is silent or contradictory and you had to decide. Anything you want a human to confirm before this spec is promoted to `ready`.

- …
