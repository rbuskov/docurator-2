# ADR-002: Bare-SQL migration runner

**Status:** Accepted
**Date:** 2026-05-09
**Supersedes:** —
**Spec:** `docs/specs/002-connect-gmail-accounts.md`

## Context

Slice 002 introduces SQLite + the first `accounts` migration. `docs/architecture.md` § "Tech stack" pins `better-sqlite3` for storage but is silent on how migrations are run. Future slices (004 brings WAL + the rest of the schema; 008, 009, 011, 013, 014, 015 each touch the schema or add their own migrations) will all add migration files, so the runner shape is a project-wide pattern that this slice fixes.

The runner needs to be reliable enough to bet first-run-after-`docker compose up` correctness on, but the schema itself is small (a handful of tables across the v1 backlog) — there's no need for the heavy machinery a multi-developer enterprise migration ecosystem uses.

## Decision

Use a **bare-bones runner**: pure `*.sql` files in `src/server/db/migrations/`, applied in lexical order, tracked by a single `_migrations(filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)` table. Each migration runs inside a `db.transaction(...)` along with its own `INSERT INTO _migrations` row, so a partial failure rolls back atomically — both the schema change and the bookkeeping row vanish together if the migration throws. No down-migrations, no checksums, no out-of-order detection.

The runner is `src/server/db/migrate.ts`'s `migrate(db, migrationsDir)`. It runs once at server startup before `serve(...)` is called; failure to migrate aborts startup with a clear stderr error.

## Consequences

- **Easy to read.** Schema evolution is plain SQL files in a directory — no DSL, no migration language, no schema-as-code DSL. New contributors can read `0001_create_accounts.sql` without learning anything new.
- **DDL + bookkeeping atomicity.** Because the `INSERT INTO _migrations` is inside the same transaction as the migration's `CREATE TABLE` / `ALTER TABLE`, partial-failure corruption is impossible. SQLite supports transactional DDL, so a thrown error during migration leaves the DB exactly as it was before. Verified by `migrate.test.ts`'s rollback case.
- **No down-migrations, ever.** Schema-rollback-by-down-migration is rejected as untestable in practice (most projects' down-migrations are buggy and never exercised). Restoration on a botched migration is via the user's host-level backup of the bind-mounted `./data` directory, per `docs/architecture.md` § "Data retention and backup". This matches the project's "user owns the volume" stance.
- **No checksums.** Once a migration's filename appears in `_migrations`, the runner will not re-run it regardless of content edits. Editing applied migrations is a discipline issue: don't do it. The unit test for the runner does *not* enforce this; future contributors are trusted.
- **Out-of-order detection skipped.** When two contributors both create `0042_*.sql`, git's merge surfaces the filename collision; the merge resolution renumbers one to `0043`. Lexical order is deterministic. No need for the runner to detect "you applied 0043 but skipped 0042 — refusing to continue" given v1's single-developer + single-machine assumption (per `docs/vision.md` and `docs/architecture.md` § "Goals & non-goals" — explicitly not multi-tenant).
- **Constraint imposed on later specs.** Migrations are append-only and never edited after they ship. New schema changes always create a new file with a higher numeric prefix. The four-digit zero-padded prefix (`0001_…`, `0002_…`) keeps lexical order aligned with numeric order well past v1's expected migration count.
- **Runs synchronously.** `better-sqlite3` is a synchronous library; the runner is sync. The server's startup path awaits nothing for migrations, which is fine — the migrations are tiny and run during the few-seconds startup window.

## Alternatives considered

- **Drizzle Kit** — full migration ecosystem with schema diffing, but ties the project to an ORM-shaped definition layer (`drizzle-orm` schemas in TypeScript) when raw SQL is what we already have and want to keep. The repository layer is plain prepared statements per `docs/architecture.md` § "Project structure"; pulling in a TypeScript schema definition just for migrations would split the source of truth.
- **kysely-migrator** — clean API, but assumes Kysely is the query builder. We've chosen prepared-statement repositories instead, keeping the dependency surface smaller and the SQL closer to what runs against the DB.
- **db-migrate** — heavy, cross-database abstractions we don't need (we're SQLite-only). The runner adapter is bigger than the rest of the migration tooling combined.
- **knex-migrate** — same drawbacks as db-migrate; assumes Knex is the query builder.
- **No runner at all (just `db.exec` of a hardcoded schema string at startup)** — would force schema rebuilds on existing user databases on upgrade, which violates the architecture's data-persistence promise.

## Supersession

—
