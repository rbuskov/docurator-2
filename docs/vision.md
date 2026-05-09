# Docurator — Vision

## What is Docurator?

**Docurator is a curator of your business documents.** It watches your inbox for invoices and receipts, sets them aside, and curates them into a tidy, reviewed collection ready for your accounting system.

The name reflects the app's nature. It doesn't capture or hoard email. It doesn't try to read everything you receive forever. It curates — selecting carefully from a much larger stream, keeping only what matters, presenting it for your review, and letting the rest pass by untouched.

## Who is it for?

Freelancers and one-person businesses doing their own bookkeeping.

The kind of person who:

- Has one or more Gmail inboxes where receipts and invoices arrive constantly — often a personal address and a business address kept separate — flooded with Stripe payouts, AWS bills, software subscriptions, client invoices, hotel receipts, app store charges, taxi rides
- Uses an accounting tool (Xero, QuickBooks, e-conomic, Dinero, Billy, FreeAgent, or similar) and needs to feed those documents into it
- Currently does this manually — searching the inbox at month-end, downloading attachments one at a time, forwarding emails to their accountant, screenshotting receipts that came as HTML
- Knows the pain of finding out at year-end that they missed a deductible expense from March because they forgot to file the receipt
- Has VAT obligations, tax deadlines, and other real consequences for getting bookkeeping wrong
- Cares about privacy, especially when their inbox contains client correspondence covered by NDAs, professional confidentiality, or just personal sensitivity

This is not a consumer app for tracking personal spending. It's a working tool for people whose income depends on their books being accurate.

## The problem we're solving

Receipt management for small businesses is broken in a specific way: the receipts are *all already there* in your email, but extracting them is tedious enough that people put it off, miss things, and either lose money on missed deductions or pay an accountant to chase the same emails the user could have surfaced themselves.

Existing solutions fall into two camps, both of which fail in characteristic ways:

**Manual workflow.** Most freelancers do this. It works but eats hours every month and lets things slip through. The cost of a missed receipt isn't just the deduction lost — it's the audit risk of inconsistent record-keeping.

**SaaS receipt-capture services.** Dext, Hubdoc, AutoEntry, and similar tools work, but they require sending your email to a third party, often via a forwarding address. They give you OCR and field extraction, but at the cost of routing your business correspondence through a vendor. For a freelancer whose inbox contains client confidential information, that's a trade many people aren't comfortable making — but they make it anyway because the manual alternative is worse.

There's a third path: a tool that does the same automation locally, on your own machine, that never sends your email anywhere it isn't already going. That's the gap Docurator fills.

## What Docurator does

Once a month (or whenever you feel like it), you open Docurator and click sync. It:

1. **Reads** your Gmail account(s) — strictly read-only, it can never modify or delete anything in any of them
2. **Classifies** each email locally — using a vision-capable AI model running on your own machine
3. **Keeps** the receipts and invoices it finds — both as PDF attachments and as receipt-shaped email bodies
4. **Discards** the rest — non-receipt mail flows through in memory and is never written to disk
5. **Shows you** what it found, side-by-side with the original document, so you can confirm or reject and edit any details the model got wrong
6. **Exports** approved receipts as a zip with a structured manifest, ready for your accountant or your accounting software

You spend ten minutes reviewing what it surfaced. You export to your accounting tool. You're done.

If you keep your business and personal email in separate Gmail accounts — as many freelancers do — you connect each of them to the same Docurator install, and a single sync covers them all. Receipts stay attributed to the account they came from, so you always know which inbox a document originated in.

## What Docurator is not

**Not an email client.** It doesn't replace Gmail, doesn't compose emails, doesn't manage your inbox.

**Not an email archiver.** It doesn't store your email. Only confirmed receipts are persisted. Everything else passes through and is forgotten.

**Not an accounting system.** It feeds your accounting tool, it doesn't replace it. No general-ledger features, no invoicing, no bank reconciliation.

**Not a SaaS.** It runs on your machine, end of story. There is no Docurator cloud service to sign up for. There is no Docurator server processing your data.

**Not for personal expense tracking.** This is a business tool. A consumer-grade "track my spending" app would have very different priorities (budgeting, categorization for personal categories, mobile-first capture). Docurator is built for the bookkeeping workflow.

**Not multi-provider in v1.** Gmail only. Outlook and other providers are future work.

## Core principles

These are the values that guide every design decision. When something is unclear, these are how we decide.

### Privacy by architecture, not by promise

The strongest privacy claim isn't "we don't look at your data." It's "we structurally cannot." Docurator runs on the user's machine. Email content never leaves it. Classification happens locally via Ollama. There is no Docurator server. There is no API call to Anthropic, OpenAI, or anyone else. Even a complete compromise of the app cannot exfiltrate data, because there is nowhere for it to go.

