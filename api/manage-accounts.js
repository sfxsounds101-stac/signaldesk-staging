// Vercel serverless function — creates and deletes staff accounts.
// Uses the Supabase SERVICE ROLE key, which can bypass all security rules —
// that's why this code runs only on the server, never in the browser, and
// why it double-checks the caller is really an admin before doing anything.
//
// Required Vercel environment variables:
//   SUPABASE_URL               same project URL used in index.html
//   SUPABASE_SERVICE_ROLE_KEY  from Supabase > Project Settings > API —
//                               the "service_role" key, NOT the anon key.
//                               Keep this secret. Never put it in index.html.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
  }

  const { action, accessToken, email, password, name, role, targetUserId } = req.body || {};
  if (!accessToken) {
    return res.status(401).json({ error: 'Missing access token' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Confirm the caller is a real, currently-logged-in admin before doing anything.
  const { data: callerData, error: callerErr } = await admin.auth.getUser(accessToken);
  if (callerErr || !callerData?.user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  const { data: callerProfile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', callerData.user.id)
    .single();
  if (!callerProfile || callerProfile.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can manage accounts' });
  }

  try {
    if (action === 'create') {
      if (!email || !password || !name || !role) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (!['admin', 'user', 'guest'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true
      });
      if (createErr) return res.status(400).json({ error: createErr.message });

      const { error: profileErr } = await admin.from('profiles').insert({
        id: created.user.id,
        name,
        role
      });
      if (profileErr) {
        // Roll back the auth user so we don't leave an orphaned account.
        await admin.auth.admin.deleteUser(created.user.id);
        return res.status(400).json({ error: profileErr.message });
      }

      return res.status(200).json({ success: true, userId: created.user.id });
    }

    if (action === 'delete') {
      if (!targetUserId) {
        return res.status(400).json({ error: 'Missing targetUserId' });
      }
      if (targetUserId === callerData.user.id) {
        return res.status(400).json({ error: "You can't delete your own account while signed in as it." });
      }
      const { error: delErr } = await admin.auth.admin.deleteUser(targetUserId);
      if (delErr) return res.status(400).json({ error: delErr.message });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: 'Account management failed', detail: String(err) });
  }
}
