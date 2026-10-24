// Vercel serverless function — sends a branded HTML Payment Confirmation via
// your own Gmail account (using an App Password), instead of a third-party
// email service. Free, no domain required.
//
// HANDOFF #004: the receipt shows how the payment was APPLIED (subscription / installation / prior balance /
// account credit) and the remaining balance. The Extension Granted notice shows the outstanding amount, the original
// due date and the new deadline -- never implying that payment was received.
//
// HANDOFF #002 Section 24: this is now TEMPLATE #4 — CENTERED STATUS CARD.
// A failed send here must never undo or change the recorded payment —
// index.html already calls this fire-and-forget AFTER saveData() succeeds,
// so that's already true; this file never has write access to app_state.
//
// Required Vercel environment variables (Project > Settings > Environment
// Variables — never put these directly in the code or commit them to GitHub):
//   GMAIL_USER          your full Gmail address, e.g. yourbusiness@example.com
//   GMAIL_APP_PASSWORD  the 16-character App Password from your Google Account
//                        (Security > 2-Step Verification > App Passwords)

import nodemailer from 'nodemailer';

const safe = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const money = (n) => { const v = Number(n) || 0; return 'PHP ' + v.toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }); };
const ROW = 'padding:8px 0;color:#5a5f6b;border-top:1px solid #e2e4e9;';
const VAL = 'padding:8px 0;text-align:right;font-weight:600;border-top:1px solid #e2e4e9;';
const row = (l, v, strong) => `<tr><td style="${ROW}">${l}</td><td style="${VAL}${strong ? 'font-weight:700;' : ''}">${v}</td></tr>`;

function logoMarkHtml(displayBusiness, logoUrl) {
  return /^https:\/\//.test(logoUrl || '')
    ? `<img src="${safe(logoUrl)}" alt="${safe(displayBusiness)}" style="width:48px;height:48px;border-radius:10px;object-fit:cover;margin:0 auto 10px;display:block;">`
    : `<div style="width:48px;height:48px;border-radius:10px;background:#e8f0fd;color:#184c9e;font-weight:700;font-size:17px;line-height:48px;text-align:center;margin:0 auto 10px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">SD</div>`;
}
function shell(displayBusiness, logoUrl, iconBg, iconColor, icon, titleColor, title, subBlock, rowsHtml, footer) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;background:#f4f5f7;">
    <div style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e4e9;text-align:center;">
      <div style="padding:28px 24px 20px;">
        ${logoMarkHtml(displayBusiness, logoUrl)}
        <div style="font-size:15px;font-weight:600;color:#171a21;">${safe(displayBusiness)}</div>
        <div style="width:52px;height:52px;border-radius:50%;background:${iconBg};color:${iconColor};line-height:52px;margin:18px auto 10px;font-size:24px;">${icon}</div>
        <div style="font-size:17px;font-weight:700;color:${titleColor};">${title}</div>
        ${subBlock}
      </div>
      <div style="padding:0 24px 24px;">
        <table style="width:100%;font-size:13px;color:#171a21;border-collapse:collapse;text-align:left;">${rowsHtml}</table>
      </div>
      <div style="padding:14px 24px;background:#f9fafb;font-size:11.5px;color:#8a8f9b;">${footer}</div>
    </div>
  </div>`;
}

// TEMPLATE #4 — CENTERED STATUS CARD: Extension Granted (extension information only; no payment implied)
export function buildExtensionHtml(p) {
  const displayBusiness = p.businessName || 'SignalDesk';
  const sub = `<div style="font-size:12.5px;color:#5a5f6b;margin-top:6px;">Please settle on or before</div><div style="font-size:24px;font-weight:700;color:#171a21;margin-top:2px;">${safe(p.extensionUntil || '-')}</div>`;
  const rows = row('Subscriber', safe(p.subscriberName)) + (p.accountUsername ? row('Account', safe(p.accountUsername)) : '') + row('Plan', safe(p.plan || '-'))
    + row('Outstanding amount', safe(money(p.amount)), true) + (p.originalDue ? row('Original due date', safe(p.originalDue)) : '') + row('Extension deadline', safe(p.extensionUntil || '-'));
  return shell(displayBusiness, p.logoUrl, '#e8f0fd', '#184c9e', '&#128197;', '#184c9e', 'Payment Extension Granted', sub, rows, `This is an automated message from ${safe(displayBusiness)}.`);
}

// TEMPLATE #4 — CENTERED STATUS CARD: Payment Confirmation / Installation Payment Received.
// Only ever sent for a payment that has already been recorded.
export function buildReceiptHtml(p) {
  const displayBusiness = p.businessName || 'SignalDesk';
  const b = p.breakdown || {};
  const onlyInstall = (b.installation || 0) > 0 && !(b.subscription || 0) && !(b.opening || 0);
  const title = onlyInstall ? 'Installation Payment Received' : 'Payment Confirmed';
  const sub = `<div style="font-size:24px;font-weight:700;color:#171a21;margin-top:6px;">${safe(money(p.amount))}</div>`;
  const rem = p.remainingOutstanding;
  const rows = row('Subscriber', safe(p.subscriberName)) + (p.accountUsername ? row('Account', safe(p.accountUsername)) : '') + row('Plan', safe(p.plan || '-'))
    + row('Payment date', safe(p.date || '-')) + (p.method ? row('Method', safe(p.method)) : '') + (p.reference ? row('Reference', safe(p.reference)) : '')
    + ((b.subscription || 0) > 0 ? row('Applied to monthly subscription', safe(money(b.subscription))) : '')
    + ((b.installation || 0) > 0 ? row('Applied to installation fee', safe(money(b.installation))) : '')
    + ((b.opening || 0) > 0 ? row('Applied to prior balance', safe(money(b.opening))) : '')
    + ((p.creditAdded || 0) > 0 ? row('Added to account credit', safe(money(p.creditAdded))) : '')
    + (typeof rem === 'number' ? row('Remaining balance', safe(money(rem)), true) : '');
  return shell(displayBusiness, p.logoUrl, '#e6f7ee', '#1a9e63', '&#10003;', '#1a9e63', title, sub, rows, `This is an automated receipt from ${safe(displayBusiness)}.`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const p = req.body || {};
  const { type, to, subscriberName, amount } = p;
  if (!to || !subscriberName || !(Number(amount) > 0)) {
    return res.status(400).json({ error: 'Missing required receipt fields' });
  }
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailAppPassword) {
    return res.status(500).json({ error: 'GMAIL_USER / GMAIL_APP_PASSWORD not configured on the server' });
  }
  const displayBusiness = p.businessName || 'SignalDesk';
  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false, // STARTTLS on port 587
      auth: { user: gmailUser, pass: gmailAppPassword }
    });
    const isExt = type === 'extension-granted';
    const info = await transporter.sendMail({
      from: `"${displayBusiness}" <${gmailUser}>`,
      to,
      subject: isExt ? `Payment extension granted — ${displayBusiness}` : `Payment confirmation — ${displayBusiness}`,
      html: isExt ? buildExtensionHtml(p) : buildReceiptHtml(p)
    });
    return res.status(200).json({ success: true, id: info.messageId });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send receipt', detail: String(err) });
  }
}
