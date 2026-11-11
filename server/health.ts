// Sports Digest watchdog (Supabase Edge Function "health"). Runs every 10 minutes.
// Checks that everything is working and sends a phone notification to the app's admins
// (table app_admins) when something breaks, again every 6 hours while it stays broken,
// and once more when it's fixed. Uses the same secrets as "notify".
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const APP_URL = (Deno.env.get("APP_URL") || "https://brockstien.github.io/sports-digest-app/").replace(/\/?$/, "/");
const BASE = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");

type Check = { key: string; name: string; ok: boolean; detail: string };

async function get(url: string, ms = 15000) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,text/html" }, signal: AbortSignal.timeout(ms) });
  return { status: r.status, text: await r.text() };
}
const safe = async (key: string, name: string, fn: () => Promise<[boolean, string]>): Promise<Check> => {
  try { const [ok, detail] = await fn(); return { key, name, ok, detail }; }
  catch (e) { return { key, name, ok: false, detail: String(e).slice(0, 160) }; }
};

export async function checks(db: any): Promise<Check[]> {
  const { data: snap, error } = await db.rpc("health_snapshot");
  const s = snap ?? {};
  const mins = s.last_ok ? Math.round((Date.now() - Date.parse(s.last_ok)) / 60000) : null;
  return Promise.all([
    Promise.resolve<Check>(error ? { key: "watcher", name: "Game alerts", ok: false, detail: `Couldn't read its status: ${error.message}` }
      : !s.cron_active ? { key: "watcher", name: "Game alerts", ok: false, detail: "The every-minute schedule is turned off." }
      : mins === null || mins > 5 ? { key: "watcher", name: "Game alerts", ok: false, detail: mins === null ? "It hasn't run successfully in the last 6 hours." : `It hasn't run successfully in ${mins} minutes.` }
      : (s.bad ?? 0) >= 3 ? { key: "watcher", name: "Game alerts", ok: false, detail: `${s.bad} of its last ${s.recent} runs had problems: ${s.sample ?? ""}` }
      : { key: "watcher", name: "Game alerts", ok: true, detail: "" }),
    safe("espn", "ESPN scores", async () => {
      const r = await get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
      return [r.status === 200 && r.text.includes('"events"'), `ESPN answered ${r.status}. NHL and MLB game alerts switch to NHL.com / MLB.com automatically; other sports wait for ESPN.`];
    }),
    safe("teams", "Team lists", async () => {
      const r = await get(`${BASE}/functions/v1/teams?league=nfl`, 30000);
      const n = r.status === 200 ? (JSON.parse(r.text).teams ?? []).length : 0;
      return [n > 0, r.status === 200 ? "It returned no teams." : `It answered ${r.status}.`];
    }),
    safe("site", "The app's website", async () => {
      const r = await get(APP_URL);
      return [r.status === 200 && /Sports Digest/.test(r.text), `${APP_URL} answered ${r.status}.`];
    }),
    safe("email", "Daily email", async () => {
      // The email job reports each run to the audit log. Nothing reported yet = not judged.
      const { data } = await db.from("audit_log").select("at,level,title,detail").eq("source", "email").order("at", { ascending: false }).limit(1);
      const last = (data ?? [])[0];
      if (!last) return [true, ""];
      const hrs = (Date.now() - Date.parse(last.at)) / 3600e3;
      if (last.level === "error") return [false, `${last.title} ${last.detail}`.slice(0, 300)];
      return [hrs < 26, `It hasn't run in ${Math.round(hrs)} hours.`];
    }),
  ]);
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || req.headers.get("x-cron-secret") !== secret) return new Response("Forbidden", { status: 403 });
  const test = new URL(req.url).searchParams.get("test") === "1";
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!key) { try { key = Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"))[0] as string ?? ""; } catch { /* none */ } }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com", Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);

  const results = await checks(db);
  const now = Date.now();
  const keys = results.map(r => `health:${r.key}`);
  const { data: rows } = await db.from("notify_seen").select("key,value").in("key", keys);
  const prev = new Map(((rows ?? []) as any[]).map(r => [r.key, JSON.parse(r.value || "{}")]));
  const alerts: { title: string; body: string }[] = [];
  const saves: any[] = [];
  const log: any[] = [];   // audit_log rows (the Admin page in the app shows these)
  for (const r of results) {
    const k = `health:${r.key}`, p = prev.get(k) ?? {};
    let n: any;
    if (!r.ok) {
      const fails = (p.fails ?? 0) + 1;                  // two checks in a row (10 min) before alerting, to skip blips
      const due = fails >= 2 && (!p.alerted || now - p.alerted > 6 * 3600e3);
      if (due) alerts.push({ title: `⚠️ Sports Digest: ${r.name} ${p.alerted ? "still isn't working" : "isn't working"}`, body: r.detail });
      if (fails === 1) log.push({ source: "watchdog", level: "warn", title: `${r.name}: check failed`, detail: r.detail });
      else if (due) log.push({ source: "watchdog", level: "error", title: `${r.name} ${p.alerted ? "still isn't working" : "isn't working"} (alert sent)`, detail: r.detail });
      n = { fails, since: p.since ?? now, alerted: due ? now : p.alerted ?? 0, detail: r.detail };
    } else {
      const down = `It was down for about ${Math.max(1, Math.round((now - (p.since ?? now)) / 60000))} minutes.`;
      if (p.alerted) alerts.push({ title: `✅ Sports Digest: ${r.name} is working again`, body: down });
      if (p.fails) log.push({ source: "watchdog", level: "ok", title: `${r.name} is working again`, detail: down });
      n = { fails: 0 };
    }
    saves.push({ key: k, value: JSON.stringify(n), at: new Date(now).toISOString() });
  }
  await db.from("notify_seen").upsert(saves);

  // Game watcher errors since the last check (one row per distinct error, with a count).
  try {
    const { data: errs } = await db.rpc("notify_errors", { since: new Date(now - 10 * 60e3 - 30e3).toISOString() });
    const seen = new Map<string, { n: number; first: string }>();
    const backups = new Map<string, { n: number; first: string; last: string }>();   // league -> runs that used its own feed
    for (const e of (errs ?? []) as any[]) {
      let msgs: string[] = [];
      try {
        const j = JSON.parse(e.body);
        if (Array.isArray(j.errors) && j.errors.length) msgs = j.errors.map(String);
        else if (e.status !== 200 || j.error) msgs = [j.error ? String(j.error) : `HTTP ${e.status}`];
        for (const b of Array.isArray(j.backup) ? j.backup.map(String) : []) {
          const lg = b.split(" ")[0], x = backups.get(lg);
          x ? (x.n++, x.last = b) : backups.set(lg, { n: 1, first: e.created, last: b });
        }
      } catch {
        // Not JSON = the request never reached the watcher (a web-server error page). Say so in plain words.
        msgs = [e.status >= 500 && e.status < 600
          ? `Supabase's servers had a hiccup and the watcher didn't run that minute (HTTP ${e.status}).`
          : `HTTP ${e.status}: ${String(e.body).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`];
      }
      for (const m of msgs) { const x = seen.get(m); x ? x.n++ : seen.set(m, { n: 1, first: e.created }); }
    }
    // One or two blips in 10 minutes = info (the next runs worked); 3+ = a warning worth a look.
    for (const [m, x] of seen) {
      const blip = /hiccup/.test(m);
      const level = blip && x.n < 3 ? "info" : "warn";
      log.push({ source: "watcher", level, title: blip ? `Game watcher skipped ${x.n === 1 ? "a minute" : `${x.n} minutes`} (server hiccup)` : `Game watcher error${x.n > 1 ? ` (${x.n}×)` : ""}`,
        detail: (blip && x.n < 3 ? m + " The next run worked, so nothing was missed for long." : m).slice(0, 600), at: x.first });
    }
    for (const [lg, x] of backups) log.push({ source: "watcher", level: "info", title: `${lg} alerts used the ${lg === "NHL" ? "NHL.com" : "MLB.com"} backup feed${x.n > 1 ? ` (${x.n}×)` : ""}`,
      detail: `ESPN's scoreboard didn't load, so ${lg} scores came from the league's own feed. Latest: ${x.last}`.slice(0, 600), at: x.first });
  } catch { /* the log is best-effort */ }

  if (test) log.push({ source: "watchdog", level: "info", title: "Test notification sent", detail: results.map(r => `${r.name} ${r.ok ? "✓" : "✗"}`).join(", ") });
  if (test) alerts.push({ title: "🛡️ Sports Digest watchdog is on", body: `Checking every 10 minutes. Right now: ${results.map(r => `${r.name} ${r.ok ? "✓" : "✗"}`).join(", ")}.` });

  let sent = 0;
  if (alerts.length) {
    const { data: admins } = await db.from("app_admins").select("user_id");
    const ids = ((admins ?? []) as any[]).map(a => a.user_id);
    const { data: phones } = ids.length ? await db.from("push_subscriptions").select("endpoint,p256dh,auth").in("user_id", ids) : { data: [] };
    for (const a of alerts) for (const ph of (phones ?? []) as any[]) {
      try {
        await webpush.sendNotification({ endpoint: ph.endpoint, keys: { p256dh: ph.p256dh, auth: ph.auth } },
          JSON.stringify({ title: a.title, body: a.body, tag: "sd-health", url: `${APP_URL}#admin` }), { TTL: 24 * 3600, urgency: "high" });
        sent++;
      } catch { /* a phone that turned notifications off; "notify" cleans those up */ }
    }
  }
  if (log.length) await db.from("audit_log").insert(log.map(l => ({ ...l, at: l.at ?? new Date(now).toISOString() })));   // every row needs the same columns
  if (new Date(now).getUTCMinutes() < 10 && new Date(now).getUTCHours() === 9)     // once a day: keep 90 days
    await db.from("audit_log").delete().lt("at", new Date(now - 90 * 86400e3).toISOString());
  return Response.json({ checks: results.map(r => ({ [r.key]: r.ok ? "ok" : r.detail })), alerts: alerts.map(a => a.title), sent });
});
