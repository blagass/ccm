# LeadFlow

A self-hosted alternative to HubSpot for **forms, lead management, marketing automation, and a weekly sales pipeline**. It's a single Node.js process with an embedded SQLite database. There's no build step, and the only runtime dependencies are `express` and `nodemailer`.

## Features

**Forms**
- Visual form builder with live preview. Field types: text, email, phone, textarea, select, checkbox, number, hidden.
- Three ways to publish a form: a hosted page (`/f/:id`), a one-line JS embed for any website, or a plain HTML `<form>` POST / JSON API.
- Captures page URL, referrer and UTM parameters, and keeps the UTMs across pages within a session.
- Validation runs on the server. Includes a honeypot spam trap and per-IP rate limiting.
- After a submission, a form can: tag the contact, set the lifecycle stage (forward only), email your team, show a message or redirect.

**Leads / contacts**
- Contacts are deduplicated by email. Known fields map to contact properties; any other field becomes a custom property.
- Lifecycle stages: Subscriber → Lead → MQL → SQL → Opportunity → Customer.
- Lead scoring: configurable points for form submits, email opens and clicks. Contacts are promoted to MQL automatically at a threshold you set.
- Each contact has a timeline: submissions, emails, opens and clicks, stage changes, workflow events and notes.
- Search and filter by stage, tag or score. CSV import and export (export guards against CSV formula injection).

**Marketing automation**
- Workflows start on one of these triggers: form submitted, tag added, stage changed, contact created, email opened, email clicked.
- Steps: send email, wait (minutes/hours/days), add or remove a tag, set stage, adjust score, **continue only if…** (tag / stage / score / opened / clicked / property), notify team, webhook.
- Workflow state lives in SQLite, so waiting contacts carry on after a restart. Each enrollment has a per-step log.
- Contacts can be re-enrolled, or enrolled by hand from the contact page.

**Email**
- Templates support merge tags and fallbacks: `{{first_name|there}}`.
- Open-pixel and click tracking. The click redirect only follows links that are actually in the email, so it can't be used as an open redirect.
- Unsubscribe link plus a `List-Unsubscribe` header. Unsubscribed contacts are never emailed.
- Broadcasts send one-off emails to a segment.
- Outbox shows every rendered email.

**Sales pipeline (weekly lead scan)**
- Three lists, one row per business: **New leads**, **Switch prospects** (existing operators whose supplier decision is reopening) and **Chain & franchisee accounts**. Each row has all 23 columns from the weekly lead file: priority, branch, stage, what's happening, deal size, decision timeline, persona, likely objection → response, hooks, rebate flag, how to reach, backup contacts, plus the rep-owned ("gold") fields: current supplier, mutual connections, Curtis relationship, assigned rep and status.
- **Import the weekly `.xlsx`** (the `Curtis_Weekly_Leads_YYYY-MM-DD.xlsx` layout). New businesses are added. Businesses already being tracked get their scan details refreshed, but **reps' updates are kept** (assigned rep, status, relationship intel, notes), so each week's file adds to the history instead of replacing it.
- A business can only be on one list. If it shows up on two tabs in the same file, it's kept on the first and the duplicate is reported.
- **Executive Summary** shows live tiles (new / Hot / switch / chain counts, estimated pipeline, Hot leads not yet assigned, leads still at "New"), plus:
  - the "where to focus this week" list: each item links to a prospect (branch, deal size, owner and status shown live), with an editable action, do-by note and reason; general items without a prospect are allowed; reorder, add from the picker or from a lead's brief; suggested automatically by deadline and deal size when none is written;
  - pipeline by branch;
  - bigger plays, risks and lead sources;
  - rep workload and a status funnel.
  It prints on one page.
- **One-page brief** for every business: snapshot, persona quick read, conversation starters, contacts, relationship intel, next-step checklist, outreach email (copy or open in your mail app), source link, and an activity log for notes and status changes.
- **Personas** library (message, channels and materials for each buyer type), linked from every brief.
- **Export to Excel** rebuilds the weekly workbook in the same format: Executive Summary with live formulas, the three list tabs with gold rep columns and a Status dropdown, Personas, Outreach Drafts, a brief tab per Hot lead, and Sources & Gaps.

**Daily welcome**
- Once a day, after signing in, a friendly popup greets each person by name and suggests up to three quick wins from their own work: carried-over tasks, deadlines in the next week, Hot leads still at "New", and (for admins) Hot leads nobody has picked up. Busy weeks are framed calmly. Click your name in the sidebar to see it again.

