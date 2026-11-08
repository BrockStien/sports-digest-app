// Sports Digest calendar feed (Supabase Edge Function "calendar").
// Each person gets a private link: /functions/v1/calendar?t=<their calendar token>.
// Phones and Google/Outlook subscribe to it and refresh it on their own, so time changes,
// TV channels and final scores show up without doing anything.
// Favorite teams' games (pro and college) come from ESPN team schedules; golf, F1 and NASCAR
// show the season's events as all-day entries.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const BASE = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const APP_URL = (Deno.env.get("APP_URL") || "https://brockstien.github.io/sports-digest-app/").replace(/\/?$/, "/");
const TEAM_LEAGUES: Record<string, { path: string; emoji: string; hours: number }> = {
  nfl: { path: "football/nfl", emoji: "🏈", hours: 3.5 },
  nba: { path: "basketball/nba", emoji: "🏀", hours: 2.5 },
  wnba: { path: "basketball/wnba", emoji: "🏀", hours: 2 },
  nhl: { path: "hockey/nhl", emoji: "🏒", hours: 2.75 },
  mlb: { path: "baseball/mlb", emoji: "⚾", hours: 3 },
  cfb: { path: "football/college-football", emoji: "🏈", hours: 3.5 },
  cbb: { path: "basketball/mens-college-basketball", emoji: "🏀", hours: 2 },
};
const EVENT_LEAGUES: Record<string, { path: string; emoji: string; name: string }> = {
  pga: { path: "golf/pga", emoji: "⛳", name: "PGA Tour" },
  f1: { path: "racing/f1", emoji: "🏁", name: "F1" },
  nascar: { path: "racing/nascar-premier", emoji: "🏁", name: "NASCAR" },
};

async function get(url: string) {
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---- iCalendar text
const esc = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
// Lines longer than 75 bytes are folded (required by the format).
function fold(line: string) {
  const out: string[] = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > 74) { out.push(cur); cur = " " + ch; bytes = 1 + b; } else { cur += ch; bytes += b; }
  }
  out.push(cur);
  return out.join("\r\n");
}
type Ev = { uid: string; summary: string; start: number; end: number; allDay?: boolean; description?: string; location?: string; url?: string };
export function ics(name: string, events: Ev[], now = Date.now()) {
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sports Digest//Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`, "X-WR-CALDESC:Your teams' games from Sports Digest", "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"];
  for (const e of events) {
    L.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${stamp(now)}`);
    if (e.allDay) L.push(`DTSTART;VALUE=DATE:${day(e.start)}`, `DTEND;VALUE=DATE:${day(e.end)}`);
    else L.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`);
    L.push(`SUMMARY:${esc(e.summary)}`);
    if (e.description) L.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.location) L.push(`LOCATION:${esc(e.location)}`);
    if (e.url) L.push(`URL:${e.url}`);
    L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}

