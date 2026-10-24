// Build-time isolation check (Handoff #008 Task 3). Run as the Vercel build command: `node scripts/check-env.mjs`.
// With APP_ENV=staging it FAILS the build when anything points at, or could reach, the production project:
//   * SUPABASE_URL must be https://<STAGING_SUPABASE_REF>.supabase.co ; SUPABASE_ANON_KEY must be an anon key of that same project
//   * no ref listed in FORBIDDEN_SUPABASE_REFS (comma separated env var) may appear anywhere in the shipped source
//   * any *.supabase.co URL or Supabase JWT in the source must belong to the staging ref; no service_role JWT / string in browser code
//   * vercel.json must not contain a "crons" entry (Cron stays disabled in staging)
//   * no real-looking e-mail address in shipped source (only example.*, *.invalid, staging test domains)
// With any other APP_ENV it only checks that the public config values are present and that no service-role key is in the source.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
const env = process.env, root = process.cwd(), fails = [];
const staging = (env.APP_ENV || '') === 'staging';
const ref = s => { const m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(s || ''); return m && m[1]; };
const jwtPayload = t => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); } catch { return null; } };
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
  if (['node_modules', '.git', '.vercel', 'qa-tests', 'qa-evidence', 'backups'].includes(f.name)) continue;
  const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(html|js|mjs|json|css|webmanifest)$/.test(f.name)) files.push(p); } })(root);
const read = f => fs.readFileSync(f, 'utf8');
const rel = f => path.relative(root, f);
if (!env.SUPABASE_URL || !ref(env.SUPABASE_URL)) fails.push('SUPABASE_URL missing or not https://<ref>.supabase.co');
if (!env.SUPABASE_ANON_KEY) fails.push('SUPABASE_ANON_KEY missing');
const ap = jwtPayload(env.SUPABASE_ANON_KEY || '');
if (ap && ap.role !== 'anon') fails.push('SUPABASE_ANON_KEY is not an anon key (role=' + ap.role + ')');
if (ap && ref(env.SUPABASE_URL) && ap.ref !== ref(env.SUPABASE_URL)) fails.push('SUPABASE_ANON_KEY belongs to a different project than SUPABASE_URL');
for (const f of files) {
  const t = read(f);
  if (/service_role/.test(t) && /index\.html|config\.js|manifest|service-worker/.test(f)) fails.push(rel(f) + ': contains "service_role"');
  for (const m of t.matchAll(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g)) { const p = jwtPayload(m[0]); if (p && p.role === 'service_role') fails.push(rel(f) + ': contains a service_role JWT'); }
}
if (staging) {
  const want = env.STAGING_SUPABASE_REF;
  if (!want) fails.push('STAGING_SUPABASE_REF is not set');
  if (want && ref(env.SUPABASE_URL) !== want) fails.push('SUPABASE_URL ref ' + ref(env.SUPABASE_URL) + ' is not the staging ref');
  const forbidden = (env.FORBIDDEN_SUPABASE_REFS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!forbidden.length) fails.push('FORBIDDEN_SUPABASE_REFS is not set (list the production project ref)');
  if (forbidden.includes(ref(env.SUPABASE_URL))) fails.push('SUPABASE_URL points at a forbidden (production) project');
  for (const f of files) {
    const t = read(f);
    for (const r of forbidden) if (t.includes(r)) fails.push(rel(f) + ': contains forbidden project ref');
    for (const m of t.matchAll(/https:\/\/([a-z0-9]+)\.supabase\.co/g)) if (want && m[1] !== want) fails.push(rel(f) + ': Supabase URL for another project (' + m[1] + ')');
    for (const m of t.matchAll(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g)) { const p = jwtPayload(m[0]); if (p && p.ref && want && p.ref !== want) fails.push(rel(f) + ': Supabase key for another project'); }
    if (/\.(html|js|mjs)$/.test(f)) for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g)) {
      const dom = m[0].split('@')[1].toLowerCase();
      if (!(/^example\.(com|org|net|invalid)$/.test(dom) || /\.invalid$/.test(dom) || ['staging.invalid', 'signaldesk', 'signaldesk.local'].includes(dom) || /^(you|your|name|user)/i.test(m[0]) && /example|domain|email/.test(dom) || ['sentry.io','2x.png'].includes(dom))) fails.push(rel(f) + ': non-synthetic e-mail address ' + m[0]);
    }
  }
  const vj = path.join(root, 'vercel.json');
  if (fs.existsSync(vj)) { const j = JSON.parse(read(vj) || '{}'); if (j.crons && j.crons.length) fails.push('vercel.json defines Cron jobs (not allowed in staging)'); }
}
// Optional integrity gate: BUNDLE_MANIFEST = JSON {"relative/path": "<sha256 hex>"} of the reviewed build. Any difference fails the build.
if (env.BUNDLE_MANIFEST) {
  let m = null; try { m = JSON.parse(env.BUNDLE_MANIFEST); } catch { fails.push('BUNDLE_MANIFEST is not valid JSON'); }
  for (const [f, h] of Object.entries(m || {})) { const p = path.join(root, f);
    if (!fs.existsSync(p)) fails.push('integrity: missing ' + f);
    else if (crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') !== h) fails.push('integrity: ' + f + ' differs from the reviewed build'); }
  if (m) console.log('Integrity manifest checked for ' + Object.keys(m).length + ' files.');
}
if (fails.length) { console.error('ENVIRONMENT CHECK FAILED (' + (staging ? 'staging' : 'non-staging') + '):\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('Environment check passed (' + (staging ? 'staging' : 'non-staging') + '; ' + files.length + ' files scanned).');
