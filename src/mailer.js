// Email rendering + sending with open/click tracking and unsubscribe links.
// Uses SMTP when SMTP_HOST is set; otherwise emails are rendered and stored in the
// outbox (visible in the UI) without leaving the machine — handy for development.
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { db, parse, getSettings } = require('./db');
const contacts = require('./contacts');

const BASE_URL = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

let transport;
function getTransport() {
  if (transport) return transport;
  if (process.env.SMTP_HOST) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } else {
    transport = nodemailer.createTransport({ jsonTransport: true });
  }
  return transport;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// {{first_name}}, {{email}}, {{company}}, {{any_property}}, {{first_name|there}} (fallback)
function merge(text, contact, extra = {}) {
  const vars = { ...contact.properties, ...contact, ...extra };
  return String(text).replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/g, (_, key, fallback) => {
    const v = vars[key];
    if (key === 'unsubscribe_url' || key === 'company_name') return v ?? '';
    return v !== undefined && v !== null && v !== '' ? escapeHtml(v) : escapeHtml(fallback ?? '');
  });
}

function trackify(html, token) {
  const base = BASE_URL();
  // Rewrite http(s) links for click tracking (skip the unsubscribe link).
  html = html.replace(/href="(https?:\/\/[^"]+)"/g, (m, url) =>
    url.includes('/u/') ? m : `href="${base}/t/c/${token}?u=${encodeURIComponent(url)}"`);
  return html + `<img src="${base}/t/o/${token}.gif" width="1" height="1" alt="" style="display:none">`;
}

function textToHtml(body) {
  // Templates may be plain text or HTML. Plain text gets paragraphs + autolinked URLs.
  if (/<[a-z][\s\S]*>/i.test(body)) return body;
  return body.split(/\n{2,}/).map(p =>
    `<p>${p.replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join('\n');
}

async function sendToContact(contactId, { templateId, subject, body, source = '' }) {
  const contact = contacts.get(contactId);
  if (!contact) throw new Error('Contact not found');
  let tpl = null;
  if (templateId) {
    tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId);
    if (!tpl) throw new Error(`Template ${templateId} not found`);
    subject = tpl.subject; body = tpl.body;
  }
  const token = crypto.randomBytes(12).toString('hex');
  const settings = getSettings();
  const extra = { unsubscribe_url: `${BASE_URL()}/u/${token}`, company_name: escapeHtml(settings.company_name) };

  if (contact.unsubscribed) {
    db.prepare('INSERT INTO email_sends (token, contact_id, template_id, source, subject, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, contactId, templateId || null, source, subject, 'skipped_unsubscribed');
    return { status: 'skipped_unsubscribed' };
  }

  const renderedSubject = merge(subject, contact, extra).replace(/&amp;/g, '&');
  let html = merge(textToHtml(body), contact, extra);
  if (!/\{\{\s*unsubscribe_url/.test(body)) {
    html += `<p style="font-size:12px;color:#888;margin-top:32px">${extra.company_name} · <a href="${extra.unsubscribe_url}">Unsubscribe</a></p>`;
  }
  html = trackify(html, token);

  db.prepare('INSERT INTO email_sends (token, contact_id, template_id, source, subject, html, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(token, contactId, templateId || null, source, renderedSubject, html, 'sending');
  try {
    await getTransport().sendMail({
      from: settings.from_email, to: contact.email, subject: renderedSubject, html,
      headers: { 'List-Unsubscribe': `<${extra.unsubscribe_url}>` },
    });
    const status = process.env.SMTP_HOST ? 'sent' : 'sent_dev';
    db.prepare('UPDATE email_sends SET status = ? WHERE token = ?').run(status, token);
    contacts.logActivity(contactId, 'email_sent', `Email sent: "${renderedSubject}"`, { token, source });
    return { status, token };
  } catch (err) {
    db.prepare('UPDATE email_sends SET status = ?, error = ? WHERE token = ?').run('failed', err.message, token);
    contacts.logActivity(contactId, 'email_failed', `Email failed: "${renderedSubject}" (${err.message})`, { token });
    return { status: 'failed', error: err.message };
  }
}

// Plain internal notification (e.g. "new lead" alerts to sales); no tracking.
async function sendInternal(to, subject, html) {
  const settings = getSettings();
  await getTransport().sendMail({ from: settings.from_email, to, subject, html });
}

function getSend(token) { return parse(db.prepare('SELECT * FROM email_sends WHERE token = ?').get(token)); }

module.exports = { sendToContact, sendInternal, getSend, merge, BASE_URL, escapeHtml };
