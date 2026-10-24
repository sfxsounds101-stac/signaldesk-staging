// Vercel serverless function — mirrors SignalDesk's live data into a Google
// Sheet on every save, as an independent backup outside GitHub/Supabase/Vercel.
//
// Required Vercel environment variables:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   from your Google Cloud service account JSON
//   GOOGLE_PRIVATE_KEY             from the same JSON (the "private_key" field)
//   GOOGLE_SHEET_ID                the long ID in your Sheet's URL, between
//                                  /d/ and /edit
//
// The Sheet itself must be shared with GOOGLE_SERVICE_ACCOUNT_EMAIL as an
// Editor, or these writes will fail with a permissions error.

import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

// Public project values come from the deployment's environment (never hard-coded; see scripts/check-env.mjs).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function peso(n) {
  return Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });
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


export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Server is missing SUPABASE_URL / SUPABASE_ANON_KEY' });
  const { accessToken, data } = req.body || {};
  if (!accessToken || !data) {
    return res.status(400).json({ error: 'Missing accessToken or data' });
  }

  // Confirm the caller is a signed-in admin/user (same rule as who can save data at all).
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
  const { data: userData, error: userErr } = await sb.auth.getUser(accessToken);
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  const { data: profile } = await sb.from('profiles').select('role').eq('id', userData.user.id).single();
  if (!profile || !['admin', 'user'].includes(profile.role)) {
    return res.status(403).json({ error: 'Not authorized to sync data' });
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!sheetId || !serviceEmail || !privateKey) {
    return res.status(500).json({ error: 'Google Sheets credentials are not configured on the server' });
  }

  try {
    const auth = new google.auth.JWT(
      serviceEmail,
      null,
      privateKey.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    const sheets = google.sheets({ version: 'v4', auth });

    const subscribers = data.subscribers || [];
    const payments = data.payments || [];
    const expenses = (data.expenses || []).filter((e) => !e.voided);

    const todayManila = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const P = (c) => (c || 0) / 100;
    const subscriberName = (id) => (subscribers.find((s) => s.id === id) || {}).name || 'Unknown';

    const billingOf = (s) => {
      if (!s.billing) return { review: 'Needs review (no billing record)', day: '', open: '', m: null };
      if (s.billing.review) return { review: 'Needs review', day: s.billing.billingDay || '', open: s.billing.opening.state, m: null };
      return { review: 'Verified', day: s.billing.billingDay || '', open: s.billing.opening.state, m: BILL.summary(s, todayManila) };
    };
    const subscribersRows = [
      ['Name', 'Address', 'Email', 'Phone', 'WhatsApp', 'Facebook', 'Messenger', 'Plan', 'Rate (PHP)', 'Next Due Date', 'Status', 'Ownership', 'Account Username', 'NAP Number', 'PON Number',
       'Connection Date', 'Billing Day', 'Billing Baseline', 'Opening Balance State', 'Billed Outstanding (PHP)', 'Due Now (PHP)', 'Past Due (PHP)', 'Future Scheduled (PHP)', 'Account Credit (PHP)'],
      ...subscribers.filter((s) => !s.permanentlyDeleted).map((s) => {
        const bo = billingOf(s), m = bo.m;
        return [
          s.name || '', s.address || '', s.email || '', s.phone || '', s.whatsapp || '',
          s.fb || '', s.messenger || '', s.plan || '', s.rate || 0, s.due || '', s.status || '',
          s.ownership || 'unassigned', s.accountUsername || '', s.napNumber || '', s.ponNumber || '',
          s.connectionDate || '', bo.day, bo.review, bo.open,
          m ? P(m.outstandingC) : '', m ? P(m.dueNowC) : '', m ? P(m.pastDueC) : '', m ? P(m.futureC) : '', m ? P(m.creditC) : ''
        ];
      })
    ];

    const paymentsRows = [
      ['Date', 'Subscriber', 'Amount (PHP)', 'Method', 'Ownership', 'Applied: Subscription (PHP)', 'Applied: Installation (PHP)', 'Applied: Prior Balance (PHP)', 'Added to Credit (PHP)'],
      ...payments.map((p) => {
        const by = { subscription: 0, installation: 0, opening: 0 };
        (p.allocations || []).forEach((a) => { by[a.kind] = (by[a.kind] || 0) + a.c; });
        const legacy = !p.allocations;
        return [p.date || '', subscriberName(p.subscriberId), p.amount || 0, p.method || '', p.ownership || '',
          legacy ? 'legacy (not itemised)' : P(by.subscription), legacy ? '' : P(by.installation), legacy ? '' : P(by.opening), legacy ? '' : P(p.creditAddedC || 0)];
      })
    ];

    const expensesRows = [
      ['Date', 'Description', 'Category', 'Amount (PHP)', 'Allocation Type', 'Own Share (PHP)', 'Investor Share (PHP)'],
      ...expenses.map((e) => [e.date || '', e.description || '', e.category || '', e.amount || 0, e.allocationType || '', e.allocation ? e.allocation.own : '', e.allocation ? e.allocation.investor : ''])
    ];

    const period = prevMonthPeriod(todayManila);           // previous COMPLETED month
    const totals = computeOwnershipTotals(data, period);   // same function as dashboard + email
    const allTime = computeOwnershipTotals(data, null);
    const investorRows = [
      ['Reporting period', `${period.key} (${period.from} to ${period.to})`],
      ['Investor subscriber count (current)', totals.counts.investor],
      ['Investor revenue (PHP)', peso(totals.revenue.investor)],
      ['Investor allocated expenses (PHP)', peso(totals.expenses.investor)],
      ['Investor net (PHP)', peso(totals.net.investor)],
      [],
      ['Own subscriber count (current)', totals.counts.own],
      ['Own revenue (PHP)', peso(totals.revenue.own)],
      ['Own allocated expenses (PHP)', peso(totals.expenses.own)],
      ['Own net (PHP)', peso(totals.net.own)],
      [],
      ['Unassigned subscriber count (current)', totals.counts.unassigned],
      ['Unassigned / legacy revenue (PHP)', peso(totals.revenue.unassigned)],
      ['Unclassified legacy expenses (PHP)', peso(totals.expenses.unclassified)],
      [],
      ['Overall subscriber count (current)', totals.counts.overall],
      ['Overall revenue (PHP)', peso(totals.revenue.overall)],
      ['Overall expenses (PHP)', peso(totals.expenses.overall)],
      ['Overall net (PHP)', peso(totals.net.overall)],
      [],
      ['All-time overall revenue (PHP)', peso(allTime.revenue.overall)],
      ['All-time overall expenses (PHP)', peso(allTime.expenses.overall)],
      ['Last synced', new Date().toISOString()],
      ['Note', 'Period = previous completed calendar month. Own + Investor + Unassigned revenue = Overall revenue; Own + Investor + Unclassified expenses = Overall expenses. Legacy records without ownership/allocation are never guessed into Own or Investor.']
    ];

    // Month-by-month history, derived fresh from the saved payments/expenses on every
    // sync (so past months can never drift or be overwritten by hand-edited totals).
    const historyRows = [['Month', 'Investor revenue', 'Investor expenses', 'Investor net', 'Own revenue', 'Own expenses', 'Own net', 'Unassigned revenue', 'Unclassified expenses', 'Overall revenue', 'Overall expenses', 'Overall net']];
    activityMonthKeys(data).forEach((k) => {
      const t = computeOwnershipTotals(data, monthPeriod(k));
      historyRows.push([k, t.revenue.investor, t.expenses.investor, t.net.investor, t.revenue.own, t.expenses.own, t.net.own, t.revenue.unassigned, t.expenses.unclassified, t.revenue.overall, t.expenses.overall, t.net.overall]);
    });

    const rc = BILL.receivables(data, todayManila);
    const ck = BILL.collectionsByKind(data, null);
    const receivablesRows = [
      ['Receivables & collections (as of ' + todayManila + ')', 'PHP'],
      ['Total billed outstanding', P(rc.total)],
      ['Due now', P(rc.dueNow)],
      ['  of which past due', P(rc.pastDue)],
      ['Future scheduled (billed, not yet due)', P(rc.future)],
      ['Subscription receivables', P(rc.byKind.subscription)],
      ['Installation receivables', P(rc.byKind.installation)],
      ['Verified prior balances', P(rc.byKind.opening)],
      ['Available account credit', P(rc.credit)],
      ['Outstanding - Own', P(rc.own)], ['Outstanding - Investor', P(rc.investor)], ['Outstanding - Unassigned', P(rc.unassigned)],
      ['Subscribers not yet verified (excluded)', rc.unreviewed],
      ['Pending Rate Verification (not in confirmed receivables)', P(rc.pendingRate)],
      [],
      ['All-time cash collected: subscription (incl. legacy)', P(ck.subscription + ck.legacy)],
      ['All-time cash collected: installation', P(ck.installation)],
      ['All-time cash collected: prior balances', P(ck.opening)],
      ['All-time cash held as credit', P(ck.credit)],
      ['Note', 'Receivables are billed charges not yet paid. They are never counted as revenue. Revenue = recorded payments only.']
    ];
    const installationRows = [
      ['Subscriber', 'Arrangement', 'Total (PHP)', 'Created', 'Installment', 'Due Date', 'Amount (PHP)', 'Paid (PHP)', 'Remaining (PHP)'],
      ...subscribers.filter((s) => !s.permanentlyDeleted && s.billing && s.billing.installation).flatMap((s) =>
        s.billing.obligations.filter((o) => o.kind === 'installation').map((o) => [s.name || '', s.billing.installation.paymentArrangement, P(s.billing.installation.totalC), s.billing.installation.createdAt, o.id, o.dueDate || '', P(o.amountC), P(BILL.paidC(o)), P(BILL.remC(o))]))
    ];

    const totalCollected = payments.reduce((s, p) => s + (p.amount || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const counts = { paid: 0, pending: 0, overdue: 0, disconnected: 0 };
    subscribers.forEach((s) => { counts[s.status] = (counts[s.status] || 0) + 1; });

    const summaryRows = [
      ['Metric', 'Value'],
      ['Business name', data.business?.name || ''],
      ['Total collected (PHP)', peso(totalCollected)],
      ['Total expenses (PHP)', peso(totalExpenses)],
      ['Net (PHP)', peso(totalCollected - totalExpenses)],
      ['Paid subscribers', counts.paid || 0],
      ['Pending subscribers', counts.pending || 0],
      ['Overdue subscribers', counts.overdue || 0],
      ['Disconnected subscribers', counts.disconnected || 0],
      ['Last synced', new Date().toISOString()]
    ];

    const tabs = [
      { name: 'Subscribers', rows: subscribersRows },
      { name: 'Payments', rows: paymentsRows },
      { name: 'Expenses', rows: expensesRows },
      { name: 'Summary', rows: summaryRows },
      { name: 'Investor Report', rows: investorRows },
      { name: 'Monthly History', rows: historyRows },
      { name: 'Receivables', rows: receivablesRows },
      { name: 'Installation Fees', rows: installationRows }
    ];

    // Make sure all tabs actually exist before writing to them.
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const existingTitles = meta.data.sheets.map((s) => s.properties.title);
    const missing = tabs.filter((t) => !existingTitles.includes(t.name));
    if (missing.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: missing.map((t) => ({ addSheet: { properties: { title: t.name } } }))
        }
      });
    }

    for (const tab of tabs) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: sheetId,
        range: `${tab.name}!A1:Z10000`
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${tab.name}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: tab.rows }
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Google Sheets sync failed', detail: String(err) });
  }
}
