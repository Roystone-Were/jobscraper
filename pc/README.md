# LinkedIn from a PC

LinkedIn answers Cloudflare's IPs with HTTP 429, but a normal PC is fine. `linkedin-push.ps1`
fetches each LinkedIn search (`LINKEDIN_KEYWORDS` in `wrangler.jsonc`, last 24 h, newest first)
and POSTs the result pages to the Worker's `/linkedin` endpoint. The Worker parses them into
the `linkedin_inbox` table and the next 10-minute run scores and sends them like any other job.

Uses Windows PowerShell 5.1 (built into Windows). Nothing to install, no admin rights needed.

## Setup on the PC
1. Put these files in a folder on the PC (USB, email, etc.): `setup.cmd`, `setup.ps1`,
   `linkedin-push.ps1`, `install-task.ps1`, `uninstall.cmd`, plus `linkedin-push.config.json`
   (copy `linkedin-push.config.example.json`; the key is `LINKEDIN_PUSH_KEY` in
   `.secrets/cloudflare-secrets.json`). Without the config file, setup asks for the URL and key.
2. Double-click `setup.cmd`. It installs to `%LOCALAPPDATA%\JobScraperLinkedIn`, runs one test
   push (about 2 minutes), and if that works, schedules it every 30 min, 07:00-19:00, while you
   are signed in. No admin rights needed. The original folder can then be deleted.

Different times: in the install folder, `powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -EveryMinutes 20 -From 08:00 -ForHours 10`.

## Checking on it
- `%LOCALAPPDATA%\JobScraperLinkedIn\linkedin-push.log` records every run.
- The Monday site report counts each push under LinkedIn; failures (e.g. 429) show only in the log.
- Remove: double-click `uninstall.cmd` in the install folder.

## Notes
- It only runs while the PC is on and you are signed in; missed runs start when you sign in.
- About 7 requests to LinkedIn per run, 8-20 s apart. If the log shows HTTP 429 or 999, run it less often.
- `LINKEDIN_PUSH_KEY` only lets someone add LinkedIn search pages; it cannot trigger runs or read data.
  To change it: edit `.secrets/cloudflare-secrets.json`, `npx wrangler secret bulk .secrets/cloudflare-secrets.json`,
  then update `linkedin-push.config.json`.