This isn't a marketing position; it's an architectural commitment. It rules out paths that would be technically convenient but require trusting a third party with email content.

### Read-only access to email

Docurator's only Gmail-touching scope is `gmail.readonly`, for every account the user connects. It cannot label, move, archive, mark as read, send, or delete any email in any of those accounts. Each connected inbox after a sync is identical to what it was before. The only signal of Docurator's existence is in its own local database.

The OAuth flow itself also requests `openid` and `userinfo.email` so the app can recognize *which* Google account just authenticated and key its local records by that address. These are read-only Google identity scopes — they grant access to the user's email address, nothing more — and they touch no Gmail data. They are part of the OAuth handshake, not part of how Docurator interacts with mail.

This is a stronger guarantee than "we promise not to mess with your email." We've never asked for the capability to modify Gmail, so we structurally cannot misuse it. If Docurator is ever compromised, breaks, or behaves unexpectedly, the worst it can do is read.

### Curate, don't hoard

The app keeps only what it needs. Receipts and invoices that pass classification are persisted; everything else is discarded after classification. The local disk reflects the user's curated collection of business documents, not a shadow archive of their inbox.

This matters for privacy (smaller local footprint, less to leak if the laptop is lost) and for clarity of purpose (you know exactly what's in `~/invoices/` because nothing irrelevant goes there).

### Trust through transparency

For business use, the user has to trust the tool with tax-relevant work. Trust comes from being able to see what's happening, not from being asked to take it on faith. Docurator surfaces:

- Which emails were processed, and what was decided
- Which model made each decision
- Why each decision was made (the model's stated reason)
- What exactly will be sent in any export
- Where every file lives on disk

The audit view is a first-class feature, not a hidden settings panel. It exists so the user can spot mistakes — and can build justified confidence in the tool over time.

### Recoverable, never destructive

Misclassification is inevitable. The system is designed so misclassification is always recoverable:

- Review actions are reversible
- Re-classification with a new model is a first-class operation
- Old decisions remain in the log when newer ones overwrite them
- Files are never auto-deleted; the user decides

The user's data is in plain folders and a SQLite database, both visible on the host filesystem. If Docurator ever stops working, the user's documents are still right there, browsable, exportable, theirs.

### Accountant-ready output

The export isn't a pile of files — it's a deliverable. A zip plus a structured CSV manifest that an accountant or accounting tool can ingest. The fields, the formatting, the dating, the tagging — all designed around what comes next in the bookkeeping workflow, not around what was easiest to produce.

If the export doesn't slot cleanly into how a freelancer actually files their books, the tool has failed at its job no matter how well it classified.

### Honest about limitations

Local AI models are not as good as frontier cloud models. Hardware varies. Receipts come in countless weird formats. The tool is honest about this: low-confidence items surface for review, failed classifications are visible and retryable, the audit view is the safety net. We don't pretend the model is perfect; we make its imperfections legible and correctable.

Likewise, we're honest about scope. Gmail-only. No background processing. Single user per install — Docurator is one person's tool, even when that one person connects multiple Gmail accounts to it. These are deliberate choices, not embarrassments — but we don't oversell what the tool does.

## What success looks like

A freelancer who uses Docurator regularly should experience:

- **Bookkeeping time reduced from hours to minutes per month.** Sync, review, export. Done.
- **Fewer missed receipts.** Year-end shouldn't surface deductions they forgot about, because the tool surfaced them when they arrived.
- **Confidence at audit time.** Receipts are filed, organized by fiscal period, with clear provenance back to the original email if anyone asks.
- **No new privacy worries.** The tool never expanded the set of parties who see their email. It works the same on Tuesday morning as it does on Friday at 11 PM the day before tax filing.
- **No lock-in.** If they stop using Docurator tomorrow, their files are still in `~/invoices/`, browsable, exportable, theirs.

If a user opens Docurator for the first time, syncs a year of mail, and finds receipts they had genuinely forgotten about — that's the moment the tool has earned its place.

## Distribution and licensing

Docurator is open source under the MIT license, distributed as source code on GitHub. Each user clones the repo, supplies their own Google OAuth credentials, runs `docker compose up`, and uses it.

There is no paid tier, no SaaS version, no telemetry, no central infrastructure of any kind. The code is the product, and it runs entirely on the user's machine.

## What this document is for

This vision document is the *why* and *what* of Docurator. It changes rarely. It's the reference for "would this fit the project?" when evaluating new ideas, features, or pull requests.

The companion architecture.md is the *how* — the technical design that realizes this vision. It evolves as the project is built and as we learn from using it.

When the two documents are in tension, this one wins. The architecture serves the vision, not the other way around.
