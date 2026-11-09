# Changelog

## Alpha 1.0 (`1.0.0-alpha`): 2026-11-09

First saved version of **My Curtis**: Curtis Restaurant Equipment's sales pipeline, lead and marketing app.

**Sales pipeline**
- New leads, switch prospects and chain & franchisee accounts with all 23 columns of the weekly lead workbook; one list per business.
- Executive Summary: live tiles, focus list linked to prospects (multi-lead items, split, reorder, add from a brief), pipeline by branch, plays, risks, sources, rep workload; prints on one page.
- One-page brief per lead with persona quick read, relationship intel, outreach email, tasks and activity log.
- Weekly workbook import and Excel export in the same layout; reps' updates carry over week to week.
- Automated Monday 5:39am (Pacific) lead scan on Opus 5.5 writing straight into the app; imported or hand-edited weekly notes are never overwritten.
- Branch owners (Boise: John, Bend: Scott, Springfield: Nyles, Medford: Kevin) with automatic assignment; first-name placeholders switch to full names when people join.

**Team & daily use**
- Team accounts with invite links, Admin/Rep roles, password resets, disable/remove, and the owner login.
- Calendar: tasks, deadlines, focus actions and scan days; overdue tasks roll forward; Mine/Everyone.
- Daily welcome popup with quick wins (team picture for admins, personal for reps).
- Curtis look and feel: logo, colors and fonts from curtisresteq.com.

**Marketing**
- Form builder with embed / hosted page / API, contacts with lifecycle stages and lead scoring, email templates with open/click tracking and unsubscribe, workflows, broadcasts.

**Known gaps at Alpha 1.0**
- Email delivery needs SMTP (SendGrid) settings in Railway; until then emails go to the Outbox only.
- Form submissions create marketing contacts, not pipeline leads.
- Portland has no branch owner.
