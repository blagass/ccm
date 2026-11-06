# LeadFlow

A self-hosted alternative to HubSpot for **forms, lead management, and marketing automation**. It's a single Node.js process with an embedded SQLite database. There's no build step, and the only runtime dependencies are `express` and `nodemailer`.

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
| `ADMIN_PASSWORD` | Admin login (default `admin`) |
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
- Public: `GET /api/public/forms/:publicId`, `POST /api/public/forms/:publicId/submit`

## Project layout

```
src/server.js      HTTP routes (admin API, public forms, tracking, unsubscribe)
src/db.js          SQLite schema + settings
src/contacts.js    contacts, tags, stages, scoring, timeline
src/forms.js       form definitions, validation, submission pipeline
src/mailer.js      template rendering, tracking, SMTP/dev transport
src/automation.js  workflow engine (triggers, steps, scheduler)
public/            admin SPA (vanilla JS) + embed.js
test/e2e.test.js   end-to-end tests (npm test)
```

## Known limitations / next steps

- There is one admin user. Multiple users and roles are not built yet.
- Editing a workflow's steps while contacts are mid-run: those contacts resume at the same step *number*, so reordering steps can shift where they continue.
- Broadcasts are sent sequentially in-process. For very large lists, add a queue and respect your ESP's rate limits.
- The in-memory rate limiter and event bus assume a single server process. If you run more than one, use Redis.
- Not built yet: a drag-and-drop email designer, A/B tests, landing-page builder, CRM deals pipeline, double opt-in.
- SQLite will handle a few hundred thousand contacts comfortably. Beyond that, port `db.js` to Postgres.
