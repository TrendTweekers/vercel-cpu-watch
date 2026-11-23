# vercel-cpu-watch

Tracks Vercel Fluid Active CPU per project and route on the free (Hobby) plan,
which only shows the last 30 minutes. Runs every 15 minutes on GitHub Actions,
keeps 40 days of per-minute data in the Actions cache (not in git, not in logs),
and sends a daily Telegram report plus warnings.

Secrets: VERCEL_TOKEN, VERCEL_SCOPE, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