**Team accounts**
- Admins invite people from **Users**. Each invite is a single-use link that expires after 7 days; it's also emailed when SMTP is configured. The invited person picks their own name and password.
- Roles: **Admin** (manages users and settings, imports weekly files) and **Rep** (everything else).
- Admins can reset passwords (by sending a new link), change roles, and disable or remove users. Disabling someone signs them out immediately.
- Pipeline status changes, assignments and notes record who made them, and every user appears in the "Assigned rep" list.
- The owner login (leave email blank, use `ADMIN_PASSWORD`) always works, so you can't get locked out.

## Quick start

```bash
npm install
```

```bash
npm run seed
```

```bash
ADMIN_PASSWORD=change-me npm start
```

Then open http://localhost:3000. Requires Node ≥ 22.5, which provides the built-in `node:sqlite`.

Without `SMTP_HOST`, emails are rendered and saved to the **Outbox** but not delivered. This is useful for trying things out.

## Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `BASE_URL` | Public URL, used in tracking/unsubscribe links and embed code. **Set this in production.** |
| `ADMIN_PASSWORD` | Owner login: leave email blank on the sign-in page (default `admin`, so change it) |
| `SESSION_SECRET` | Cookie signing secret (derived from the password if unset) |
| `API_KEY` | Enables `Authorization: Bearer <key>` access to the admin API |
| `DB_PATH` | SQLite file (default `data/leadflow.db`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | Outbound email (works with SES, Postmark, SendGrid, Mailgun SMTP, etc.) |
| `FROM_EMAIL` | Initial default sender. You can change it in Settings. |

## Embedding a form

```html
<div data-leadflow-form="FORM_PUBLIC_ID"></div>
<script src="https://leads.yourco.com/embed.js" async></script>
```

The embed fires a `leadflow:submitted` DOM event that you can hook analytics into. The form's **Share & embed** tab has copy-paste snippets.

## API

All `/api/*` routes, except `/api/public/*`, need the session cookie or `Authorization: Bearer $API_KEY`. The main ones:

- `GET/POST /api/contacts`, `GET/PATCH/DELETE /api/contacts/:id`, `POST /api/contacts/:id/notes|email|enroll`, `POST /api/contacts/import`, `GET /api/contacts/export.csv`
- `GET/POST /api/forms`, `GET/PUT/DELETE /api/forms/:id`, `GET /api/forms/:id/submissions`
- `GET/POST /api/templates`, `PUT/DELETE /api/templates/:id`, `GET /api/outbox`
- `GET/POST /api/workflows`, `GET/PUT/DELETE /api/workflows/:id`
- `POST /api/broadcasts/preview`, `POST /api/broadcasts`
- `GET /api/dashboard`, `GET/PUT /api/settings`
- Team (admins): `GET /api/users`, `POST /api/users/invite`, `POST /api/users/:id/reset`, `PATCH/DELETE /api/users/:id`, `DELETE /api/users/invites/:id`; public `GET /api/invites/:token`, `POST /api/invites/:token/accept`
- Pipeline: `GET/POST /api/opportunities`, `GET/PATCH/DELETE /api/opportunities/:id`, `POST /api/opportunities/:id/notes|contact`, `GET /api/pipeline/summary?week=`, `PUT /api/pipeline/reports/:week`, `POST /api/pipeline/import` (raw .xlsx body), `GET /api/pipeline/export.xlsx?week=`, `GET/POST /api/personas`
- Public: `GET /api/public/forms/:publicId`, `POST /api/public/forms/:publicId/submit`

## Project layout

```
src/server.js      HTTP routes (admin API, public forms, tracking, unsubscribe)
src/db.js          SQLite schema + settings
src/contacts.js    contacts, tags, stages, scoring, timeline
src/forms.js       form definitions, validation, submission pipeline
src/mailer.js      template rendering, tracking, SMTP/dev transport
src/automation.js  workflow engine (triggers, steps, scheduler)
src/pipeline.js    sales pipeline: opportunities, dedupe, week-over-week merge, executive summary math
src/xlsx.js        weekly lead workbook import/export
public/            admin SPA (vanilla JS: app.js marketing, pipeline.js sales) + embed.js
test/              end-to-end tests (npm test)
```

## Known limitations / next steps

- **Don't commit real lead files or the `data/` folder to a public repository.** Import them through the app instead.
- Branch names default to Springfield, Portland, Bend, Medford and Boise. Change them with `PUT /api/settings` (`branches`).
- There is one admin user. Multiple users and roles are not built yet.
- Editing a workflow's steps while contacts are mid-run: those contacts resume at the same step *number*, so reordering steps can shift where they continue.
- Broadcasts are sent sequentially in-process. For very large lists, add a queue and respect your ESP's rate limits.
- The in-memory rate limiter and event bus assume a single server process. If you run more than one, use Redis.
- Not built yet: a drag-and-drop email designer, A/B tests, landing-page builder, CRM deals pipeline, double opt-in.
- SQLite will handle a few hundred thousand contacts comfortably. Beyond that, port `db.js` to Postgres.
