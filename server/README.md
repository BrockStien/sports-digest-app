# Server code

`notify.ts` (game watcher), `teams.ts` (team lists and team pages) and `calendar.ts` (calendar feed) and `health.ts` (watchdog) are the Supabase Edge Functions of the same names.
Supabase builds the function from a pinned commit of this file, so updating the file here
does nothing until the function is redeployed with the new commit.

It has no keys or passwords in it. Those are Supabase secrets.
