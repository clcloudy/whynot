-- Run in the WhyNot database as the migration owner after enabling pg_cron.
SELECT cron.schedule('whynot-purge-expired', '*/5 * * * *', 'SELECT app.purge_expired()');