// ---- games
const scoreOf = (s: any) => s == null ? null : typeof s === "object" ? (s.displayValue ?? s.value ?? null) : s;
export function teamEvents(league: string, teamId: string, sched: any, now = Date.now()): Ev[] {
  const L = TEAM_LEAGUES[league];
  const out: Ev[] = [];
  for (const e of sched?.events ?? []) {
    const c = e.competitions?.[0] ?? {};
    const start = Date.parse(e.date);
    if (!Number.isFinite(start) || start < now - 45 * 86400e3 || start > now + 200 * 86400e3) continue;
    const cs = c.competitors ?? [];
    const home = cs.find((x: any) => x.homeAway === "home") ?? cs[0] ?? {};
    const away = cs.find((x: any) => x.homeAway === "away") ?? cs[1] ?? {};
    const nm = (x: any) => x.team?.shortDisplayName ?? x.team?.displayName ?? "TBD";
    const st = c.status?.type ?? {};
    const tbd = c.timeValid === false || st.name === "STATUS_TBD";
    const tv = [...new Set((c.broadcasts ?? []).map((b: any) => b.media?.shortName ?? b.names?.[0]).filter(Boolean))].join(", ");
    const me = cs.find((x: any) => String(x.team?.id ?? x.id) === teamId);
    const op = cs.find((x: any) => x !== me);
    const lines: string[] = [];
    let title = `${L.emoji} ${nm(away)} @ ${nm(home)}`;
    if (st.state === "post" && me && op) {
      const r = me.winner ? "W" : op.winner ? "L" : "T";
      title += ` (${r} ${scoreOf(me.score)}–${scoreOf(op.score)})`;
      lines.push(`Final: ${nm(away)} ${scoreOf(away.score)}, ${nm(home)} ${scoreOf(home.score)}`);
    }
    if (/postpon|cancel/i.test(st.name ?? "")) { title = `Postponed: ${title}`; lines.push(st.detail ?? "Postponed"); }
    if (tv) lines.push(`TV: ${tv}`);
    if (tbd) lines.push("Start time to be announced");
    const tk = c.tickets?.[0];
    if (tk?.startingPrice && st.state === "pre") lines.push(`Tickets from $${Math.round(tk.startingPrice)}${tk.links?.[0]?.href ? ` · ${tk.links[0].href}` : ""}`);
    lines.push(`Sports Digest: ${APP_URL}`);
    out.push({
      uid: `${league}-${e.id}@sports-digest`, summary: title, description: lines.join("\n"),
      start, end: tbd ? start + 86400e3 : start + L.hours * 3600e3, allDay: tbd,
      location: [c.venue?.fullName, c.venue?.address?.city].filter(Boolean).join(", "),
      url: (e.links ?? []).find((l: any) => (l.rel ?? []).includes("summary"))?.href,
    });
  }
  return out;
}
export function seasonEvents(league: string, board: any, now = Date.now()): Ev[] {
  const L = EVENT_LEAGUES[league];
  const cal = board?.leagues?.[0]?.calendar ?? [];
  return cal.filter((c: any) => c && typeof c === "object" && c.startDate).map((c: any): Ev => {
    const s = Date.parse(c.startDate), e = Date.parse(c.endDate || c.startDate);
    return { uid: `${league}-${c.id ?? day(s)}@sports-digest`, summary: `${L.emoji} ${c.label ?? L.name}`, start: s, end: Math.max(e, s) + 86400e3, allDay: true,
      description: `${L.name}\nSports Digest: ${APP_URL}` };
  }).filter((e: Ev) => e.start > now - 30 * 86400e3 && e.start < now + 200 * 86400e3);
}

const text = (body: string, status = 200, type = "text/plain; charset=utf-8") =>
  new Response(body, { status, headers: { "Content-Type": type, "Access-Control-Allow-Origin": "*", ...(status === 200 ? { "Cache-Control": "public, max-age=1800" } : {}) } });

if (!(globalThis as any).__SD_TEST__) Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(token)) return text("Missing or bad calendar link.", 404);
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!key) { try { key = Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"))[0] as string ?? ""; } catch { /* none */ } }
  const db = createClient(BASE, key, { auth: { persistSession: false } });
  const { data: u } = await db.from("subscribers").select("name,leagues,favorite_teams").eq("calendar_token", token).maybeSingle();
  if (!u) return text("This calendar link was reset or removed. Get the new one in Sports Digest → My Teams.", 404);
  const favs = new Set(((u.favorite_teams ?? []) as string[]).map(f => f.toLowerCase()));
  const leagues = ((u.leagues ?? []) as string[]);
  const events: Ev[] = [];
  await Promise.all(leagues.map(async lg => {
    try {
      if (TEAM_LEAGUES[lg]) {
        const list = (await (await fetch(`${BASE}/functions/v1/teams?league=${lg}`, { signal: AbortSignal.timeout(20000) })).json()).teams ?? [];
        const mine = list.filter((t: any) => [t.name, t.nick, t.short, t.abbr].filter(Boolean).some((n: string) => favs.has(n.toLowerCase())));
        await Promise.all(mine.slice(0, 12).map(async (t: any) => {
          try { events.push(...teamEvents(lg, String(t.id), await get(`${SITE}/${TEAM_LEAGUES[lg].path}/teams/${t.id}/schedule`))); } catch { /* skip team */ }
        }));
      } else if (EVENT_LEAGUES[lg]) {
        events.push(...seasonEvents(lg, await get(`${SITE}/${EVENT_LEAGUES[lg].path}/scoreboard`)));
      }
    } catch { /* skip league */ }
  }));
  const seen = new Set<string>();
  const unique = events.filter(e => !seen.has(e.uid) && seen.add(e.uid)).sort((a, b) => a.start - b.start);
  return text(ics(`Sports Digest${u.name ? " · " + u.name : ""}`, unique), 200, "text/calendar; charset=utf-8");
});
