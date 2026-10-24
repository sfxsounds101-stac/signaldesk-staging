// Vercel Cron function — runs once daily (see vercel.json for schedule).
//
// HANDOFF #003 hardening (on top of #002):
//   * every write to app_state is a compare-and-swap on updated_at with a
//     re-read/recompute retry, so this job can never silently overwrite a
//     save made by the app (or vice-versa) -- no schema change needed
//   * state changes are saved BEFORE emails are sent (at-most-once emails;
//     a Cron retry/duplicate run cannot re-send)
//   * Investor Report covers the PREVIOUS COMPLETED CALENDAR MONTH (Manila),
//     claimed via CAS so two simultaneous runs cannot both send it, and
//     lastSentPeriod is recorded only after a successful send
//   * GCash QR is attached inline via CID (data: images are blocked by Gmail)
//   * ?dry=1 (with the Cron secret) reports what WOULD happen, writing and
//     sending nothing -- for staging QA
//
// HANDOFF #004: billing now runs on the obligations ledger (BILL block below, identical to the copy in
// index.html). This job NEVER invents debt: legacy subscribers without a verified billing baseline are skipped
// (reported, not emailed). Every notice is claimed (saved) before sending, then marked sent/failed; failed sends
// retry on later days (max 3). ?dry=1 returns the full read-only report (no writes, no emails).
//
// HANDOFF #002 billing-lifecycle rewrite (superseded by the ledger rules above, kept for history):
//   Paid -> Pending                  the day after the recurring due date passes
//   Pending (5+ days, no extension)  -> status becomes Overdue + overdue email
//                                       (Template #5 warning; WARNING ONLY, never a
//                                       network action)
//   Extended, 1 day before deadline  -> Extension Reminder email (Template #3)
//   Extended, deadline passed unpaid -> Overdue + overdue email immediately (no
//                                       second grace period), with the extension
//                                       moved into extensionHistory, never deleted
//   Monthly Investor Report          -> sent on DATA.investorReport.sendOnDay if
//                                       enabled, using the same calculation as the
//                                       in-app Own/Investor/Overall dashboard
//
// Required Vercel environment variables (all already in place from earlier
// versions, nothing new to add):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  -- to read/write app_state
//                                                without a user session
//   GMAIL_USER, GMAIL_APP_PASSWORD           -- to send reminder emails
//   CRON_SECRET                              -- a random string you choose,
//                                                so this endpoint only runs
//                                                for Vercel's own scheduler

import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

const STATE_ROW_ID = 'main';

