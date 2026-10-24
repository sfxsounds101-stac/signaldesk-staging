// Serves PUBLIC, environment-specific browser configuration from the deployment's own environment variables.
// Only the project URL, the public anon key and the environment label are ever returned. The service-role key,
// Gmail password, Cron secret and Google keys are server-only and are never read by this file.
export default function handler(req, res) {
  const cfg = {
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
    ENV: process.env.APP_ENV || 'production'
  };
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send('window.SIGNALDESK_CONFIG=' + JSON.stringify(cfg) + ';');
}
