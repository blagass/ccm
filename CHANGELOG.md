# Changelog

## Unreleased

- **Operator review queue (To review)**: new leads from the weekly scan wait for an Operator or Admin instead of routing straight to branches. Approve (to the suggested or another branch), mark Already a customer / Not interested, or flag Needs info; approve selected or all at once. Branch managers and reps don't see leads until they're approved. Banner on the Executive Summary and branch pages, sidebar count, and a review item first in the Operator/Admin welcome. Setting to turn it off (Settings → General).
- **Branch managers see only their branch**: leads, search, lead pages, calendar and branch page are limited to their branch (enforced by the server); the Executive Summary, focus-list editing and Excel export are company-wide and not available to them.
- **Operator role**: sees the Executive Summary, every branch, the Pipeline and Calendar, and can move leads between branches and route unassigned leads; users and settings stay admin-only. Operators get the team-picture welcome.
- **Already a customer / Not interested**: new buttons on lead tables and briefs (and statuses). The lead closes, drops off open lists and totals, and the weekly scan skips it from then on; changing the status back resumes tracking.
- **Assigned branch**: lead tables and the lead brief show an Assigned branch dropdown (with the person underneath) instead of Assigned rep. Admins and branch managers can move a lead to another branch; it goes to that branch's owner, is logged, and the weekly scan keeps the move. Reps see it read-only.
- **Branch Manager role**: invite someone as Branch Manager for a branch (e.g. Kevin → Medford). They become that branch's owner (leads route to them, placeholder leads move to them), land on their branch page when they sign in, and get a branch version of the daily welcome. Same permissions as reps; users and settings stay admin-only.
- **Branch merges**: Portland is merged into Springfield (owner Nyles). Portland/Salem leads keep their location but count toward Springfield on the branch page, the Executive Summary, routing and the Excel export. Set in settings (`branch_merges`); removing the merge restores a separate Portland branch.
- **Branch pages** (`#/branch/Boise` etc.): tiles for open, Hot, new this week, pipeline, Hot with no rep, still New, deadlines in the next 14 days, won/lost; this week's focus narrowed to the branch (or suggested from its Hot leads); a three-week "coming up" list with deadlines, tasks and overdue items; the branch's leads with tabs and inline rep/status; who's working what; status breakdown; recent activity. "Branches" in the sidebar opens your own branch if you own one; the Executive Summary's branch table links to each page.

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