// All date math here is anchored to UTC explicitly (T00:00:00Z / setUTCDate
// / toISOString), rather than relying on the server's local timezone --
// Vercel functions commonly run with a UTC system clock, but that isn't a
// documented guarantee, so this avoids depending on it either way. "Today"
// is computed separately as the Philippines' calendar date (see
// todayManila() below), since that's the business's actual day, not UTC's.
function daysBetween(dateStr, today){
  const a = new Date(dateStr + 'T00:00:00Z');
  const b = new Date(today + 'T00:00:00Z');
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}
function addDaysStr(dateStr, n){
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// The Philippines does not observe daylight saving, so a fixed +8h offset
// from the current UTC instant is reliable year-round.
function todayManila(){
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function safe(v){
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// SIGNALDESK "SD" LOGO — the same mark used in the app's own sidebar/login
// screen (a colored rounded square with "SD", or the real uploaded business
// logo image if one is configured). Per Section 25, every approved template
// uses this, never an invented or generic Wi-Fi icon.
function logoHeaderHtml(businessName, logoUrl){
  const httpsLogo = /^https:\/\//.test(logoUrl || '') ? logoUrl : '';
  return httpsLogo
    ? `<img src="${safe(httpsLogo)}" alt="${safe(businessName)}" style="width:44px;height:44px;border-radius:10px;object-fit:cover;display:block;margin:0 auto 8px;">`
    : `<div style="width:44px;height:44px;border-radius:10px;background:#e8f0fd;color:#184c9e;font-weight:700;font-size:16px;line-height:44px;text-align:center;margin:0 auto 8px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">SD</div>`;
}

// GCash QR: stored in the app as a data: URI (same pattern as the logo), but
// Gmail and several other clients block data: images. Fix: decode it and send
// it as an INLINE CID attachment, which every major client renders.
const QR_CID = 'gcashqr@signaldesk';
export function qrAttachment(paymentInfo){
  const u = (paymentInfo && paymentInfo.gcashQrUrl) || '';
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(u);
  if (!m) return null; // not a valid raster data URI -> no image at all (never a broken one)
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  let content;
  try { content = Buffer.from(m[2].replace(/\s/g, ''), 'base64'); } catch (e) { return null; }
  if (!content.length) return null;
  return { filename: `gcash-qr.${ext}`, content, cid: QR_CID, contentType: `image/${m[1] === 'jpg' ? 'jpeg' : m[1]}`, contentDisposition: 'inline' };
}
export function gcashBlockHtml(paymentInfo, hasQrAttachment){
  paymentInfo = paymentInfo || {};
  const httpsQr = /^https:\/\//.test(paymentInfo.gcashQrUrl || '') ? paymentInfo.gcashQrUrl : '';
  const qrSrc = hasQrAttachment ? `cid:${QR_CID}` : httpsQr;
  const hasText = !!(paymentInfo.gcashName || paymentInfo.gcashNumber || paymentInfo.instructions);
  if (!qrSrc && !hasText) return ''; // nothing configured -> gracefully omit, never invent
  return `
    <div style="margin-top:16px;padding:14px;background:#f9fafb;border:1px solid #e2e4e9;border-radius:10px;text-align:center;">
      <div style="font-size:12px;color:#5a5f6b;font-weight:600;margin-bottom:8px;">Payment information</div>
      ${qrSrc ? `<img src="${safe(qrSrc)}" alt="GCash QR" width="120" height="120" style="width:120px;height:120px;object-fit:contain;margin:0 auto 8px;display:block;">` : ''}
      ${paymentInfo.gcashName ? `<div style="font-size:13px;color:#171a21;">${safe(paymentInfo.gcashName)}</div>` : ''}
      ${paymentInfo.gcashNumber ? `<div style="font-size:13px;color:#171a21;font-weight:600;">${safe(paymentInfo.gcashNumber)}</div>` : ''}
      ${paymentInfo.instructions ? `<div style="font-size:11.5px;color:#5a5f6b;margin-top:6px;">${safe(paymentInfo.instructions)}</div>` : ''}
    </div>`;
}

// ---- billing facts for emails (HANDOFF #004 Sec.13): real amounts and due dates from the ledger only ----
const php = (c) => 'PHP ' + Number(((c || 0) / 100).toFixed(2)).toLocaleString('en-PH', { minimumFractionDigits: (c % 100 === 0) ? 0 : 2 });
export function billingEmailData(s, today) {
  const items = BILL.unpaidBilled(s, today).filter((i) => i.kind === 'opening' || i.dueDate <= today);
  const sum = (k, f) => items.filter((i) => i.kind === k).reduce((a, i) => a + f(i), 0);
  const ctrl = BILL.controlling(s, today);
  const payableC = items.reduce((a, i) => a + BILL.remC(i), 0);
  const paidC = items.reduce((a, i) => a + BILL.paidC(i), 0);
  const remInstallC = s.billing.obligations.filter((i) => i.kind === 'installation').reduce((a, i) => a + BILL.remC(i), 0);
  return {
    subscriptionC: sum('subscription', (i) => i.amountC), installationC: sum('installation', (i) => i.amountC),
    priorBalanceC: sum('opening', (i) => i.amountC),             // only VERIFIED opening debt exists as an item
    appliedC: paidC, totalC: payableC, dueDate: ctrl ? ctrl.dueDate : null, remainingInstallationC: remInstallC,
    extensionUntil: ctrl && ctrl.ext && !ctrl.ext.resolution ? ctrl.ext.until : null
  };
}
function billRowsHtml(d, deadlineLabel, deadline) {
  const r = (l, v, strong) => `<tr style="border-top:1px solid #e2e4e9;"><td style="padding:7px 0;color:#5a5f6b;">${l}</td><td style="padding:7px 0;text-align:right;${strong ? 'font-weight:700;' : 'font-weight:600;'}">${v}</td></tr>`;
  return [
    d.subscriptionC ? r('Monthly subscription', php(d.subscriptionC)) : '',
    d.installationC ? r('Installation installment', php(d.installationC)) : '',
    d.priorBalanceC ? r('Prior balance (verified)', php(d.priorBalanceC)) : '',
    d.appliedC ? r('Payments &amp; credit applied', '− ' + php(d.appliedC)) : '',
    r('Total amount payable', php(d.totalC), true),
    d.dueDate ? r('Due date', safe(d.dueDate)) : '',
    deadline ? r(deadlineLabel, safe(deadline), true) : '',
    d.remainingInstallationC ? r('Remaining installation balance', php(d.remainingInstallationC)) : ''
  ].join('');
}
function cardShell(inner, businessName, logoUrl, subtitle) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:460px;margin:0 auto;padding:24px;background:#f4f5f7;">
    <div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e4e9;">
      <div style="padding:22px 24px 14px;text-align:center;border-bottom:1px solid #e2e4e9;">
        ${logoHeaderHtml(businessName, logoUrl)}
        <div style="font-size:16px;font-weight:700;color:#171a21;">${safe(businessName)}</div>
        <div style="font-size:12.5px;color:#5a5f6b;margin-top:2px;">${subtitle}</div>
      </div>
      <div style="padding:20px 24px;">${inner}</div>
      <div style="padding:12px 24px;background:#f9fafb;text-align:center;font-size:11px;color:#8a8f9b;">This is an automated message from ${safe(businessName)}.</div>
    </div>
  </div>`;
}
// TEMPLATE #3 — MINIMAL STATEMENT (Pending Reminder / Extension Reminder)
export function templateMinimalStatement({ businessName, logoUrl, subscriberName, accountUsername, plan, bill, status, isExtensionReminder, paymentInfo, hasQr }) {
  const message = isExtensionReminder
    ? `This is a reminder that your approved payment extension ends tomorrow (${safe(bill.extensionUntil)}).`
    : `This is a friendly reminder that your payment is now due. Please settle your balance at your earliest convenience.`;
  const inner = `
        <p style="font-size:13.5px;color:#171a21;margin:0 0 14px;">Hi ${safe(subscriberName)}, ${message}</p>
        <table style="width:100%;font-size:13px;color:#171a21;border-collapse:collapse;">
          ${accountUsername ? `<tr><td style="padding:7px 0;color:#5a5f6b;">Account</td><td style="padding:7px 0;text-align:right;font-weight:600;">${safe(accountUsername)}</td></tr>` : ''}
          <tr style="border-top:1px solid #e2e4e9;"><td style="padding:7px 0;color:#5a5f6b;">Plan</td><td style="padding:7px 0;text-align:right;font-weight:600;">${safe(plan || '-')}</td></tr>
          ${billRowsHtml(bill, 'Extension deadline', isExtensionReminder ? bill.extensionUntil : null)}
          <tr style="border-top:1px solid #e2e4e9;"><td style="padding:7px 0;color:#5a5f6b;">Status</td><td style="padding:7px 0;text-align:right;font-weight:600;">${safe(status || '-')}</td></tr>
        </table>
        ${gcashBlockHtml(paymentInfo, hasQr)}`;
  return cardShell(inner, businessName, logoUrl, isExtensionReminder ? 'Payment Extension Reminder' : 'Payment Reminder');
}
// TEMPLATE #5 — COMPACT MOBILE-FIRST (Overdue / Service Disconnection Warning). WARNING ONLY.
export function templateDisconnectionWarning({ businessName, logoUrl, subscriberName, accountUsername, bill, paymentInfo, hasQr }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:380px;margin:0 auto;padding:16px;background:#f4f5f7;">
    <div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e4e9;">
      <div style="padding:16px;text-align:center;background:#fbe9e8;">
        ${logoHeaderHtml(businessName, logoUrl)}
        <div style="font-size:14px;font-weight:700;color:#d0392f;">Payment Overdue — Disconnection Warning</div>
      </div>
      <div style="padding:16px;">
        <p style="font-size:13px;color:#171a21;margin:0 0 10px;">Hi ${safe(subscriberName)}, your account${accountUsername ? (' (' + safe(accountUsername) + ')') : ''} is now <strong>overdue</strong> and may be subject to service disconnection if payment is not settled soon.</p>
        <table style="width:100%;font-size:13px;color:#171a21;border-collapse:collapse;">${billRowsHtml(bill, '', null)}</table>
        ${gcashBlockHtml(paymentInfo, hasQr)}
        <p style="font-size:11px;color:#8a8f9b;margin:12px 0 0;">This is a warning only — your service has not been disconnected.</p>
      </div>
    </div>
  </div>`;
}

/* TOTALS-BEGIN (single source of truth; copied verbatim into index.html, api/daily-status-check.js and api/sync-sheets.js — tests assert the three copies are identical) */
function computeOwnershipTotals(data, period){
  // period: null = all-time, or { from:'YYYY-MM-DD', to:'YYYY-MM-DD' } inclusive.
  data = data || {};
  var inP = function(d){ if(!period) return true; return !!d && d >= period.from && d <= period.to; };
  var subs = (data.subscribers||[]).filter(function(s){ return !s.permanentlyDeleted; });
  var active = subs.filter(function(s){ return !s.archived; });
  var counts = { own:0, investor:0, unassigned:0, overall:active.length };
  active.forEach(function(s){ counts[(s.ownership==='own'||s.ownership==='investor') ? s.ownership : 'unassigned']++; });
  var revenue = { own:0, investor:0, unassigned:0, overall:0 };
  var expenses = { own:0, investor:0, unclassified:0, overall:0 };
  (data.payments||[]).forEach(function(p){
    if(!inP(p.date)) return;
    var a = Number(p.amount)||0;
    revenue.overall += a;
    if(p.ownership==='own') revenue.own += a;
    else if(p.ownership==='investor') revenue.investor += a;
    else revenue.unassigned += a; // legacy (no snapshot) or explicitly unassigned -- never guessed
  });
  (data.expenses||[]).filter(function(e){ return !e.voided; }).forEach(function(e){
    if(!inP(e.date)) return;
    var a = Number(e.amount)||0;
    expenses.overall += a;
    if(e.allocation){ expenses.own += Number(e.allocation.own)||0; expenses.investor += Number(e.allocation.investor)||0; }
    else expenses.unclassified += a; // legacy expense with no allocation snapshot
  });
  return {
    period: period || null,
    counts: counts, revenue: revenue, expenses: expenses,
    net: { own: revenue.own-expenses.own, investor: revenue.investor-expenses.investor, overall: revenue.overall-expenses.overall }
  };
}
function monthPeriod(key){ // 'YYYY-MM' -> inclusive period
  var y = Number(key.slice(0,4)), m = Number(key.slice(5,7));
  var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { key: key, from: key+'-01', to: key+'-'+(last<10 ? '0'+last : ''+last) };
}
function prevMonthPeriod(todayStr){ // todayStr = Manila calendar date 'YYYY-MM-DD' -> previous completed month
  var y = Number(todayStr.slice(0,4)), m = Number(todayStr.slice(5,7));
  var py = (m===1) ? y-1 : y, pm = (m===1) ? 12 : m-1;
  return monthPeriod(py+'-'+(pm<10 ? '0'+pm : ''+pm));
}
function activityMonthKeys(data){
  var seen = {};
  (data.payments||[]).forEach(function(p){ if(p.date) seen[p.date.slice(0,7)] = 1; });
  (data.expenses||[]).filter(function(e){ return !e.voided; }).forEach(function(e){ if(e.date) seen[e.date.slice(0,7)] = 1; });
  return Object.keys(seen).sort();
}
/* TOTALS-END */

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
export function periodLabel(period){
  return `${MONTH_NAMES[Number(period.key.slice(5,7)) - 1]} ${period.key.slice(0,4)} (${period.from} to ${period.to})`;
}
export function investorReportEmailHtml({ businessName, logoUrl, period, totals }){
  const row = (label, v) => `<tr style="border-top:1px solid #e2e4e9;"><td style="padding:7px 0;color:#5a5f6b;">${label}</td><td style="padding:7px 0;text-align:right;font-weight:600;">${v}</td></tr>`;
  const peso = (n) => 'PHP ' + Number(n || 0).toLocaleString('en-PH');
  const empty = totals.revenue.investor === 0 && totals.expenses.investor === 0;
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:460px;margin:0 auto;padding:24px;background:#f4f5f7;">
    <div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e4e9;">
      <div style="padding:22px 24px 14px;text-align:center;border-bottom:1px solid #e2e4e9;">
        ${logoHeaderHtml(businessName, logoUrl)}
        <div style="font-size:16px;font-weight:700;color:#171a21;">${safe(businessName)}</div>
        <div style="font-size:12.5px;color:#5a5f6b;margin-top:2px;">Monthly Investor Report</div>
        <div style="font-size:13px;font-weight:600;color:#171a21;margin-top:6px;">${safe(periodLabel(period))}</div>
      </div>
      <div style="padding:20px 24px;">
        <table style="width:100%;font-size:13px;color:#171a21;border-collapse:collapse;">
          ${row('Investor subscribers (current)', totals.counts.investor)}
          ${row('Investor revenue', peso(totals.revenue.investor))}
          ${row('Investor allocated expenses', peso(totals.expenses.investor))}
          ${row('Investor net', peso(totals.net.investor))}
        </table>
        ${empty ? '<p style="font-size:12px;color:#5a5f6b;margin:12px 0 0;">No Investor revenue or expenses were recorded in this period.</p>' : ''}
      </div>
      <div style="padding:12px 24px;background:#f9fafb;text-align:center;font-size:11px;color:#8a8f9b;">
        Covers payments and expenses dated within the period above only. Automated report from ${safe(businessName)}.
      </div>
    </div>
  </div>`;
}

/* ---------- compare-and-swap helper (HANDOFF #003 Correction #003) ----------
   Reads the row, lets `mutate` change a private copy, and writes it back only
   if updated_at is unchanged. On conflict it re-reads and RE-RUNS mutate on
   the fresh data (so nothing stale is ever written). */
async function casUpdate(admin, mutate, maxTries = 5) {
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const { data: row, error } = await admin.from('app_state').select('data, updated_at').eq('id', STATE_ROW_ID).single();
    if (error || !row || !row.data || !Array.isArray(row.data.subscribers)) return { ok: false, reason: 'no-valid-state' };
    const state = JSON.parse(JSON.stringify(row.data));
    const out = mutate(state);
    if (!out || !out.changed) return { ok: true, written: false, out, state };
    const { data: upd, error: werr } = await admin.from('app_state')
      .update({ data: state, updated_at: new Date().toISOString() })
      .eq('id', STATE_ROW_ID).eq('updated_at', row.updated_at).select('updated_at');
    if (werr) return { ok: false, reason: 'write-error', detail: werr.message };
    if (upd && upd.length) return { ok: true, written: true, out, state };
    // conflict -> loop: re-read and recompute
  }
  return { ok: false, reason: 'conflict-retries-exhausted' };
}

function pushAudit(state, text) {
  if (!state.auditLog) state.auditLog = [];
  state.auditLog.unshift({ text, by: 'System', at: new Date().toISOString() });
  if (state.auditLog.length > 200) state.auditLog.length = 200;
}

/* BILLING-BEGIN (single source of truth for billing math; copied verbatim into index.html, api/daily-status-check.js, api/sync-sheets.js; tests assert identical copies) */
var BILL = (function(){
  var OVERDUE_AFTER_DAYS = 5, STALE_DAYS = 45, MAX_BACKLOG_DAYS = 1100;
  function pad(n){ return n<10 ? '0'+n : ''+n; }
  function parse(d){ return { y:+d.slice(0,4), m:+d.slice(5,7), d:+d.slice(8,10) }; }
  function fmt(y,m,d){ return y+'-'+pad(m)+'-'+pad(d); }
  function dim(y,m){ return new Date(Date.UTC(y,m,0)).getUTCDate(); }
  function dueFor(bd,y,m){ return fmt(y,m,Math.min(bd,dim(y,m))); }
  function addMonths(y,m,n){ var t=y*12+(m-1)+n; return { y:Math.floor(t/12), m:(t%12)+1 }; }
  function dayNum(d){ var p=parse(d); return Math.round(Date.UTC(p.y,p.m-1,p.d)/86400000); }
  function daysBetween(a,b){ return dayNum(b)-dayNum(a); }
  function addDays(d,n){ var t=new Date((dayNum(d)+n)*86400000); return fmt(t.getUTCFullYear(),t.getUTCMonth()+1,t.getUTCDate()); }
  function dueAfter(bd,d){ var p=parse(d), n=addMonths(p.y,p.m,1); return dueFor(bd,n.y,n.m); }
  function nextDueOnOrAfter(bd,today){ var p=parse(today), c=dueFor(bd,p.y,p.m); if(c>=today) return c; var n=addMonths(p.y,p.m,1); return dueFor(bd,n.y,n.m); }
  function dayOf(d){ return d ? parse(d).d : null; }
  function toC(n){ var v=Math.round(Number(n)*100); return isFinite(v) ? v : 0; }
  function fromC(c){ return (c||0)/100; }
  function splitThree(totalC){ var b=Math.floor(totalC/3); return [b,b,totalC-2*b]; }  // remainder -> last installment
  function paidC(it){ var s=0; (it.applied||[]).forEach(function(a){ s+=a.c; }); return s; }
  function remC(it){ return it.amountC - paidC(it); }
  function find(b,id){ for(var i=0;i<b.obligations.length;i++) if(b.obligations[i].id===id) return b.obligations[i]; return null; }
  function frozen(s){ return s.status==='disconnected' || s.archived || s.permanentlyDeleted; }
  function limitOf(b,today){ return b.billingDay ? nextDueOnOrAfter(b.billingDay,today) : today; }
  function billed(b,it,today){ return it.kind==='opening' || it.dueDate <= limitOf(b,today); }

  function newBilling(o){
    return { v:1, billingDay:o.billingDay||null, firstDue:o.firstDue||null, review:!!o.review,
      opening:{ state:(o.openingState||'none') },            // none | verified-zero | verified-positive | unverified
      obligations:[], creditC:0, installation:null, extensionLog:[], migration:o.migration||null };
  }
  function setOpening(s,state,amountC,today,by){
    var b=s.billing; b.opening.state=state;
    var ex=find(b,'opening:1');
    if(state==='verified-positive' && amountC>0){
      if(ex){ if(paidC(ex)>0) return {ok:false,error:'Opening balance already has payments applied'}; ex.amountC=amountC; }
      else b.obligations.unshift({ id:'opening:1', kind:'opening', dueDate:null, amountC:amountC, applied:[], notified:{}, at:today, by:by||null });
    } else if(ex){ if(paidC(ex)>0) return {ok:false,error:'Opening balance already has payments applied'}; b.obligations.splice(b.obligations.indexOf(ex),1); }
    return {ok:true};
  }
  // ---- Rate history (T2): effective-dated, stored in s.billing.rateHistory = [{from,rateC,at,by,basis}] ----
  // A charge uses the rate in force on its due date. Without a recorded rate for a PAST period the amount is NOT inferred:
  // the charge carries rateReview (placeholder = current rate) and no notice is sent until the operator confirms the amount.
  function rateEntries(b){ return (b.rateHistory||[]).slice().sort(function(x,y){ return x.from<y.from?-1:x.from>y.from?1:0; }); }
  function rateFor(s,date,today){
    var e=rateEntries(s.billing), hit=null; e.forEach(function(x){ if(x.from<=date) hit=x; });
    if(hit) return {c:hit.rateC,known:true};
    return {c:toC(s.rate),known:date>=today};
  }
  function seedRate(s,from,basis,by){ var b=s.billing; if(!b) return; if(!b.rateHistory) b.rateHistory=[];
    if(!b.rateHistory.length){ b.rateHistory.push({from:from,rateC:toC(s.rate),at:from,by:by||null,basis:basis||'baseline'}); b.lastRateC=toC(s.rate); } }
  // Record a rate change with an effective date (today or later). Already-generated charges are never changed.
  function setRate(s,newRate,from,today,by){
    var b=s.billing; var nc=toC(newRate);
    if(!(nc>0)) return {ok:false,error:'Rate must be greater than zero'};
    if(!b) { s.rate=Number(newRate); return {ok:true,noBilling:true}; }
    from=from||today; if(from<today) return {ok:false,error:'Effective date cannot be in the past'};
    if(!b.rateHistory||!b.rateHistory.length) seedRate(s,(b.firstDue&&b.firstDue<today)?b.firstDue:today,'baseline-prior-rate',by);
    var cur=rateFor(s,from,today);
    if(cur.c===nc && b.rateHistory.every(function(x){ return x.from<=from; })) return {ok:true,unchanged:true};
    b.rateHistory=b.rateHistory.filter(function(x){ return x.from!==from; });
    b.rateHistory.push({from:from,rateC:nc,at:today,by:by||null,basis:'change'});
    s.rate=fromC(rateFor(s,today,today).c); b.lastRateC=toC(s.rate);
    return {ok:true,effectiveFrom:from};
  }
  function pendingRateChange(s,today){ var b=s.billing; if(!b) return null; var f=rateEntries(b).filter(function(x){ return x.from>today; }); return f.length?f[0]:null; }
  // s.rate edited outside setRate: record it (effective today) instead of silently re-pricing history.
  // b.lastRateC = the value this module last wrote to s.rate; anything else in s.rate is an operator edit.
  function syncRate(s,today){
    var b=s.billing; if(!b||!b.rateHistory||!b.rateHistory.length) return;
    var eff=rateFor(s,today,today).c; if(b.lastRateC===undefined) b.lastRateC=eff;
    if(toC(s.rate)!==b.lastRateC){ setRate(s,s.rate,today,today,'untracked-edit'); return; }
    if(eff!==b.lastRateC){ s.rate=fromC(eff); b.lastRateC=eff; }
  }
  function resolveRateReview(s,itemId,amountC,by,today){
    var b=s.billing, it=b&&find(b,itemId); if(!it||!it.rateReview) return {ok:false,error:'No rate review pending for this charge'};
    if(!(amountC>0)) return {ok:false,error:'Amount must be greater than zero'}; if(paidC(it)>amountC) return {ok:false,error:'Amount is below what is already applied'};
    it.rateConfirmed={at:today,by:by||null,placeholderC:it.rateReview.placeholderC,c:amountC}; it.amountC=amountC; delete it.rateReview; applyCredit(s,today); return {ok:true};
  }
  function rateReviews(s){ var b=s.billing; return b?b.obligations.filter(function(i){ return i.rateReview&&remC(i)>0; }):[]; }
  function generate(s,today){
    var b=s.billing, added=[]; if(!b||b.review||!b.firstDue||!b.billingDay||frozen(s)) return {added:added};
    var limit=nextDueOnOrAfter(b.billingDay,today);
    if(daysBetween(b.firstDue,limit)>MAX_BACKLOG_DAYS){ b.review=true; return {added:added,flagged:true}; }
    var d=b.firstDue, g=0;
    if(b.resumeFrom){ while(d<b.resumeFrom && g++<400) d=dueAfter(b.billingDay,d); g=0; }
    while(d<=limit && g++<130){
      var id='sub:'+d.slice(0,7);
      if(!find(b,id)){ var rf=rateFor(s,d,today); var it={ id:id, kind:'subscription', dueDate:d, amountC:rf.c, applied:[], ext:null, notified:{} };
        if(!rf.known) it.rateReview={reason:'No recorded rate for this service period',placeholderC:rf.c,flaggedAt:today};
        b.obligations.push(it); added.push(it); }
      d=dueAfter(b.billingDay,d);
    }
    return {added:added};
  }
  function order(a,b){ var ao=a.kind==='opening'?0:1, bo=b.kind==='opening'?0:1; if(ao!==bo) return ao-bo;
    if(a.dueDate!==b.dueDate) return a.dueDate<b.dueDate?-1:1; var ak=a.kind==='subscription'?0:1, bk=b.kind==='subscription'?0:1; return ak-bk; }
  function unpaidBilled(s,today){ var b=s.billing; return b.obligations.filter(function(it){ return billed(b,it,today)&&remC(it)>0&&!it.rateReview; }).sort(order); }
  function applyAmount(s,amountC,src,today,at){
    var out=[], left=amountC;
    unpaidBilled(s,today).forEach(function(it){ if(left<=0) return; var c=Math.min(left,remC(it)); it.applied.push({src:src,c:c,at:at||today}); left-=c; out.push({itemId:it.id,kind:it.kind,c:c}); });
    return {allocations:out,leftC:left};
  }
  function applyCredit(s,today){ var b=s.billing; if(!b||b.creditC<=0) return []; var r=applyAmount(s,b.creditC,'credit',today); b.creditC=r.leftC; return r.allocations; }
  // Records a received payment. Cash -> oldest billed items first; excess -> credit (never discarded).
  function recordPayment(s,amountC,paymentId,today){
    if(!s.billing) return {ok:false,error:'Subscriber has no billing record'};
    if(!(amountC>0)) return {ok:false,error:'Amount must be greater than zero'};
    generate(s,today);
    var r=applyAmount(s,amountC,'pay:'+paymentId,today);
    s.billing.creditC+=r.leftC;
    resolveExtensions(s,today);
    return {ok:true,allocations:r.allocations,creditAddedC:r.leftC};
  }
  function subStatus(it,today){
    if(remC(it)<=0) return 'paid';
    var d=daysBetween(it.dueDate,today);
    if(it.ext && !it.ext.resolution){ if(it.ext.until>=today) return 'extended'; if(d>=1) return 'overdue'; }
    if(d<0) return 'current'; if(d===0) return 'due';
    return d<1+OVERDUE_AFTER_DAYS ? 'pending' : 'overdue';
  }
  function controlling(s,today){ var b=s.billing; if(!b) return null; var l=unpaidBilled(s,today).filter(function(i){return i.kind==='subscription';}); return l.length?l[0]:null; }
  function accountStatus(s,today){
    if(s.status==='disconnected') return 'disconnected';
    if(s.archived||s.permanentlyDeleted) return 'archived';
    var b=s.billing; if(!b) return 'current';
    if(b.review) return 'review';
    var c=controlling(s,today); return c ? subStatus(c,today) : 'current';
  }
  function nextDue(s,today){
    var b=s.billing; if(!b||!b.billingDay) return null; var c=controlling(s,today); if(c) return c.dueDate;
    var subs=b.obligations.filter(function(i){return i.kind==='subscription';}).sort(order); if(!subs.length) return b.firstDue;
    return dueAfter(b.billingDay,subs[subs.length-1].dueDate);
  }
  // HQ D6 definitions: billed outstanding = every GENERATED unpaid item (incl. verified opening, incl. not-yet-due);
  // due now = due date <= today (+ verified opening); past due = due date < today; future scheduled = generated but not yet due.
  function summary(s,today){
    var b=s.billing; if(!b) return null;
    var r={pendingRateC:0,subscriptionC:0,installationC:0,openingC:0,pastDueC:0,dueNowC:0,futureC:0,creditC:b.creditC||0,outstandingC:0};
    b.obligations.forEach(function(it){ if(!billed(b,it,today)) return; var m=remC(it); if(m<=0) return;
      if(it.rateReview){ r.pendingRateC+=m; return; } // HQ D3: unverified rate amounts are shown separately, never as confirmed receivables
      if(it.kind==='subscription') r.subscriptionC+=m; else if(it.kind==='installation') r.installationC+=m; else r.openingC+=m;
      if(!it.dueDate){ r.dueNowC+=m; } else { if(it.dueDate<today) r.pastDueC+=m; if(it.dueDate<=today) r.dueNowC+=m; else r.futureC+=m; } });
    r.outstandingC=r.subscriptionC+r.installationC+r.openingC; r.netPayableC=Math.max(0,r.outstandingC-r.creditC); r.netDueNowC=Math.max(0,r.dueNowC-r.creditC);
    return r;
  }
  // Receivables + cash split by ownership for the dashboard/Sheets (billing records only; review/unverified excluded and counted)
  function receivables(data,today){
    var out={ own:0, investor:0, unassigned:0, total:0, dueNow:0, pastDue:0, future:0, credit:0, unreviewed:0, pendingRate:0, byKind:{subscription:0,installation:0,opening:0} };
    (data.subscribers||[]).forEach(function(s){ if(s.permanentlyDeleted||s.archived) return; if(!s.billing||s.billing.review){ if(s.billing&&s.billing.review) out.unreviewed++; return; }
      var m=summary(s,today); if(!m) return; var k=(s.ownership==='own'||s.ownership==='investor')?s.ownership:'unassigned';
      out[k]+=m.outstandingC; out.total+=m.outstandingC; out.dueNow+=m.dueNowC; out.pastDue+=m.pastDueC; out.future+=m.futureC; out.credit+=m.creditC; out.pendingRate+=m.pendingRateC;
      out.byKind.subscription+=m.subscriptionC; out.byKind.installation+=m.installationC; out.byKind.opening+=m.openingC; });
    return out;
  }
  // Cash collected split by what it was applied to (from payment allocations). Legacy payments w/o allocations = 'legacy'.
  function collectionsByKind(data,period){
    var r={subscription:0,installation:0,opening:0,credit:0,legacy:0};
    (data.payments||[]).forEach(function(p){ if(period && !(p.date>=period.from&&p.date<=period.to)) return; var a=Math.round((Number(p.amount)||0)*100);
      if(!p.allocations){ r.legacy+=a; return; } var used=0; p.allocations.forEach(function(x){ r[x.kind]=(r[x.kind]||0)+x.c; used+=x.c; }); r.credit+=Math.max(0,a-used); });
    return r;
  }
  // charge breakdown for a due date (calendar + emails): subscription + installation components stay separate
  function breakdownFor(s,it,today){
    var b=s.billing, rows=[]; b.obligations.forEach(function(x){ if(x.dueDate===it.dueDate && remC(x)>0 && !x.rateReview) rows.push({kind:x.kind,id:x.id,amountC:x.amountC,remainingC:remC(x)}); });
    return rows.sort(function(a,c){ return (a.kind==='subscription'?0:1)-(c.kind==='subscription'?0:1); });
  }
  function installmentSchedule(totalC,arrangement,connectionDate,billingDay,rateC){
    var bd=billingDay||dayOf(connectionDate), d1=dueAfter(bd,connectionDate), rows=[];
    if(arrangement==='full'){
      rows.push({date:connectionDate,subscriptionC:0,installationC:totalC,totalC:totalC,label:'Installation fee due upon connection'});
      rows.push({date:d1,subscriptionC:rateC,installationC:0,totalC:rateC,label:'First postpaid subscription'});
    } else {
      var parts=splitThree(totalC), d=d1;
      for(var i=0;i<3;i++){ rows.push({date:d,subscriptionC:rateC,installationC:parts[i],totalC:rateC+parts[i],label:'Installment '+(i+1)+' of 3'}); d=dueAfter(bd,d); }
      rows.push({date:d,subscriptionC:rateC,installationC:0,totalC:rateC,label:'Subscription only'});
    }
    return rows;
  }
  // New subscriber onboarding (postpaid): billing day = connection day; first subscription due one month later.
  function onboardNew(s,o){ // o:{connectionDate, today, installation:{totalC,arrangement}|null}
    var bd=dayOf(o.connectionDate), first=dueAfter(bd,o.connectionDate);
    s.connectionDate=o.connectionDate; s.billing=newBilling({billingDay:bd,firstDue:first,openingState:'none'});
    var b=s.billing;
    if(o.installation && o.installation.totalC>0){
      var t=o.installation.totalC, arr=o.installation.arrangement, ids=[];
      if(arr==='full'){ b.obligations.push({id:'inst:full',kind:'installation',dueDate:o.connectionDate,amountC:t,applied:[],notified:{}}); ids.push('inst:full'); }
      else { var p=splitThree(t), d=first; for(var i=0;i<3;i++){ b.obligations.push({id:'inst:'+(i+1),kind:'installation',dueDate:d,amountC:p[i],applied:[],notified:{}}); ids.push('inst:'+(i+1)); d=dueAfter(bd,d); } }
      b.installation={ totalC:t, paymentArrangement:arr, createdAt:o.today, connectionDate:o.connectionDate, itemIds:ids };
    }
    seedRate(s,o.connectionDate<o.today?o.connectionDate:o.today,'onboarding');
    generate(s,o.today); return s;
  }
  // Existing subscriber being registered now: no retroactive charges. Next due = next billing date.
  function onboardExisting(s,o){ // o:{connectionDate, billingDay?, today, opening:{state,amountC}}
    var bd=o.billingDay||dayOf(o.connectionDate), first=nextDueOnOrAfter(bd,o.today);
    s.connectionDate=o.connectionDate||null;
    s.billing=newBilling({billingDay:bd,firstDue:first,openingState:(o.opening&&o.opening.state)||'unverified'});
    if(o.opening && o.opening.state==='verified-positive') setOpening(s,'verified-positive',o.opening.amountC,o.today);
    seedRate(s,o.today,'onboarding-existing');
    generate(s,o.today); return s;
  }
  // Legacy record (no s.billing). HQ D1: EVERY ambiguous legacy record needs operator verification of the billing
  // baseline, however recent its `due` looks. Nothing is guessed, charged, notified or reset; legacy fields are preserved.
  function migrateLegacy(s,today){
    if(s.billing) return {action:'none'};
    var mig={at:today,from:{due:s.due||null,status:s.status||null}};
    if(s.status==='disconnected'||s.archived||s.permanentlyDeleted){ s.billing=newBilling({billingDay:dayOf(s.due),firstDue:null,migration:mig}); return {action:'inactive'}; }
    s.billing=newBilling({billingDay:dayOf(s.due),review:true,migration:mig});
    return {action:'review',reason:s.due?'billing baseline not verified (stored due date '+s.due+')':'no stored due date'};
  }
  // Suggested (NEVER auto-applied) baseline for the batch-review screen.
  function reviewSuggestion(s,today){
    var bd=(s.billing&&s.billing.billingDay)||dayOf(s.due)||null; if(!bd) return {billingDay:null,firstDue:null,note:'No due date on file'};
    var next=nextDueOnOrAfter(bd,today), first=next, note='Suggested: next billing date (no back-charges)';
    if(s.due && (s.status==='pending'||s.status==='overdue') && daysBetween(s.due,today)>=0 && daysBetween(s.due,today)<=92){ first=s.due; note='Legacy status '+s.status+': suggested first unpaid due '+s.due; }
    return {billingDay:bd,firstDue:first,note:note};
  }
  // Operator confirms a quarantined record. firstDue defaults to the next billing date (no back-charges).
  function resolveReview(s,o){ // o:{today, billingDay?, firstDue?, connectionDate?, opening:{state,amountC}}
    var b=s.billing; if(!b||!b.review) return {ok:false,error:'Record is not awaiting review'};
    var bd=o.billingDay||b.billingDay; if(!bd) return {ok:false,error:'Billing day required'};
    var first=o.firstDue||nextDueOnOrAfter(bd,o.today);
    if(daysBetween(first,o.today)>MAX_BACKLOG_DAYS) return {ok:false,error:'First billed due date is too far in the past'};
    b.billingDay=bd; b.firstDue=first; b.review=false; if(o.connectionDate) s.connectionDate=o.connectionDate;
    b.opening.state=(o.opening&&o.opening.state)||'unverified';
    if(o.opening && o.opening.state==='verified-positive'){ var r=setOpening(s,'verified-positive',o.opening.amountC,o.today); if(!r.ok) return r; }
    seedRate(s,first<o.today?first:o.today,'operator-review',o.by);
    var g=generate(s,o.today);
    if(o.suppressPast!==false){ (g.added||[]).forEach(function(it){ if(it.dueDate<o.today){ it.notified['pending:'+it.id]='review'; it.notified['overdue:'+it.id]='review'; } }); }
    b.review=false; b.reviewedAt=o.today; b.reviewedBy=o.by||null; return {ok:true,generated:(g.added||[]).length};
  }
  function grantExtension(s,itemId,until,today,reason,by){
    var b=s.billing, it=b&&find(b,itemId);
    if(!it||it.kind!=='subscription'||remC(it)<=0) return {ok:false,error:'No unpaid subscription obligation to extend'};
    if(!until||until<today) return {ok:false,error:'Extension deadline must be today or later'};
    if(until<=it.dueDate) return {ok:false,error:'Extension deadline must be after the due date'};
    if(it.ext && !it.ext.resolution) b.extensionLog.push(Object.assign({itemId:it.id,resolution:'replaced',resolvedAt:today},it.ext));
    it.ext={grantedAt:today,until:until,reason:reason||'',by:by||null,originalDue:it.dueDate,resolution:null};
    return {ok:true,item:it};
  }
  function resolveExtensions(s,today){
    var b=s.billing; if(!b) return; b.obligations.forEach(function(it){
      if(!it.ext||it.ext.resolution) return;
      if(remC(it)<=0){ it.ext.resolution='paid'; it.ext.resolvedAt=today; b.extensionLog.push(Object.assign({itemId:it.id},it.ext)); }
      else if(it.ext.until<today){ it.ext.resolution='expired'; it.ext.resolvedAt=today; b.extensionLog.push(Object.assign({itemId:it.id},it.ext)); } });
  }
  // Reconnect after a manual disconnect: unpaid pre-disconnect balances are preserved; NO charges are created for the
  // disconnected period -- billing resumes from the next billing date.
  function reconnect(s,today){
    var b=s.billing; if(!b||!b.billingDay) return {ok:false,error:'No billing record'};
    if(!b.firstDue){ b.review=true; return {ok:true,needsReview:true}; } // legacy disconnected record: baseline never verified
    seedRate(s,today,'reconnect'); syncRate(s,today);
    b.resumeFrom=nextDueOnOrAfter(b.billingDay,today); if(!b.firstDue||b.firstDue<b.resumeFrom){ b.firstDue=b.firstDue||b.resumeFrom; }
    return {ok:true,resumeFrom:b.resumeFrom};
  }
  // Notification events for TODAY. Only the oldest unpaid subscription obligation controls escalation (no spam).
  // Unpaid installation installments never escalate (not authorized yet) but are included in amounts.
  // A marker is a claim written BEFORE sending (at-most-once). A FAILED send may be retried on a later day (max 3 attempts);
  // 'claimed' (crash mid-send) and 'sent' are never re-sent.
  var MAX_ATTEMPTS = 3, MAX_MANUAL_RETRIES = 3;
  function open_(n,key,today){ var m=n[key]; if(!m) return true; if(typeof m==='string') return false; return m.status==='failed' && (m.attempts||1)<MAX_ATTEMPTS && m.at<today; }
  function events(s,today){
    var out=[]; if(!s.billing||s.billing.review||frozen(s)) return out;
    var c=controlling(s,today); if(!c) return out; var st=subStatus(c,today), n=c.notified||{};
    if(st==='pending'&&open_(n,'pending:'+c.id,today)) out.push({key:'pending:'+c.id,type:'pending',itemId:c.id});
    if(st==='overdue'&&open_(n,'overdue:'+c.id,today)) out.push({key:'overdue:'+c.id,type:'overdue',itemId:c.id});
    if(st==='extended'&&c.ext.until===addDays(today,1)){ var k='extReminder:'+c.id+':'+c.ext.until; if(open_(n,k,today)) out.push({key:k,type:'extReminder',itemId:c.id}); }
    return out;
  }
  // 'claimed' = saved BEFORE the send attempt. If the run died before the result was recorded, the outcome is UNKNOWN
  // (the mail may or may not have gone). Such markers are never re-sent automatically; an administrator decides.
  function markStale(s,today){ var n=0; if(!s.billing) return 0; s.billing.obligations.forEach(function(it){ var nt=it.notified||{}; Object.keys(nt).forEach(function(k){ var m=nt[k]; if(m&&typeof m==='object'&&m.status==='claimed'&&m.at<today){ m.status='unknown'; m.staleAt=today; m.error='Run ended before the delivery result was recorded'; n++; } }); }); return n; }
  function mark(s,ev,today){ var it=find(s.billing,ev.itemId); it.notified=it.notified||{}; var p=it.notified[ev.key]; var o=(p&&typeof p==='object')?p:null; var nm={status:'claimed',at:today,attempts:((o&&o.attempts)||0)+1}; if(o&&o.requeues) nm.requeues=o.requeues; it.notified[ev.key]=nm; }
  function setDelivery(s,itemId,key,status,today,detail){ var it=find(s.billing,itemId); if(!it||!it.notified||!it.notified[key]||typeof it.notified[key]!=='object') return; var m=it.notified[key]; m.status=status; m.doneAt=today;
    if(status==='failed'&&detail) m.error=String(detail).replace(/\s+/g,' ').slice(0,160); else if(status==='sent'){ delete m.error; m.smtpAccepted=true; } }
  // Admin: put a failed / unconfirmed / no-email notice back in the queue for the next Cron run. Bounded (MAX_MANUAL_RETRIES).
  // Never touches a 'sent' notice or one claimed today (a send may be in progress).
  function requeueNotice(s,itemId,key,today,by){
    var it=s.billing&&find(s.billing,itemId), m=it&&it.notified&&it.notified[key];
    if(!m||typeof m!=='object') return {ok:false,error:'Notice not found'};
    if(m.status==='sent') return {ok:false,error:'Already sent'}; if(m.status==='claimed'&&m.at>=today) return {ok:false,error:'A send may be in progress'};
    if(['failed','unknown','claimed','skipped-no-email'].indexOf(m.status)<0) return {ok:false,error:'Not retryable'};
    m.requeues=m.requeues||[]; if(m.requeues.length>=MAX_MANUAL_RETRIES) return {ok:false,error:'Manual retry limit reached'};
    m.requeues.push({at:today,by:by||null,from:m.status}); m.status='failed'; m.attempts=Math.min(m.attempts||1,MAX_ATTEMPTS-1); m.at=addDays(today,-1); return {ok:true};
  }
  // Notices an administrator should look at (unpaid items only; a paid charge no longer needs its notice).
  function noticeProblems(data,today){
    var out=[]; (data.subscribers||[]).forEach(function(s){ if(s.permanentlyDeleted||!s.billing||s.billing.review) return;
      s.billing.obligations.forEach(function(it){ if(remC(it)<=0) return; var nt=it.notified||{};
        Object.keys(nt).forEach(function(k){ var m=nt[k]; if(!m||typeof m!=='object') return; var st=m.status, state=null;
          if(st==='claimed'&&m.at<today) st='unknown';
          if(st==='failed') state=((m.attempts||1)<MAX_ATTEMPTS)?'will-retry':'retries-exhausted';
          else if(st==='unknown') state='unconfirmed'; else if(st==='skipped-no-email') state='no-email';
          if(!state) return;
          out.push({subId:s.id,name:s.name,email:s.email||'',itemId:it.id,key:k,type:k.split(':')[0],dueDate:it.dueDate,status:st,state:state,attempts:m.attempts||1,at:m.at,doneAt:m.doneAt||null,error:m.error||'',manualRetries:(m.requeues||[]).length,canRetry:(m.requeues||[]).length<MAX_MANUAL_RETRIES}); }); }); });
    return out;
  }
  // Keeps legacy s.due/s.status in step so old screens (lists, CSV, Sheets) keep working.
  function syncLegacyFields(s,today){
    if(!s.billing||s.billing.review) return; var st=accountStatus(s,today); var nd=nextDue(s,today); if(nd) s.due=nd;
    var cc=controlling(s,today); var ex=(cc&&cc.ext&&!cc.ext.resolution)?cc.ext:null;
    s.extensionUntil=ex?ex.until:null; s.extensionGrantedAt=ex?ex.grantedAt:null; s.extensionReason=ex?ex.reason:''; s.extensionGrantedBy=ex?ex.by:null;
    if(st==='disconnected'||st==='archived') return; s.status=(st==='current'||st==='due')?'paid':st;
  }
  // An upcoming (not yet due) subscription charge with no payment/notice yet follows the current rate;
  // anything already due or touched keeps its frozen amount (older periods are never re-priced).
  function repriceUpcoming(s,today){
    var b=s.billing; if(!b) return; b.obligations.forEach(function(it){
      if(it.kind==='subscription' && it.dueDate>today && !(it.applied&&it.applied.length) && !Object.keys(it.notified||{}).length && !it.ext && !it.rateReview){ var rf=rateFor(s,it.dueDate,today); if(rf.known) it.amountC=rf.c; } });
  }
  // Daily step (pure on state): generate, resolve, credit, derive. Idempotent.
  function daily(s,today){
    if(!s.billing) return {};
    syncRate(s,today); markStale(s,today); repriceUpcoming(s,today); var g=generate(s,today); var cr=applyCredit(s,today); resolveExtensions(s,today); return {added:g.added,credit:cr};
  }
  return { OVERDUE_AFTER_DAYS:OVERDUE_AFTER_DAYS, STALE_DAYS:STALE_DAYS, toC:toC, fromC:fromC, splitThree:splitThree, daysBetween:daysBetween, addDays:addDays, dueAfter:dueAfter, nextDueOnOrAfter:nextDueOnOrAfter, dayOf:dayOf,
    paidC:paidC, remC:remC, find:find, newBilling:newBilling, setOpening:setOpening, generate:generate, recordPayment:recordPayment, applyCredit:applyCredit,
    subStatus:subStatus, accountStatus:accountStatus, controlling:controlling, nextDue:nextDue, summary:summary, breakdownFor:breakdownFor, installmentSchedule:installmentSchedule,
    onboardNew:onboardNew, onboardExisting:onboardExisting, migrateLegacy:migrateLegacy, reconnect:reconnect, reviewSuggestion:reviewSuggestion, receivables:receivables, collectionsByKind:collectionsByKind, resolveReview:resolveReview, grantExtension:grantExtension, resolveExtensions:resolveExtensions,
    events:events, mark:mark, setDelivery:setDelivery, markStale:markStale, requeueNotice:requeueNotice, noticeProblems:noticeProblems, MAX_ATTEMPTS:MAX_ATTEMPTS, MAX_MANUAL_RETRIES:MAX_MANUAL_RETRIES,
    rateFor:rateFor, setRate:setRate, seedRate:seedRate, syncRate:syncRate, pendingRateChange:pendingRateChange, resolveRateReview:resolveRateReview, rateReviews:rateReviews, syncLegacyFields:syncLegacyFields, daily:daily, repriceUpcoming:repriceUpcoming, unpaidBilled:unpaidBilled };
})();
/* BILLING-END */


/* ---------- the daily lifecycle, on the ledger ---------- */
const frozenSub = (s) => s.permanentlyDeleted || s.archived || s.status === 'disconnected';
// Mutates `state` (generate charges, claim notices, mirror legacy fields) and returns what should be emailed + a report.
export function processState(state, today) {
  const jobs = [], changes = [], generated = [], review = [], problems = [], suppressed = [], rateReviews = [];
  const before = JSON.stringify(state.subscribers);
  for (const s of state.subscribers) {
    if (s.permanentlyDeleted) continue;
    if (!s.billing) BILL.migrateLegacy(s, today);
    if (s.billing.review) { if (!s.archived && s.status !== 'disconnected') review.push({ id: s.id, name: s.name, storedDue: s.due || null, storedStatus: s.status || null }); continue; }
    const was = { status: s.status, due: s.due };
    const d = BILL.daily(s, today);
    for (const it of BILL.rateReviews(s)) rateReviews.push({ name: s.name, itemId: it.id, dueDate: it.dueDate, placeholderAmount: it.rateReview.placeholderC / 100 });
    if (d.added && d.added.length) generated.push({ name: s.name, charges: d.added.map((i) => i.id) });
    if (!frozenSub(s)) {
      for (const ev of BILL.events(s, today)) {
        const bill = billingEmailData(s, today);
        const job = { type: ev.type, key: ev.key, itemId: ev.itemId, subId: s.id, name: s.name, email: s.email || '', accountUsername: s.accountUsername || '', plan: s.plan || '', bill, totalC: bill.totalC, dueDate: bill.dueDate };
        if (!(bill.totalC > 0)) problems.push({ name: s.name, type: ev.type, issue: 'zero payable amount' });
        if (!bill.dueDate) problems.push({ name: s.name, type: ev.type, issue: 'no due date' });
        if (!s.email) problems.push({ name: s.name, type: ev.type, issue: 'no email on file' });
        BILL.mark(s, ev, today);
        jobs.push(job);
      }
      // events already claimed/sent earlier today or before = duplicates that were correctly suppressed
      const c = BILL.controlling(s, today);
      if (c) { const st = BILL.subStatus(c, today); const k = (st === 'pending' ? 'pending:' : st === 'overdue' ? 'overdue:' : null); if (k && c.notified && c.notified[k + c.id] && !jobs.some((j) => j.subId === s.id)) suppressed.push({ name: s.name, key: k + c.id }); }
    }
    BILL.syncLegacyFields(s, today);
    if (was.status !== s.status || was.due !== s.due) changes.push({ name: s.name, from: was, to: { status: s.status, due: s.due } });
  }
  const noticeProblems = BILL.noticeProblems(state, today);
  return { jobs, changes, generated, review, problems, suppressed, rateReviews, noticeProblems, changed: JSON.stringify(state.subscribers) !== before };
}

export function investorDue(state, today, nowMs = Date.now()) {
  const ir = state.investorReport;
  if (!ir || !ir.enabled) return { due: false, reason: 'disabled' };
  if (!ir.email) return { due: false, reason: 'no-investor-email' };
  const period = prevMonthPeriod(today);
  if (Number(today.slice(8, 10)) < (ir.sendOnDay || 1)) return { due: false, reason: 'not-yet-send-day', period };
  if (ir.lastSentPeriod === period.key) return { due: false, reason: 'already-sent', period };
  if (ir.sendingPeriod === period.key && ir.sendingAt && nowMs - Date.parse(ir.sendingAt) < 2 * 60 * 60 * 1000) return { due: false, reason: 'claimed-by-another-run', period };
  return { due: true, period };
}

const SUBJECTS = { pending: (b) => `Payment reminder — ${b}`, extReminder: (b) => `Extension reminder — ${b}`, overdue: (b) => `Payment overdue — ${b}` };

export async function runCron({ admin, today, transporter, gmailUser, dryRun = false }) {
  // ---- READ-ONLY DRY RUN (HQ D8): everything that WOULD change, nothing written or sent ----
  if (dryRun) {
    const { data: row } = await admin.from('app_state').select('data').eq('id', STATE_ROW_ID).single();
    if (!row || !row.data || !Array.isArray(row.data.subscribers)) return { ok: true, dryRun: true, note: 'No valid app_state row to process yet.' };
    const state = JSON.parse(JSON.stringify(row.data));
    const r = processState(state, today);
    const pick = (t) => r.jobs.filter((j) => j.type === t).map((j) => ({ name: j.name, hasEmail: !!j.email, totalPayable: j.totalC / 100, dueDate: j.dueDate, extensionUntil: j.bill.extensionUntil, itemId: j.itemId }));
    return { ok: true, dryRun: true, today,
      summary: { statusOrDueChanges: r.changes.length, legacyUnverifiedSkipped: r.review.length, proposedPending: pick('pending').length, proposedOverdue: pick('overdue').length, proposedExtensionReminders: pick('extReminder').length, newChargesGenerated: r.generated.length, duplicatesSuppressed: r.suppressed.length, validationProblems: r.problems.length, rateReviewsPending: r.rateReviews.length, noticesNeedingAttention: r.noticeProblems.length },
      statusOrDueChanges: r.changes, legacyUnverifiedSkipped: r.review,
      proposedEmails: { pending: pick('pending'), overdue: pick('overdue'), extensionReminders: pick('extReminder') },
      newChargesGenerated: r.generated, duplicatesSuppressed: r.suppressed, validationProblems: r.problems,
      rateReviews: r.rateReviews, noticesNeedingAttention: r.noticeProblems.map((n) => ({ name: n.name, type: n.type, status: n.status, state: n.state, attempts: n.attempts, error: n.error })),
      investor: investorDue(state, today), note: 'Read-only. No data was written and no email was sent.' };
  }

  // ---- Phase 1: generate charges + claim notices under CAS, saved BEFORE any email is sent ----
  let res; let businessName = 'SignalDesk', logoUrl = '', paymentInfo = {};
  const p1 = await casUpdate(admin, (state) => {
    businessName = state.business?.name || 'SignalDesk'; logoUrl = state.business?.logo || ''; paymentInfo = state.business?.paymentInfo || {};
    res = processState(state, today);
    if (res.changed) pushAudit(state, `Daily billing run: ${res.jobs.length} notice(s) queued, ${res.generated.length} subscriber(s) with new monthly charges, ${res.review.length} awaiting billing review`);
    return { changed: res.changed };
  });
  if (!p1.ok) return { ok: false, error: 'state-update-failed', reason: p1.reason, detail: p1.detail };

  // ---- Phase 2: send (claims are already saved => at-most-once); record real delivery results ----
  const qr = qrAttachment(paymentInfo); const attachments = qr ? [qr] : [];
  const common = { businessName, logoUrl, paymentInfo, hasQr: !!qr };
  const results = []; let emailsSent = 0;
  for (const j of res.jobs) {
    let status = 'sent'; let detail = '';
    if (!j.email) status = 'skipped-no-email';
    else if (!transporter) { status = 'failed'; detail = 'Mail transport not configured'; }
    else {
      const html = j.type === 'overdue'
        ? templateDisconnectionWarning({ ...common, subscriberName: j.name, accountUsername: j.accountUsername, bill: j.bill })
        : templateMinimalStatement({ ...common, subscriberName: j.name, accountUsername: j.accountUsername, plan: j.plan, bill: j.bill, status: j.type === 'extReminder' ? 'Extended' : 'Pending', isExtensionReminder: j.type === 'extReminder' });
      try { await transporter.sendMail({ from: `"${businessName}" <${gmailUser}>`, to: j.email, subject: SUBJECTS[j.type](businessName), html, attachments }); emailsSent++; }
      catch (e) { status = 'failed'; detail = (e && (e.responseCode ? e.responseCode + ' ' : '') + (e.message || e.code || 'send error')) || 'send error'; }
    }
    results.push({ subId: j.subId, itemId: j.itemId, key: j.key, type: j.type, name: j.name, status, detail });
  }
  // Recording the outcome is retried (CAS). If it still fails, the claims stay 'claimed' and are reported as
  // UNCONFIRMED on the next run (never re-sent automatically) -- see noticeProblems / admin retry.
  let deliveryRecorded = true;
  if (results.length) {
    const rec = await casUpdate(admin, (state) => {
      for (const r of results) { const s = state.subscribers.find((x) => x.id === r.subId); if (s && s.billing) BILL.setDelivery(s, r.itemId, r.key, r.status, today, r.detail); if (r.status !== 'sent') pushAudit(state, `Billing notice (${r.type}) for ${r.name}: ${r.status}`); }
      return { changed: true };
    }, 8);
    deliveryRecorded = !!rec.ok;
  }

  // ---- Phase 3: monthly Investor Report (previous completed month) ----
  let investor = { sent: false };
  if (transporter) {
    let claimedPeriod = null, totals = null, investorEmail = null;
    const claim = await casUpdate(admin, (state) => {
      claimedPeriod = null; totals = null; investorEmail = null; // a retry after a CAS conflict must start clean, or a stale claim from the failed attempt would send a duplicate
      businessName = state.business?.name || businessName; logoUrl = state.business?.logo || logoUrl;
      const d = investorDue(state, today);
      // HQ D4: a previous claim for this period that expired (>2h, never marked sent) means an earlier send was interrupted;
      // the report may already have been delivered. We retry (bounded) and log the possible duplicate. Exactly-once is NOT guaranteed.
      const prior = state.investorReport; if (d.due && prior && prior.sendingPeriod === d.period.key && prior.sendingAt) pushAudit(state, `Investor Report ${d.period.key}: an earlier send was interrupted (claim from ${prior.sendingAt} expired). Re-sending now; the recipient may receive a duplicate.`);
      if (!d.due) { investor = { sent: false, reason: d.reason }; return { changed: false }; }
      const ir = state.investorReport; ir.sendingPeriod = d.period.key; ir.sendingAt = new Date().toISOString();
      claimedPeriod = d.period; investorEmail = ir.email; totals = computeOwnershipTotals(state, d.period);
      return { changed: true };
    });
    if (!claim.ok) investor = { sent: false, reason: claim.reason };
    else if (claimedPeriod) {
      let ok = false;
      try { await transporter.sendMail({ from: `"${businessName}" <${gmailUser}>`, to: investorEmail, subject: `Investor Report — ${businessName} — ${claimedPeriod.key}`, html: investorReportEmailHtml({ businessName, logoUrl, period: claimedPeriod, totals }) }); ok = true; } catch (e) { ok = false; }
      const fin = await casUpdate(admin, (state) => {
        const ir = state.investorReport || (state.investorReport = {});
        if (ok) { ir.lastSentPeriod = claimedPeriod.key; ir.lastSentAt = today; pushAudit(state, `Sent monthly Investor Report email for ${claimedPeriod.key}`); }
        else { pushAudit(state, `Monthly Investor Report email for ${claimedPeriod.key} FAILED to send — will retry on the next run`); }
        ir.sendingPeriod = null; ir.sendingAt = null; return { changed: true };
      });
      investor = { sent: ok, period: claimedPeriod.key, recorded: fin.ok }; if (ok) emailsSent++;
    }
  } else investor = { sent: false, reason: 'mailer-not-configured' };

  const by = (t) => results.filter((r) => r.type === t).length;
  return { ok: true, today, pendingReminders: by('pending'), extensionReminders: by('extReminder'), overdueNotices: by('overdue'),
    noticeFailures: results.filter((r) => r.status === 'failed').length, noticesSkippedNoEmail: results.filter((r) => r.status === 'skipped-no-email').length,
    legacyUnverifiedSkipped: res.review.length, rateReviewsPending: res.rateReviews.length, noticesNeedingAttention: res.noticeProblems.length, deliveryRecorded, investor, emailsSent };
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  const supabaseUrl = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
  const admin = createClient(supabaseUrl, serviceKey);
  const gmailUser = process.env.GMAIL_USER, gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  const dryRun = (req.query && req.query.dry === '1') || /[?&]dry=1/.test(req.url || '');
  // A dry run never needs (or builds) a mail transport.
  const transporter = (!dryRun && gmailUser && gmailAppPassword) ? nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, auth: { user: gmailUser, pass: gmailAppPassword } }) : null;
  const result = await runCron({ admin, today: todayManila(), transporter, gmailUser, dryRun });
  return res.status(result.ok ? 200 : 500).json(result);
}
export { BILL };
