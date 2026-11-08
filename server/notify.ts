// Sports Digest game watcher (Supabase Edge Function "notify").
// Runs every minute (see 3-schedule.sql). In Supabase, create a function named "notify" and paste this whole file in. Checks ESPN for your users' favorite teams and sends
// phone notifications: starting soon, score updates, finals, big plays, close finishes, a morning
// summary, and optional extras: highlight clips, player milestones, comebacks/overtime/upsets,
// period scores, team news, schedule changes, standings, ticket price drops, and golf/racing/UFC.
// Each person picks which ones they want in the app's My Teams screen.
//
// Secrets it needs (Supabase → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT  (from the setup guide)
//   CRON_SECRET  any long random text; the schedule sends it so strangers can't trigger alerts
//   APP_URL      your app's address, opened when someone taps a notification
// SUPABASE_URL and the service key are provided by Supabase automatically.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

// ============================================================ ESPN
const ESPN = "https://site.api.espn.com/apis/site/v2/sports";
// ESPN turns away requests that don't look like they come from a browser.
const ESPN_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
export const LEAGUES: Record<string, { path: string; params?: Record<string, string>; name: string; emoji: string }> = {
  nfl: { path: "football/nfl", name: "NFL", emoji: "🏈" },
  nba: { path: "basketball/nba", name: "NBA", emoji: "🏀" },
  nhl: { path: "hockey/nhl", name: "NHL", emoji: "🏒" },
  mlb: { path: "baseball/mlb", name: "MLB", emoji: "⚾" },
  cfb: { path: "football/college-football", params: { groups: "80", limit: "300" }, name: "College Football", emoji: "🏈" },
  cbb: { path: "basketball/mens-college-basketball", params: { groups: "50", limit: "400" }, name: "College Basketball", emoji: "🏀" },
};

export type Team = { id: string; abbr: string; name: string; full: string; score: number; rank?: number | null; hits?: number | null };
export type Game = {
  key: string; league: string; id: string; state: "pre" | "in" | "post"; detail: string; statusName?: string;
  period: number; clock: string; start: number; tbd: boolean; postponed: boolean;
  home: Team; away: Team; tv: string; link: string; plays?: Play[]; summary?: any;
  src?: "nhl" | "mlb";   // set when the game came from a league's own feed because ESPN failed
};
export type Play = { id: string; text: string; type: string; yards: number; team: string; strength?: string };

const num = (v: unknown) => {
  if (v && typeof v === "object") v = (v as { value?: unknown; displayValue?: unknown }).value ?? (v as { displayValue?: unknown }).displayValue;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function parseScoreboard(json: any, league: string): Game[] {
  const out: Game[] = [];
  for (const e of json?.events ?? []) {
    const comp = (e.competitions ?? [])[0] ?? {};
    const cs = comp.competitors ?? [];
    const side = (c: any): Team => ({
      id: String(c?.team?.id ?? ""), abbr: c?.team?.abbreviation ?? "?",
      name: c?.team?.shortDisplayName ?? c?.team?.displayName ?? "?",
      full: c?.team?.displayName ?? c?.team?.shortDisplayName ?? "?", score: num(c?.score),
      rank: c?.curatedRank?.current && c.curatedRank.current <= 25 ? Number(c.curatedRank.current) : null,
      hits: c?.hits != null ? num(c.hits) : null,
    });
    const home = side(cs.find((c: any) => c.homeAway === "home") ?? cs[0]);
    const away = side(cs.find((c: any) => c.homeAway === "away") ?? cs[1]);
    const st = (e.status ?? comp.status ?? {});
    const type = st.type ?? {};
    const tv = [...new Set((comp.broadcasts ?? []).flatMap((b: any) => b.names ?? []))].join(", ");
    out.push({
      key: `${league}:${e.id}`, league, id: String(e.id), state: type.state ?? "pre", statusName: type.name ?? "",
      detail: type.shortDetail ?? type.detail ?? "", period: num(st.period), clock: String(st.displayClock ?? ""),
      start: Date.parse(e.date), tbd: comp.timeValid === false,
      postponed: ["STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_SUSPENDED"].includes(type.name),
      home, away, tv,
      link: ((e.links ?? []).find((l: any) => (l.rel ?? []).includes("summary")) ?? {}).href ?? "",
    });
  }
  return out;
}

// ============================================================ backup feeds (when ESPN fails)
// The NHL and MLB publish their own free scoreboards. If ESPN's scoreboard won't load, the Wild/Twins
// (and every other NHL/MLB game) come from there instead, so score and final alerts keep working.
// Games are matched to the last good ESPN copy (saved every 10 minutes) by team, so they keep ESPN's
// ids and names and alerts carry on as if nothing happened.
export const BACKUP: Record<string, string> = { nhl: "NHL.com", mlb: "MLB.com" };
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const norm = (s: string) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
// ESPN-style "11/7 - 7:00 PM EST" for games that haven't started.
const preDetail = (ms: number) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.month}/${p.day} - ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
};
type BackupTeam = { nick: string; full: string; abbr: string; score: number; hits?: number | null };
type BackupGame = { id: string; start: number; state: Game["state"]; statusName: string; detail: string; period: number; clock: string; postponed: boolean; tv: string; home: BackupTeam; away: BackupTeam };

// api-web.nhle.com/v1/score/YYYY-MM-DD (+ /v1/schedule for full team names when there's no ESPN copy)
export function parseNhl(score: any, schedule?: any): BackupGame[] {
  const places = new Map<string, string>();
  for (const day of schedule?.gameWeek ?? []) for (const g of day.games ?? []) for (const t of [g.homeTeam, g.awayTeam])
    if (t?.abbrev && t.placeName?.default) places.set(t.abbrev, `${t.placeName.default} ${t.commonName?.default ?? ""}`.trim());
  return (score?.games ?? []).map((g: any): BackupGame => {
    const pd = g.periodDescriptor ?? {}, n = Number(pd.number ?? g.period ?? 0), type = pd.periodType ?? "REG";
    const pname = type === "SO" ? "SO" : type === "OT" ? (n > 4 ? `${n - 3}OT` : "OT") : ordinal(n);
    const live = g.gameState === "LIVE" || g.gameState === "CRIT";
    const done = g.gameState === "OFF" || g.gameState === "FINAL";
    const brk = live && (g.clock?.inIntermission || (g.clock && !g.clock.running && Number(g.clock.secondsRemaining) === 0 && type !== "SO"));
    const last = g.gameOutcome?.lastPeriodType;
    const team = (t: any): BackupTeam => ({ nick: t?.name?.default ?? t?.commonName?.default ?? "?", abbr: t?.abbrev ?? "?", score: Number(t?.score ?? 0),
      full: places.get(t?.abbrev) ?? t?.name?.default ?? "?" });
    return {
      id: String(g.id), start: Date.parse(g.startTimeUTC), period: n,
      state: live ? "in" : done ? "post" : "pre",
      statusName: done ? "STATUS_FINAL" : brk ? "STATUS_END_PERIOD" : live ? "STATUS_IN_PROGRESS" : "STATUS_SCHEDULED",
      detail: done ? (last === "OT" || last === "SO" ? `Final/${last}` : "Final") : brk ? `End of ${pname}` : live ? (type === "SO" ? "Shootout" : `${g.clock?.timeRemaining ?? ""} - ${pname}`) : preDetail(Date.parse(g.startTimeUTC)),
      clock: live ? String(g.clock?.timeRemaining ?? "") : "",
      postponed: ["PPD", "CNCL", "SUSP"].includes(g.gameScheduleState),
      tv: [...new Set((g.tvBroadcasts ?? []).filter((b: any) => b.countryCode === "US").map((b: any) => b.network))].join(", "),
      home: team(g.homeTeam), away: team(g.awayTeam),
    };
  });
}

// statsapi.mlb.com/api/v1/schedule?sportId=1&date=YYYY-MM-DD&hydrate=linescore,team
export function parseMlb(json: any): BackupGame[] {
  const out: BackupGame[] = [];
  for (const day of json?.dates ?? []) for (const g of day.games ?? []) {
    const st = g.status ?? {}, ls = g.linescore ?? {};
    const inning = Number(ls.currentInning ?? 0);
    const postponed = /postponed|cancel|suspended/i.test(st.detailedState ?? "");
    const state: Game["state"] = postponed ? "post" : st.abstractGameState === "Live" ? "in" : st.abstractGameState === "Final" ? "post" : "pre";
    const half = ({ Top: "Top", Bottom: "Bot", Middle: "Mid", End: "End" } as any)[ls.inningState] ?? "";
    const team = (side: "home" | "away"): BackupTeam => {
      const t = g.teams?.[side] ?? {};
      return { nick: t.team?.teamName ?? t.team?.clubName ?? t.team?.name ?? "?", full: t.team?.name ?? "?", abbr: t.team?.abbreviation ?? "?",
        score: Number(t.score ?? ls.teams?.[side]?.runs ?? 0), hits: ls.teams?.[side]?.hits != null ? Number(ls.teams[side].hits) : null };
    };
    out.push({
      id: String(g.gamePk), start: Date.parse(g.gameDate), period: inning, clock: "", postponed, tv: "",
      state, statusName: state === "post" ? "STATUS_FINAL" : state === "in" ? "STATUS_IN_PROGRESS" : "STATUS_SCHEDULED",
      detail: postponed ? String(st.detailedState) : state === "post" ? (inning > 9 ? `Final/${inning}` : "Final")
        : state === "in" ? (/delay/i.test(st.detailedState ?? "") ? `${st.detailedState} · ${half} ${ordinal(inning)}` : `${half} ${ordinal(inning)}`.trim()) : preDetail(Date.parse(g.gameDate)),
      home: team("home"), away: team("away"),
    });
  }
  return out;
}

// Turn backup games into regular games, reusing the saved ESPN copy (same keys, names, links) when teams match.
export function mergeBackup(league: string, games: BackupGame[], espnCopy: Game[]): Game[] {
  const same = (e: Team, b: BackupTeam) => norm(e.full) === norm(b.full) || norm(e.name) === norm(b.nick) || norm(e.full).endsWith(norm(b.nick)) || (e.abbr && e.abbr === b.abbr);
  return games.map(b => {
    const e = espnCopy.find(x => same(x.home, b.home) && same(x.away, b.away) && Math.abs((x.start || 0) - b.start) < 12 * 3600e3);
    const side = (et: Team | undefined, bt: BackupTeam): Team => et ? { ...et, score: bt.score, hits: bt.hits ?? null }
      : { id: `${league}-${bt.abbr}`, abbr: bt.abbr, name: bt.nick, full: bt.full, score: bt.score, rank: null, hits: bt.hits ?? null };
    return {
      key: e?.key ?? `${league}:${BACKUP[league]}-${b.id}`, league, id: e?.id ?? b.id, src: league as "nhl" | "mlb",
      state: b.state, statusName: b.statusName, detail: b.detail, period: b.period, clock: b.clock, start: b.start, tbd: false,
      postponed: b.postponed, home: side(e?.home, b.home), away: side(e?.away, b.away), tv: e?.tv || b.tv, link: e?.link ?? "",
    };
  });
}

export async function backupBoard(d: Deps, league: string, ymd: string, espnCopy: Game[]): Promise<Game[]> {
  const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  if (league === "nhl") {
    const score = await d.fetchJSON(`https://api-web.nhle.com/v1/score/${date}`);
    const schedule = espnCopy.length ? undefined : await d.fetchJSON(`https://api-web.nhle.com/v1/schedule/${date}`).catch(() => undefined);
    return mergeBackup(league, parseNhl(score, schedule), espnCopy);
  }
  if (league === "mlb") return mergeBackup(league, parseMlb(await d.fetchJSON(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,team`)), espnCopy);
  throw new Error("no backup feed for " + league);
}

// Plays from a game summary (football drives, baseball/basketball play lists).
export function parsePlays(summary: any): Play[] {
  const raw: any[] = [];
  const d = summary?.drives;
  for (const dr of [...(d?.previous ?? []), ...(d?.current ? [d.current] : [])]) raw.push(...(dr.plays ?? []));
  raw.push(...(summary?.plays ?? []));
  const seen = new Set<string>();
  return raw.filter(p => p && p.id && !seen.has(String(p.id)) && seen.add(String(p.id))).map(p => ({
    id: String(p.id), text: String(p.text ?? ""), type: String(p.type?.text ?? p.type?.type ?? ""),
    yards: num(p.statYardage), team: String(p.team?.id ?? p.start?.team?.id ?? ""), strength: String(p.strength?.text ?? ""),
  }));
}

// ============================================================ who follows what
export type User = {
  id: string; name: string; timezone: string; leagues: string[]; favs: Set<string>;
  notify_start: boolean; notify_final: boolean; notify_scores: boolean; notify_big_plays: boolean;
  notify_digest: boolean; notify_start_minutes: number; notify_digest_hour: number;
  notify_highlights?: boolean; notify_milestones?: boolean; notify_drama?: boolean; notify_periods?: boolean;
  notify_news?: boolean; notify_schedule?: boolean; notify_standings?: boolean; notify_tickets?: boolean;
  notify_ticket_price?: number; notify_events?: boolean;
};

export function follows(u: User, g: Game): boolean {
  if (!u.leagues.includes(g.league)) return false;
  for (const t of [g.home, g.away]) for (const n of [t.full, t.name, t.abbr]) if (n && u.favs.has(n.toLowerCase())) return true;
  return false;
}
// The favorite side, for wording like "Wild win!".
export function favSide(u: User, g: Game): Team | null {
  for (const t of [g.home, g.away]) for (const n of [t.full, t.name, t.abbr]) if (n && u.favs.has(n.toLowerCase())) return t;
  return null;
}

// ============================================================ detecting events
export type GameState = {
  state?: string; hs?: number; as?: number; final?: boolean; close?: boolean;
  startSent?: string[]; seen?: string[]; baseline?: boolean;
  lo?: number; hi?: number; cbH?: boolean; cbA?: boolean; ot?: boolean; upset?: boolean; brk?: string; nohit?: boolean;
  vids?: string[]; ms?: string[]; bigN?: number;
};
export type Alert = {
  kind: "start" | "score" | "final" | "big" | "close" | "digest" | "highlight" | "milestone" | "drama" | "period"
      | "news" | "schedule" | "standings" | "tickets" | "event";
  game: Game | null; title: string; body: string; tag: string; topic?: string; onlyUser?: string; url?: string;
};

const score = (g: Game) => `${g.away.name} ${g.away.score}, ${g.home.name} ${g.home.score}`;
const clockSeconds = (c: string) => {
  const m = c.match(/^(\d+):(\d{2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const s = Number(c);
  return Number.isFinite(s) ? s : 9999;
};

// "Close finish": tight game late. Returns true once per game.
export function isCloseFinish(g: Game): boolean {
  if (g.state !== "in") return false;
  const margin = Math.abs(g.home.score - g.away.score);
  const secs = clockSeconds(g.clock);
  switch (g.league) {
    case "nfl": case "cfb": return g.period >= 4 && secs <= 300 && margin <= 8;
    case "nba": return g.period >= 4 && secs <= 120 && margin <= 5;
    case "cbb": return g.period >= 2 && secs <= 120 && margin <= 5;
    case "nhl": return g.period >= 3 && secs <= 300 && margin <= 1;
    case "mlb": return g.period >= 9 && margin <= 1;
  }
  return false;
}

export function isBigPlay(league: string, p: Play): boolean {
  const t = `${p.type} ${p.text}`.toLowerCase();
  if (league === "nfl" || league === "cfb") {
    if (/intercept/.test(t)) return true;
    if (/fumble recovery \(opponent\)|fumble return|fumbled.*recovered by .*(?:and returned|for a touchdown)/.test(t)) return true;
    if (p.yards >= 40 && !/punt|kickoff|field goal|penalty|timeout|end of/.test(t)) return true;
    return false;
  }
  if (league === "mlb") return /home run|homered|homers|grand slam/.test(t);
  // Basketball: alley-oop dunks. Hockey: short-handed, penalty-shot and empty-net goals.
  if (league === "nba" || league === "cbb") return /alley oop dunk/.test(t);
  if (league === "nhl") return /goal/.test(p.type.toLowerCase()) && (/short.?handed/i.test(p.strength ?? "") || /penalty shot|empty net/.test(t));
  return false;
}

// Regulation length (periods/innings) and the deficit that counts as a comeback, by sport.
const REGULATION: Record<string, number> = { nfl: 4, cfb: 4, nba: 4, cbb: 2, nhl: 3, mlb: 9 };
const COMEBACK: Record<string, number> = { nfl: 10, cfb: 10, nba: 12, cbb: 10, nhl: 2, mlb: 3 };
const MAX_DUNKS = 4;   // basketball big-play alerts per game

// Compare a game with what we saw last time. Returns alerts (for everyone who follows it) and new state.
export function gameEvents(g: Game, prev: GameState | undefined): { alerts: Alert[]; next: GameState } {
  const lg = LEAGUES[g.league];
  const alerts: Alert[] = [];
  const next: GameState = { ...(prev ?? {}), state: g.state, hs: g.home.score, as: g.away.score };
  const firstLook = !prev || !prev.state;

  if (g.postponed) return { alerts, next: { ...next, final: true } };

  // ---- Game drama: comebacks, overtime, upset alerts (optional).
  const diff = g.home.score - g.away.score;
  if (g.state === "in") {
    next.lo = Math.min(prev?.lo ?? diff, diff);
    next.hi = Math.max(prev?.hi ?? diff, diff);
    const T = COMEBACK[g.league];
    if (!firstLook && T) {
      if (diff > 0 && (prev!.lo ?? 0) <= -T && !prev!.cbH) {
        next.cbH = true;
        alerts.push({ kind: "drama", game: g, tag: `cb-${g.key}`, title: `🔄 Comeback! ${g.home.name} lead ${score(g)}`,
          body: `Down ${-(prev!.lo ?? 0)} earlier. ${g.detail}` });
      }
      if (diff < 0 && (prev!.hi ?? 0) >= T && !prev!.cbA) {
        next.cbA = true;
        alerts.push({ kind: "drama", game: g, tag: `cb-${g.key}`, title: `🔄 Comeback! ${g.away.name} lead ${score(g)}`,
          body: `Down ${prev!.hi} earlier. ${g.detail}` });
      }
    }
    const reg = REGULATION[g.league];
    if (reg && g.period > reg && !prev?.ot) {
      next.ot = true;
      if (!firstLook) alerts.push({ kind: "drama", game: g, tag: `ot-${g.key}`,
        title: `⏱️ ${g.league === "mlb" ? "Extra innings" : "Overtime"}: ${score(g)}`, body: `${g.detail}${g.tv ? ` · ${g.tv}` : ""}` });
    }
    // Upset alert: a ranked college team losing late to an unranked or lower-ranked team.
    const late = g.league === "cfb" ? g.period >= 4 : g.league === "cbb" ? g.period >= 2 && clockSeconds(g.clock) <= 600 : false;
    if (late && !prev?.upset && !firstLook) {
      const [fav, dog] = diff < 0 ? [g.home, g.away] : diff > 0 ? [g.away, g.home] : [null, null];
      if (fav && dog && fav.rank && (!dog.rank || dog.rank > fav.rank)) {
        next.upset = true;
        alerts.push({ kind: "drama", game: g, tag: `upset-${g.key}`,
          title: `🚨 Upset alert: ${dog.rank ? "#" + dog.rank + " " : ""}${dog.name} lead #${fav.rank} ${fav.name}`,
          body: `${score(g)} · ${g.detail}${g.tv ? ` · ${g.tv}` : ""}` });
      }
    }
    // No-hitter watch (baseball, 6th inning on).
    if (g.league === "mlb" && g.period >= 6 && !prev?.nohit && !firstLook) {
      const side = g.away.hits === 0 ? g.away : g.home.hits === 0 ? g.home : null;
      if (side) {
        next.nohit = true;
        const pitching = side === g.away ? g.home : g.away;
        alerts.push({ kind: "milestone", game: g, tag: `nohit-${g.key}`,
          title: `⚾ No-hitter watch: ${pitching.name} haven't allowed a hit`, body: `${score(g)} · ${g.detail}` });
      }
    }
  }

  // ---- Score at each break (end of a quarter/period, halftime). Optional.
  if (g.statusName === "STATUS_END_PERIOD" || g.statusName === "STATUS_HALFTIME") {
    const k = `${g.period}:${g.statusName}`;
    if (prev?.brk !== k) {
      next.brk = k;
      if (!firstLook) alerts.push({ kind: "period", game: g, tag: `score-${g.key}`, title: `${lg.emoji} ${g.detail || "Break"}: ${score(g)}`, body: g.tv ? `Watch on ${g.tv}` : "" });
    }
  }

  // Score changes (only during the game, and not the first time we see it).
  if (g.state === "in" && !firstLook && (prev!.hs !== g.home.score || prev!.as !== g.away.score)) {
    const scorer = g.home.score > (prev!.hs ?? 0) ? g.home : g.away.score > (prev!.as ?? 0) ? g.away : null;
    alerts.push({
      kind: "score", game: g, tag: `score-${g.key}`, topic: `s${g.id}`.slice(0, 32),
      title: `${lg.emoji} ${score(g)}`,
      body: `${scorer ? `${scorer.name} score${scorer.name.endsWith("s") ? "" : "s"}! · ` : ""}${g.detail}`,
    });
  }

  // Close finish (once).
  if (isCloseFinish(g) && !prev?.close) {
    next.close = true;
    if (!firstLook) alerts.push({
      kind: "close", game: g, tag: `close-${g.key}`,
      title: `⏱️ Close finish: ${score(g)}`, body: `${g.detail}. Tune in${g.tv ? ` on ${g.tv}` : ""}!`,
    });
  }

  // Final (once). Skip games that were already over the first time we looked.
  if (g.state === "post" && !prev?.final) {
    next.final = true;
    if (!firstLook) {
      const w = g.home.score > g.away.score ? g.home : g.away.score > g.home.score ? g.away : null;
      const l = w === g.home ? g.away : g.home;
      alerts.push({
        kind: "final", game: g, tag: `final-${g.key}`,
        title: `${lg.emoji} Final: ${score(g)}`,
        body: w ? `${w.name} beat the ${l.name} ${Math.max(g.home.score, g.away.score)}–${Math.min(g.home.score, g.away.score)}.${/OT|SO|\//.test(g.detail) ? ` (${g.detail})` : ""}`
                  + (g.league === "mlb" && w === g.home && g.period >= 9 && (prev?.hs ?? 0) <= (prev?.as ?? 0) ? " Walk-off win! 🎉" : "")
                : `${g.detail || "Final"}.`,
      });
    }
  }

  // Big plays from the play-by-play (football, baseball). First look just records what's there.
  if (g.plays && g.state === "in") {
    const seen = new Set(prev?.seen ?? []);
    for (const p of g.plays) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (!firstLook && prev?.baseline && isBigPlay(g.league, p)) {
        if (g.league === "nba" || g.league === "cbb") { next.bigN = (next.bigN ?? 0) + 1; if (next.bigN > MAX_DUNKS) continue; }
        alerts.push({
          kind: "big", game: g, tag: `big-${g.key}-${p.id}`,
          title: `🔥 Big play · ${g.away.name} @ ${g.home.name}`,
          body: (p.text.length > 160 ? p.text.slice(0, 157) + "…" : p.text) + ` (${score(g)})`,
        });
      }
    }
    next.seen = [...seen].slice(-400);
    next.baseline = true;
  }
  return { alerts, next };
}

// ============================================================ highlights & player milestones (from the game summary)
// Box score -> [{name, team, group, stats{LABEL: number}}]
export function boxPlayers(summary: any) {
  const out: { name: string; team: string; group: string; s: Record<string, number> }[] = [];
  for (const tp of summary?.boxscore?.players ?? []) {
    for (const grp of tp.statistics ?? []) {
      const labels: string[] = grp.labels ?? [];
      for (const a of grp.athletes ?? []) {
        const s: Record<string, number> = {};
        labels.forEach((l, i) => { const v = parseFloat(String((a.stats ?? [])[i] ?? "")); if (Number.isFinite(v)) s[l] = v; });
        out.push({ name: a.athlete?.displayName ?? "?", team: tp.team?.displayName ?? "", group: String(grp.name ?? ""), s });
      }
    }
  }
  return out;
}

// Big individual games: [{key, text}] (each announced once per game).
export function milestonesFor(league: string, summary: any): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  const add = (who: string, kind: string, text: string) => out.push({ key: `${who}|${kind}`, text });
  for (const p of boxPlayers(summary)) {
    const s = p.s, n = p.name;
    if (league === "nba" || league === "cbb") {
      const pts = league === "nba" ? 40 : 30;
      if ((s.PTS ?? 0) >= pts) add(n, `pts${pts}`, `${n} has ${s.PTS} points`);
      const tens = ["PTS", "REB", "AST", "STL", "BLK"].filter(k => (s[k] ?? 0) >= 10);
      if (tens.length >= 3) add(n, "td", `${n} has a triple-double (${tens.map(k => `${s[k]} ${k.toLowerCase()}`).join(", ")})`);
    } else if (league === "nhl") {
      if ((s.G ?? 0) >= 3 && p.group !== "goalies") add(n, "hat", `🎩 Hat trick for ${n}!`);
    } else if (league === "nfl" || league === "cfb") {
      const big = league === "nfl" ? { pass: 300, rush: 150, rec: 150 } : { pass: 350, rush: 175, rec: 175 };
      if (p.group === "passing" && (s.YDS ?? 0) >= big.pass) add(n, "pass", `${n} has ${s.YDS} passing yards`);
      if (p.group === "passing" && (s.TD ?? 0) >= 4) add(n, "ptd", `${n} has ${s.TD} touchdown passes`);
      if (p.group === "rushing" && (s.YDS ?? 0) >= big.rush) add(n, "rush", `${n} has ${s.YDS} rushing yards`);
      if (p.group === "receiving" && (s.YDS ?? 0) >= big.rec) add(n, "rec", `${n} has ${s.YDS} receiving yards`);
    } else if (league === "mlb") {
      if ((s.K ?? 0) >= 10 && /pitch/i.test(p.group)) add(n, "k", `${n} has ${s.K} strikeouts`);
      if ((s.HR ?? 0) >= 2 && /bat/i.test(p.group)) add(n, "hr", `${n} has homered ${s.HR} times`);
    }
  }
  return out;
}

// New highlight clips and milestones since last time. The first time we see a game that's
// already under way, existing clips/milestones are just recorded (no flood of old alerts).
export function summaryEvents(g: Game, prev: GameState | undefined, next: GameState): Alert[] {
  const alerts: Alert[] = [];
  const sm = g.summary;
  if (!sm) return alerts;
  const quietStart = !prev || !prev.state || prev.state !== "pre";
  const matchup = `${g.away.name} @ ${g.home.name}`;
  // Highlights
  const vids = (sm.videos ?? []).filter((v: any) => v?.id && v?.links?.web?.href);
  const seenV = new Set(prev?.vids ?? []);
  const baseV = prev?.vids === undefined && quietStart;
  let sent = 0;
  for (const v of vids) {
    const id = String(v.id);
    if (seenV.has(id)) continue;
    seenV.add(id);
    if (baseV || sent >= 3) continue;
    sent++;
    const secs = Number(v.duration) || 0;
    alerts.push({ kind: "highlight", game: g, tag: `hl-${g.key}-${id}`, url: v.links.web.href,
      title: `🎬 ${String(v.headline ?? "New highlight").slice(0, 90)}`,
      body: `${matchup}${secs ? ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : ""} · tap to watch` });
  }
  next.vids = [...seenV].slice(-200);
  // Milestones
  const seenM = new Set(prev?.ms ?? []);
  const baseM = prev?.ms === undefined && quietStart;
  for (const m of milestonesFor(g.league, sm)) {
    if (seenM.has(m.key)) continue;
    seenM.add(m.key);
    if (baseM) continue;
    alerts.push({ kind: "milestone", game: g, tag: `ms-${g.key}-${m.key}`, title: `🔥 ${m.text}`, body: `${score(g)} · ${g.detail}` });
  }
  next.ms = [...seenM];
  return alerts;
}

// ============================================================ golf, racing, UFC (people, not teams)
export const EVENT_LEAGUES: Record<string, { path: string; kind: "golf" | "race" | "fight"; emoji: string }> = {
  pga: { path: "golf/pga", kind: "golf", emoji: "⛳" },
  f1: { path: "racing/f1", kind: "race", emoji: "🏁" },
  nascar: { path: "racing/nascar-premier", kind: "race", emoji: "🏁" },
  ufc: { path: "mma/ufc", kind: "fight", emoji: "🥊" },
};
const personName = (c: any) => c?.athlete?.displayName ?? c?.athlete?.fullName ?? "";
export const likesPerson = (favs: Set<string>, name: string) =>
  !!name && (favs.has(name.toLowerCase()) || favs.has(name.split(" ").slice(-1)[0].toLowerCase()));

// One event's alerts for people who follow someone in it. Returns per-user alerts and new state.
export function eventAlerts(lg: string, ev: any, prev: any, users: User[]): { sends: { user: User; alert: Alert }[]; next: any } {
  const L = EVENT_LEAGUES[lg];
  const sends: { user: User; alert: Alert }[] = [];
  const next: any = { ...(prev ?? {}) };
  const first = !prev || !prev.seen;
  next.seen = true;
  const name = ev.name ?? ev.shortName ?? L.kind;
  const fans = (names: string[]) => users.filter(u => u.notify_events && u.leagues.includes(lg) && names.some(n => likesPerson(u.favs, n)));
  const tag = `ev-${lg}-${ev.id}`;
  const st = (c: any) => c?.status?.type?.state ?? "pre";
  if (L.kind === "golf") {
    const comp = (ev.competitions ?? [])[0] ?? {};
    const ps = (comp.competitors ?? []).slice().sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999));
    const leader = ps[0] && ps[0].score != null ? personName(ps[0]) : "";
    const state = ev.status?.type?.state ?? st(comp);
    if (state === "in" && leader && leader !== prev?.leader && !first)
      for (const u of fans([leader])) sends.push({ user: u, alert: { kind: "event", game: null, tag, title: `⛳ ${leader} takes the lead`, body: `${name} · ${ps[0].score}` } });
    if (state === "post" && !prev?.final && !first) {
      const pos = (c: any) => { const same = ps.filter((x: any) => x.score === c.score); return (same.length > 1 ? "T" : "") + (same[0].order ?? "?"); };
      for (const u of fans(ps.map(personName))) {
        const mine = ps.filter((c: any) => likesPerson(u.favs, personName(c))).slice(0, 4).map((c: any) => `${personName(c)} ${pos(c)} (${c.score})`);
        sends.push({ user: u, alert: { kind: "event", game: null, tag, title: `⛳ Final: ${name}`, body: `Winner: ${leader} (${ps[0]?.score ?? ""}). ${mine.length ? "Yours: " + mine.join(", ") : ""}` } });
      }
    }
    next.leader = leader; if (state === "post") next.final = true;
  } else if (L.kind === "race") {
    const comps = ev.competitions ?? [];
    const ab = (c: any) => String(c?.type?.abbreviation ?? "");
    const race = comps.find((c: any) => /^race$/i.test(ab(c))) ?? comps[comps.length - 1] ?? {};
    const qual = comps.find((c: any) => /^qual/i.test(ab(c)));
    const order = (c: any) => (c?.competitors ?? []).slice().sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999));
    if (qual && st(qual) === "post" && !prev?.qual && !first) {
      const r = order(qual);
      for (const u of fans(r.map(personName))) {
        const mine = r.filter((c: any) => likesPerson(u.favs, personName(c))).map((c: any) => `${personName(c)} P${c.order}`);
        sends.push({ user: u, alert: { kind: "event", game: null, tag, title: likesPerson(u.favs, personName(r[0])) ? `🏁 ${personName(r[0])} takes pole!` : `🏁 Qualifying: ${name}`, body: `Pole: ${personName(r[0])}. Yours: ${mine.join(", ")}` } });
      }
    }
    if (qual && st(qual) === "post") next.qual = true;
    if (st(race) === "in" && !prev?.raceIn && !first) {
      const tv = [...new Set((race.broadcasts ?? []).flatMap((b: any) => b.names ?? []))].join(", ");
      for (const u of users.filter(x => x.notify_events && x.leagues.includes(lg) && x.favs.size))
        sends.push({ user: u, alert: { kind: "event", game: null, tag, title: `🏁 ${name} is underway`, body: tv ? `Watch on ${tv}` : "Green flag!" } });
    }
    if (st(race) !== "pre") next.raceIn = true;
    if (st(race) === "post" && !prev?.final && !first) {
      const r = order(race);
      for (const u of fans(r.map(personName))) {
        const mine = r.filter((c: any) => likesPerson(u.favs, personName(c))).map((c: any) => `${personName(c)} P${c.order}`);
        sends.push({ user: u, alert: { kind: "event", game: null, tag, title: `🏁 ${personName(r[0])} wins ${name}`, body: `Yours: ${mine.join(", ")}` } });
      }
    }
    if (st(race) === "post") next.final = true;
  } else {
    // UFC: each bout separately.
    next.bouts = { ...(prev?.bouts ?? {}) };
    for (const b of ev.competitions ?? []) {
      const cs = b.competitors ?? [];
      if (cs.length < 2) continue;
      const [a, c] = [personName(cs[0]), personName(cs[1])];
      const was = prev?.bouts?.[b.id], now = st(b);
      next.bouts[b.id] = now;
      if (first || was === now) continue;
      const who = fans([a, c]);
      if (now === "in") for (const u of who) sends.push({ user: u, alert: { kind: "event", game: null, tag: `${tag}-${b.id}`, title: `🥊 ${a} vs ${c} is starting`, body: name } });
      if (now === "post") {
        const w = cs.find((x: any) => x.winner), l = cs.find((x: any) => !x.winner);
        const how = b.status?.result?.displayName ?? b.status?.result?.name ?? "";
        for (const u of who) sends.push({ user: u, alert: { kind: "event", game: null, tag: `${tag}-${b.id}`,
          title: w ? `🥊 ${personName(w)} def. ${personName(l)}` : `🥊 ${a} vs ${c}: ${b.status?.type?.shortDetail ?? "Final"}`, body: [how, name].filter(Boolean).join(" · ") } });
      }
    }
  }
  return { sends, next };
}

// ============================================================ team news, schedule changes, tickets, standings
export const NEWS_WORDS = /injur|ruled out|out for|surgery|\btorn\b|injured reserve|\bIR\b|placed on|activated|day-to-day|questionable|doubtful|trade[sd]?\b|acquire|\bsign(s|ed|ing)?\b|extension|releas|waive|suspend|fired|hires?\b|hired/i;
export function newsFor(article: any, favs: Set<string>): string | null {
  const teams = (article.categories ?? []).filter((c: any) => c.type === "team").map((c: any) => String(c.description ?? c.team?.description ?? ""));
  const team = teams.find((t: string) => favs.has(t.toLowerCase()));
  if (!team) return null;
  return NEWS_WORDS.test(`${article.headline ?? ""} ${article.description ?? ""}`) ? team : null;
}
const CLINCH: Record<string, string> = { x: "clinched a playoff spot", y: "clinched the division", z: "clinched a first-round bye", "*": "clinched the top seed", e: "were eliminated from playoff contention" };

// "Starting soon" depends on each person's lead time, so it's worked out per person.
export function startAlerts(g: Game, users: User[], prev: GameState | undefined, now: number): { alerts: Alert[]; sentTo: string[] } {
  const sent = new Set(prev?.startSent ?? []);
  const alerts: Alert[] = [];
  if (g.state !== "pre" || g.tbd || g.postponed || !Number.isFinite(g.start)) return { alerts, sentTo: [...sent] };
  const minsAway = (g.start - now) / 60000;
  for (const u of users) {
    if (!u.notify_start || sent.has(u.id) || !follows(u, g)) continue;
    if (minsAway <= u.notify_start_minutes && minsAway > -5) {
      const when = new Intl.DateTimeFormat("en-US", { timeZone: u.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(g.start));
      const mins = Math.max(0, Math.round(minsAway));
      alerts.push({
        kind: "start", game: g, onlyUser: u.id, tag: `start-${g.key}`,
        title: `${LEAGUES[g.league].emoji} ${g.away.name} @ ${g.home.name} ${mins <= 1 ? "starting now" : `in ${mins} min`}`,
        body: `${when}${g.tv ? ` on ${g.tv}` : ""}.`,
      });
      sent.add(u.id);
    }
  }
  return { alerts, sentTo: [...sent] };
}

export const wants = (u: User, a: Alert): boolean => !!({
  score: u.notify_scores, final: u.notify_final, big: u.notify_big_plays, close: u.notify_big_plays, start: u.notify_start,
  digest: u.notify_digest, highlight: u.notify_highlights, milestone: u.notify_milestones, drama: u.notify_drama,
  period: u.notify_periods, news: u.notify_news, schedule: u.notify_schedule, standings: u.notify_standings,
  tickets: u.notify_tickets, event: u.notify_events,
} as Record<string, boolean | undefined>)[a.kind];

// ============================================================ morning summary
export function localParts(tz: string, at: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(at)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, ymd: `${p.year}${p.month}${p.day}`, hour: Number(p.hour) };
}

export function digestFor(u: User, yesterday: Game[], today: Game[]): { title: string; body: string } | null {
  const mine = (gs: Game[]) => gs.filter(g => follows(u, g));
  const results = mine(yesterday).filter(g => g.state === "post").map(g => {
    const f = favSide(u, g)!, o = f === g.home ? g.away : g.home;
    const wl = f.score > o.score ? "W" : f.score < o.score ? "L" : "T";
    return `${f.name} ${f.score}–${o.score} ${o.name} (${wl})`;
  });
  const upcoming = mine(today).filter(g => g.state !== "post" && !g.postponed).sort((a, b) => a.start - b.start).map(g => {
    const f = favSide(u, g)!, o = f === g.home ? g.away : g.home;
    const when = g.tbd ? "TBD" : new Intl.DateTimeFormat("en-US", { timeZone: u.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(g.start));
    return `${f.name} ${f === g.home ? "vs" : "@"} ${o.name} ${when}`;
  });
  if (!results.length && !upcoming.length) return null;
  const parts = [];
  if (results.length) parts.push(`Last night: ${results.join("; ")}.`);
  if (upcoming.length) parts.push(`Today: ${upcoming.join("; ")}.`);
  let body = parts.join(" ");
  if (body.length > 230) body = body.slice(0, 227) + "…";
  return { title: `☀️ Good morning${u.name ? ", " + u.name : ""}`, body };
}


// ============================================================ group chat alerts
// Each member chooses per group: every message ("all"), only @mentions, or off.
export type ChatMsg = { id: number; group_id: string; user_id: string | null; thread: string; thread_title: string; body: string };
export type Member = { group_id: string; user_id: string; display_name: string; chat_notify: string };

export function mentions(body: string, name: string): boolean {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const first = name.trim().split(/\s+/)[0];
  const re = new RegExp(`@(${esc(name.trim())}|${esc(first)})(?![\\w])`, "i");
  return re.test(body);
}

// Returns one alert per person per thread (several messages become "3 new messages").
export function chatAlertsFor(msgs: ChatMsg[], members: Member[], groupNames: Map<string, string>, appUrl: string) {
  const out = new Map<string, { user: string; title: string; body: string; tag: string; url: string; count: number; mentioned: boolean }>();
  const name = (g: string, u: string | null) => members.find(m => m.group_id === g && m.user_id === u)?.display_name ?? "Someone";
  for (const m of msgs) {
    for (const mem of members) {
      if (mem.group_id !== m.group_id || mem.user_id === m.user_id || mem.chat_notify === "off") continue;
      const mentioned = mentions(m.body, mem.display_name);
      if (mem.chat_notify === "mentions" && !mentioned) continue;
      const key = `${mem.user_id}|${m.group_id}|${m.thread}`;
      const where = m.thread === "general" ? "" : `${m.thread_title.split(" · ")[0] || "Game"}: `;
      const body = (where + m.body).slice(0, 180);
      const prev = out.get(key);
      const group = groupNames.get(m.group_id) ?? "your group";
      const author = name(m.group_id, m.user_id);
      out.set(key, {
        user: mem.user_id, tag: `chat-${m.group_id}-${m.thread}`,
        url: `${appUrl}#chat/${m.group_id}/${m.thread}`,
        count: (prev?.count ?? 0) + 1, mentioned: (prev?.mentioned ?? false) || mentioned,
        title: (prev?.mentioned || mentioned) ? `💬 ${author} mentioned you · ${group}` : `💬 ${author} · ${group}`,
        body: prev ? `${prev.count + 1} new messages. Latest: ${body}` : body,
      });
    }
  }
  return [...out.values()];
}

async function chatRun(d: Deps, phones: Map<string, any[]>, log: any, outbox: { userId: string; payload: any; ttl: number }[]) {
  const { data: meta, error } = await d.db.from("notify_meta").select("value").eq("key", "chat_last_id").maybeSingle();
  if (error) { if (!/does not exist|schema cache/i.test(error.message)) log.errors.push("chat: " + error.message); return; }  // chat not set up
  const { data: newest } = await d.db.from("messages").select("id").order("id", { ascending: false }).limit(1);
  const top = newest?.[0]?.id ?? 0;
  if (!meta) {   // first run: start from now, don't replay old messages
    await d.db.from("notify_meta").upsert({ key: "chat_last_id", value: String(top) });
    return;
  }
  const since = Number(meta.value) || 0;
  if (top <= since) return;
  const { data: msgs } = await d.db.from("messages").select("id,group_id,user_id,thread,thread_title,body,deleted")
    .gt("id", since).order("id").limit(500);
  const live = (msgs ?? []).filter((m: any) => !m.deleted);
  const last = (msgs ?? []).at(-1)?.id ?? since;
  if (live.length) {
    const groupIds = [...new Set(live.map((m: any) => m.group_id))];
    const { data: members } = await d.db.from("group_members").select("group_id,user_id,display_name,chat_notify").in("group_id", groupIds);
    const { data: groups } = await d.db.from("groups").select("id,name").in("id", groupIds);
    const names = new Map<string, string>((groups ?? []).map((g: any) => [g.id, g.name]));
    for (const a of chatAlertsFor(live, members ?? [], names, d.appUrl)) {
      if (!phones.has(a.user)) continue;
      outbox.push({ userId: a.user, ttl: 6 * 3600, payload: { title: a.title, body: a.body, tag: a.tag, url: a.url } });
      log.chat++;
    }
  }
  await d.db.from("notify_meta").upsert({ key: "chat_last_id", value: String(last) });
}

// ============================================================ the run
type Deps = {
  // deno-lint-ignore no-explicit-any
  db: any;   // Supabase client (service key)
  fetchJSON: (url: string) => Promise<any>;
  send: (sub: { endpoint: string; p256dh: string; auth: string }, payload: string, opts: { TTL: number; urgency: string; topic?: string }) => Promise<void>;
  now: number; appUrl: string;
};

export async function run(d: Deps) {
  const log = { users: 0, phones: 0, games: 0, sent: 0, removed: 0, digests: 0, chat: 0, errors: [] as string[], backup: [] as string[] };

  // People with notifications on, and their phones.
  const { data: subRows, error: e1 } = await d.db.from("subscribers")
    .select("id,name,timezone,leagues,favorite_teams,notify_start,notify_final,notify_scores,notify_big_plays,notify_digest,notify_start_minutes,notify_digest_hour," +
            "notify_highlights,notify_milestones,notify_drama,notify_periods,notify_news,notify_schedule,notify_standings,notify_tickets,notify_ticket_price,notify_events")
    .or("notify_start.eq.true,notify_final.eq.true,notify_scores.eq.true,notify_big_plays.eq.true,notify_digest.eq.true," +
        "notify_highlights.eq.true,notify_milestones.eq.true,notify_drama.eq.true,notify_periods.eq.true,notify_news.eq.true," +
        "notify_schedule.eq.true,notify_standings.eq.true,notify_tickets.eq.true,notify_events.eq.true");
  if (e1) throw new Error("reading subscribers: " + e1.message);
  const { data: phoneRows, error: e2 } = await d.db.from("push_subscriptions").select("endpoint,user_id,p256dh,auth");
  if (e2) throw new Error("reading phones: " + e2.message);
  const phones = new Map<string, any[]>();
  for (const p of (phoneRows ?? []) as any[]) phones.set(p.user_id, [...(phones.get(p.user_id) ?? []), p]);
  const users: User[] = (subRows ?? []).filter((r: any) => phones.has(r.id)).map((r: any) => ({
    ...r, name: r.name ?? "", leagues: (r.leagues ?? []).filter((l: string) => LEAGUES[l] || EVENT_LEAGUES[l]),
    favs: new Set((r.favorite_teams ?? []).map((f: string) => f.toLowerCase())),
  }));
  log.users = users.length; log.phones = phoneRows?.length ?? 0;

  // Group chat alerts (anyone with a phone registered, whatever their game alerts are).
  const chatOutbox: { userId: string; payload: any; ttl: number }[] = [];
  try { await chatRun(d, phones, log, chatOutbox); } catch (err) { log.errors.push("chat: " + err); }
  const sendTo = async (userId: string, payload: any, opts: { TTL: number; urgency: string; topic?: string }, dead: string[]) => {
    for (const ph of phones.get(userId) ?? []) {
      try { await d.send(ph, JSON.stringify(payload), opts); log.sent++; }
      catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) dead.push(ph.endpoint);   // phone turned notifications off
        else log.errors.push(`send ${userId}: ${err?.statusCode ?? ""} ${err?.message ?? err}`);
      }
    }
  };
  const dead: string[] = [];
  await Promise.all(chatOutbox.map(c => sendTo(c.userId, c.payload, { TTL: c.ttl, urgency: "normal" }, dead)));
  const removeDead = async () => {
    if (dead.length) {
      await d.db.from("push_subscriptions").delete().in("endpoint", [...new Set(dead)]);
      log.removed = new Set(dead).size;
    }
  };
  if (!users.length) { await removeDead(); return log; }

  // Scoreboards: today in US Eastern (ESPN's day), plus the day after in the start-soon window,
  // plus yesterday overnight so late games still finish.
  const leagues = [...new Set(users.flatMap(u => u.leagues))].filter(l => LEAGUES[l]);
  const et = (ms: number) => localParts("America/New_York", ms);
  const nowEt = et(d.now);
  const dates = new Set([nowEt.ymd, et(d.now + 3 * 3600e3).ymd]);
  if (nowEt.hour < 6) dates.add(et(d.now - 24 * 3600e3).ymd);
  const boards = new Map<string, Game[]>();     // "league|yyyymmdd" -> games
  const copies: { key: string; value: string }[] = [];   // ESPN copies for the backup feeds (see BACKUP)
  const board = async (lg: string, ymd: string) => {
    const k = `${lg}|${ymd}`;
    if (!boards.has(k)) {
      const L = LEAGUES[lg];
      const url = `${ESPN}/${L.path}/scoreboard?` + new URLSearchParams({ ...(L.params ?? {}), dates: ymd });
      try {
        const games = parseScoreboard(await d.fetchJSON(url), lg);
        boards.set(k, games);
        if (BACKUP[lg] && games.length && new Date(d.now).getUTCMinutes() % 10 === 0)
          copies.push({ key: `espn:${k}`, value: JSON.stringify(games.map(({ plays: _p, summary: _s, ...g }) => g)) });
      } catch (err) {
        if (!BACKUP[lg]) { log.errors.push(`${lg} ${ymd}: ${err}`); boards.set(k, []); return boards.get(k)!; }
        // ESPN failed: use the league's own feed.
        try {
          const saved = (await seenGet(d, [`espn:${k}`])).get(`espn:${k}`);
          const games = await backupBoard(d, lg, ymd, saved ? JSON.parse(saved) : []);
          boards.set(k, games);
          log.backup.push(`${L.name} ${ymd}: ESPN failed (${String(err).slice(0, 120)}); used ${BACKUP[lg]} for ${games.length} game${games.length === 1 ? "" : "s"}`);
        } catch (err2) {
          log.errors.push(`${lg} ${ymd}: ${err}; backup ${BACKUP[lg]} also failed: ${err2}`);
          boards.set(k, []);
        }
      }
    }
    return boards.get(k)!;
  };
  const games = new Map<string, Game>();
  for (const lg of leagues) for (const ymd of dates) for (const g of await board(lg, ymd)) games.set(g.key, g);
  // Only games someone follows.
  const watched = [...games.values()].filter(g => users.some(u => follows(u, g)));
  log.games = watched.length;

  // Game summaries (play-by-play, highlight clips, box score) for live games someone wants big plays,
  // milestones or highlights for, and for a few hours after the final (highlights keep coming).
  const minute = new Date(d.now).getUTCMinutes();
  for (const g of watched) {
    const fans = users.filter(u => follows(u, g));
    if (g.src) continue;   // from a backup feed: ESPN is down, so skip the extras for now
    const live = g.state === "in" && fans.some(u => u.notify_big_plays || u.notify_milestones || u.notify_highlights);
    const after = g.state === "post" && d.now - g.start < 8 * 3600e3 && minute % 5 === 0 && fans.some(u => u.notify_highlights);
    if (!live && !after) continue;
    try {
      g.summary = await d.fetchJSON(`${ESPN}/${LEAGUES[g.league].path}/summary?event=${g.id}`);
      if (live) g.plays = parsePlays(g.summary);
    } catch (err) { log.errors.push(`summary ${g.key}: ${err}`); }
  }

  // Last time's state.
  const prevStates = new Map<string, GameState>();
  if (watched.length) {
    const { data } = await d.db.from("notify_games").select("game_key,state").in("game_key", watched.map(g => g.key));
    for (const r of (data ?? []) as any[]) prevStates.set(r.game_key, r.state);
  }

  // Work out alerts.
  const outbox: { user: User; alert: Alert }[] = [];
  const newStates: { game_key: string; state: GameState; updated_at: string }[] = [];
  for (const g of watched) {
    const prev = prevStates.get(g.key);
    const { alerts, next } = gameEvents(g, prev);
    alerts.push(...summaryEvents(g, prev, next));
    const st = startAlerts(g, users, prev, d.now);
    next.startSent = st.sentTo;
    for (const a of [...alerts, ...st.alerts]) {
      for (const u of users) {
        if (a.onlyUser && a.onlyUser !== u.id) continue;
        if (follows(u, g) && wants(u, a)) outbox.push({ user: u, alert: a });
      }
    }
    newStates.push({ game_key: g.key, state: next, updated_at: new Date(d.now).toISOString() });
  }

  // Morning summaries.
  const digestRows: { user_id: string; day: string }[] = [];
  const due = users.filter(u => u.notify_digest && localParts(u.timezone, d.now).hour === u.notify_digest_hour);
  if (due.length) {
    const { data: done } = await d.db.from("notify_digests").select("user_id,day")
      .in("user_id", due.map(u => u.id)).in("day", [...new Set(due.map(u => localParts(u.timezone, d.now).date))]);
    const already = new Set((done ?? []).map((r: any) => `${r.user_id}|${r.day}`));
    for (const u of due) {
      const today = localParts(u.timezone, d.now), yday = localParts(u.timezone, d.now - 24 * 3600e3);
      if (already.has(`${u.id}|${today.date}`)) continue;
      const yGames: Game[] = [], tGames: Game[] = [];
      for (const lg of u.leagues.filter(l => LEAGUES[l])) { yGames.push(...await board(lg, yday.ymd)); tGames.push(...await board(lg, today.ymd)); }
      const msg = digestFor(u, yGames, tGames);
      digestRows.push({ user_id: u.id, day: today.date });
      if (msg) outbox.push({ user: u, alert: { kind: "digest", game: null, title: msg.title, body: msg.body, tag: `digest-${today.date}` } });
      log.digests++;
    }
  }

  // Send. One person can have several phones.
  // Time-sensitive alerts expire if the phone is off; finals and summaries wait longer.
  // Golf, racing, UFC; and the slower checks: news (every 10 min), schedules & tickets (hourly), standings (every 2 h).
  const extra = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (err) { log.errors.push(`${name}: ${err}`); } };
  await extra("events", () => eventsRun(d, users, outbox, log));
  if (minute % 10 === 3) await extra("news", () => newsRun(d, users, outbox, log));
  if (minute === 17) await extra("schedule", () => scheduleRun(d, users, outbox, log));
  if (minute === 23 && new Date(d.now).getUTCHours() % 2 === 0) await extra("standings", () => standingsRun(d, users, outbox, log));

  const kinds: Record<string, number> = {};   // alerts per type, for the Admin page
  if (chatOutbox.length) kinds.chat = chatOutbox.length;
  for (const { alert } of outbox) kinds[alert.kind] = (kinds[alert.kind] ?? 0) + 1;
  await Promise.all(outbox.map(({ user, alert }) => sendTo(user.id,
    { title: alert.title, body: alert.body, tag: alert.tag, url: alert.url || (d.appUrl ? d.appUrl + "#games" : "/") },
    { TTL: ["start", "score", "close", "period", "drama"].includes(alert.kind) ? 1800 : 6 * 3600,
      urgency: ["news", "standings", "tickets", "schedule"].includes(alert.kind) ? "normal" : "high", topic: alert.topic }, dead)));

  // Save.
  if (newStates.length) {
    const { error } = await d.db.from("notify_games").upsert(newStates);
    if (error) log.errors.push("saving state: " + error.message);
  }
  if (digestRows.length) {
    const { error } = await d.db.from("notify_digests").upsert(digestRows);
    if (error) log.errors.push("saving digests: " + error.message);
  }
  await removeDead();
  if (copies.length) await seenSet(d, copies);
  if (Object.keys(kinds).length) {
    try { await d.db.rpc("bump_notify_stats", { d: localParts("America/Chicago", d.now).date, counts: kinds }); } catch { /* stats are optional */ }
  }
  // Tidy up old bookkeeping now and then.
  if (new Date(d.now).getUTCMinutes() === 7) {
    await d.db.from("notify_games").delete().lt("updated_at", new Date(d.now - 3 * 24 * 3600e3).toISOString());
    await d.db.from("notify_digests").delete().lt("day", new Date(d.now - 7 * 24 * 3600e3).toISOString().slice(0, 10));
    await d.db.from("notify_seen").delete().lt("at", new Date(d.now - 60 * 24 * 3600e3).toISOString());
  }
  return log;
}

// ---- helpers for the slower checks
type Out = { user: User; alert: Alert }[];
async function seenGet(d: Deps, keys: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (let i = 0; i < keys.length; i += 200) {
    const { data } = await d.db.from("notify_seen").select("key,value").in("key", keys.slice(i, i + 200));
    for (const r of (data ?? []) as any[]) m.set(r.key, r.value);
  }
  return m;
}
async function seenSet(d: Deps, rows: { key: string; value: string }[]) {
  if (rows.length) await d.db.from("notify_seen").upsert(rows.map(r => ({ ...r, at: new Date(d.now).toISOString() })));
}
// Favorite teams -> ESPN ids, using the app's own "teams" function (same lists as My Teams).
async function myTeams(d: Deps, users: User[], want: (u: User) => boolean) {
  const out: { league: string; id: string; name: string; users: User[] }[] = [];
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const leagues = [...new Set(users.filter(want).flatMap(u => u.leagues))].filter(l => LEAGUES[l]);
  for (const lg of leagues) {
    let list: any[] = [];
    try { list = (await d.fetchJSON(`${base}/functions/v1/teams?league=${lg}`)).teams ?? []; } catch { continue; }
    for (const t of list) {
      const names = [t.name, t.nick, t.short, t.abbr].filter(Boolean).map((x: string) => x.toLowerCase());
      const fans = users.filter(u => want(u) && u.leagues.includes(lg) && names.some(n => u.favs.has(n)));
      if (fans.length) out.push({ league: lg, id: String(t.id), name: t.name, users: fans });
    }
  }
  return out;
}
const dayTime = (ms: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

async function eventsRun(d: Deps, users: User[], out: Out, log: any) {
  const leagues = [...new Set(users.filter(u => u.notify_events).flatMap(u => u.leagues))].filter(l => EVENT_LEAGUES[l]);
  for (const lg of leagues) {
    let data: any;
    try { data = await d.fetchJSON(`${ESPN}/${EVENT_LEAGUES[lg].path}/scoreboard`); }
    catch (err) { log.errors?.push?.(`${lg}: ${err}`); continue; }
    const evs = (data.events ?? []) as any[];
    if (!evs.length) continue;
    const keys = evs.map(e => `${lg}:${e.id}`);
    const { data: rows } = await d.db.from("notify_games").select("game_key,state").in("game_key", keys);
    const prev = new Map(((rows ?? []) as any[]).map(r => [r.game_key, r.state]));
    const saves: any[] = [];
    for (const ev of evs) {
      const { sends, next } = eventAlerts(lg, ev, prev.get(`${lg}:${ev.id}`), users);
      out.push(...sends);
      saves.push({ game_key: `${lg}:${ev.id}`, state: next, updated_at: new Date(d.now).toISOString() });
    }
    await d.db.from("notify_games").upsert(saves);
  }
}

async function newsRun(d: Deps, users: User[], out: Out, log: any) {
  const fans = users.filter(u => u.notify_news);
  const leagues = [...new Set(fans.flatMap(u => u.leagues))].filter(l => LEAGUES[l]);
  for (const lg of leagues) {
    let data: any;
    try { data = await d.fetchJSON(`${ESPN}/${LEAGUES[lg].path}/news?limit=50`); }
    catch (err) { log.errors?.push?.(`news ${lg}: ${err}`); continue; }
    const fresh = ((data.articles ?? []) as any[]).filter(a => a.id && Date.parse(a.published ?? "") > d.now - 12 * 3600e3);
    if (!fresh.length) continue;
    const seen = await seenGet(d, fresh.map(a => `news:${a.id}`));
    const rows: { key: string; value: string }[] = [];
    for (const a of fresh) {
      const already = new Set((seen.get(`news:${a.id}`) ?? "").split(",").filter(Boolean));
      let changed = false;
      for (const u of fans.filter(x => x.leagues.includes(lg) && !already.has(x.id))) {
        const team = newsFor(a, u.favs);
        if (!team) continue;
        already.add(u.id); changed = true;
        out.push({ user: u, alert: { kind: "news", game: null, tag: `news-${a.id}`, url: a.links?.web?.href,
          title: `📰 ${team}: ${String(a.headline).slice(0, 100)}`, body: String(a.description ?? "").slice(0, 160) } });
      }
      if (changed || !seen.has(`news:${a.id}`)) rows.push({ key: `news:${a.id}`, value: [...already].join(",") });
    }
    await seenSet(d, rows);
  }
}

async function scheduleRun(d: Deps, users: User[], out: Out, log: any) {
  const teams = await myTeams(d, users, u => !!(u.notify_schedule || u.notify_tickets));
  for (const t of teams) {
    let data: any;
    try { data = await d.fetchJSON(`${ESPN}/${LEAGUES[t.league].path}/teams/${t.id}/schedule`); }
    catch (err) { log.errors?.push?.(`schedule ${t.league}:${t.id}: ${err}`); continue; }   // one team failing doesn't stop the rest
    const evs = ((data.events ?? []) as any[]).filter(e => { const ms = Date.parse(e.date); return ms > d.now && ms < d.now + 45 * 24 * 3600e3; });
    const keys = evs.flatMap(e => [`sched:${t.league}:${e.id}`, ...t.users.map(u => `tix:${t.league}:${e.id}:${u.id}`)]);
    const seen = await seenGet(d, keys);
    const rows: { key: string; value: string }[] = [];
    for (const e of evs) {
      const comp = (e.competitions ?? [])[0] ?? {};
      const cs = comp.competitors ?? [];
      const home = cs.find((c: any) => c.homeAway === "home")?.team ?? {}, away = cs.find((c: any) => c.homeAway === "away")?.team ?? {};
      const title = `${away.shortDisplayName ?? away.displayName ?? "?"} @ ${home.shortDisplayName ?? home.displayName ?? "?"}`;
      const status = comp.status?.type?.name ?? "";
      const val = `${Date.parse(e.date)}|${status}`;
      const k = `sched:${t.league}:${e.id}`;
      const old = seen.get(k);
      if (old !== val) {
        rows.push({ key: k, value: val });
        if (old) {
          const [oldMs, oldStatus] = old.split("|");
          const moved = Math.abs(Number(oldMs) - Date.parse(e.date)) >= 10 * 60e3;
          const off = /POSTPONED|CANCELED|SUSPENDED/.test(status) && status !== oldStatus;
          for (const u of t.users.filter(x => x.notify_schedule)) {
            if (off) out.push({ user: u, alert: { kind: "schedule", game: null, tag: `sched-${e.id}`, title: `🗓️ ${status.includes("CANCEL") ? "Canceled" : "Postponed"}: ${title}`, body: `Was ${dayTime(Number(oldMs), u.timezone)}` } });
            else if (moved) out.push({ user: u, alert: { kind: "schedule", game: null, tag: `sched-${e.id}`, title: `🗓️ Time change: ${title}`, body: `Now ${dayTime(Date.parse(e.date), u.timezone)} (was ${dayTime(Number(oldMs), u.timezone)})` } });
          }
        }
      }
      // Ticket price drop
      const tk = (comp.tickets ?? [])[0];
      const price = tk ? Number(tk.startingPrice ?? (String(tk.summary ?? "").match(/\$\s?([\d,]+)/)?.[1] ?? "").replace(/,/g, "")) : NaN;
      const link = tk?.links?.find((l: any) => l.href)?.href;
      if (!Number.isFinite(price) || price <= 0) continue;
      for (const u of t.users.filter(x => x.notify_tickets)) {
        const tk2 = `tix:${t.league}:${e.id}:${u.id}`;
        const last = Number(seen.get(tk2) ?? "0");
        if (price <= (u.notify_ticket_price ?? 75) && (!last || price <= last * 0.8)) {
          rows.push({ key: tk2, value: String(price) });
          out.push({ user: u, alert: { kind: "tickets", game: null, tag: `tix-${e.id}`, url: link,
            title: `🎟️ Tickets from $${Math.round(price)}: ${title}`, body: `${dayTime(Date.parse(e.date), u.timezone)} · tap to see seats` } });
        }
      }
    }
    await seenSet(d, rows);
  }
}

async function standingsRun(d: Deps, users: User[], out: Out, log: any) {
  const fans = users.filter(u => u.notify_standings);
  if (!fans.length) return;
  const teams = await myTeams(d, users, u => !!u.notify_standings);
  const rows: { key: string; value: string }[] = [];
  // Pro leagues: clinched / eliminated, and moving into first place in the division.
  for (const lg of [...new Set(teams.map(t => t.league))].filter(l => ["nfl", "nba", "nhl", "mlb"].includes(l))) {
    let data: any;
    try { data = await d.fetchJSON(`https://site.api.espn.com/apis/v2/sports/${LEAGUES[lg].path}/standings?level=3`); }
    catch (err) { log.errors?.push?.(`standings ${lg}: ${err}`); continue; }
    const mine = teams.filter(t => t.league === lg);
    const seen = await seenGet(d, mine.map(t => `stand:${lg}:${t.id}`));
    for (const conf of data.children ?? []) for (const div of conf.children ?? []) {
      const entries = (div.standings?.entries ?? []).map((e: any) => {
        const st: Record<string, any> = {};
        for (const x of e.stats ?? []) if (x.type && st[x.type] == null) st[x.type] = x;
        return { id: String(e.team?.id ?? ""), st };
      }).sort((a: any, b: any) => lg === "nhl" ? (b.st.points?.value ?? 0) - (a.st.points?.value ?? 0) : (b.st.winpercent?.value ?? 0) - (a.st.winpercent?.value ?? 0));
      entries.forEach((e: any, i: number) => {
        const t = mine.find(x => x.id === e.id);
        if (!t) return;
        const clinch = String(e.st.clincher?.displayValue ?? "").trim().toLowerCase();
        const val = JSON.stringify({ c: CLINCH[clinch] ? clinch : "", f: i === 0 });
        const k = `stand:${lg}:${t.id}`;
        const old = seen.get(k);
        if (old === val) return;
        rows.push({ key: k, value: val });
        if (!old) return;
        const o = JSON.parse(old), n = JSON.parse(val);
        for (const u of t.users) {
          if (n.c && n.c !== o.c) out.push({ user: u, alert: { kind: "standings", game: null, tag: `stand-${t.id}`, title: `${n.c === "e" ? "😞" : "🎉"} ${t.name} ${CLINCH[n.c]}`, body: String(div.name ?? "") } });
          else if (n.f && !o.f) out.push({ user: u, alert: { kind: "standings", game: null, tag: `stand-${t.id}`, title: `📈 ${t.name} move into 1st place`, body: String(div.name ?? "") } });
        }
      });
    }
  }
  // College: the new AP Top 25.
  for (const lg of [...new Set(teams.map(t => t.league))].filter(l => l === "cfb" || l === "cbb")) {
    let data: any;
    try { data = await d.fetchJSON(`${ESPN}/${LEAGUES[lg].path}/rankings`); }
    catch (err) { log.errors?.push?.(`rankings ${lg}: ${err}`); continue; }
    const ap = (data.rankings ?? []).find((r: any) => /^AP/i.test(r.name ?? r.shortName ?? ""));
    if (!ap) continue;
    const pollKey = `apdate:${lg}`, pollDate = String(ap.date ?? ap.headline ?? "");
    const mine = teams.filter(t => t.league === lg);
    const seen = await seenGet(d, [pollKey, ...mine.map(t => `ap:${lg}:${t.id}`)]);
    if (seen.get(pollKey) === pollDate) continue;
    rows.push({ key: pollKey, value: pollDate });
    for (const t of mine) {
      const r = (ap.ranks ?? []).find((x: any) => String(x.team?.id) === t.id);
      const now = r ? String(r.current) : "NR";
      const k = `ap:${lg}:${t.id}`, old = seen.get(k);
      rows.push({ key: k, value: now });
      if (!old || old === now) continue;
      const title = now === "NR" ? `📊 ${t.name} drop out of the AP Top 25` : old === "NR" ? `📊 ${t.name} enter the AP Top 25 at #${now}`
        : `📊 ${t.name} are #${now} in the new AP poll (${Number(now) < Number(old) ? "up" : "down"} from #${old})`;
      for (const u of t.users) out.push({ user: u, alert: { kind: "standings", game: null, tag: `ap-${t.id}`, title, body: LEAGUES[lg].name } });
    }
  }
  await seenSet(d, rows);
}

// ============================================================ web endpoint
export async function handler(req: Request): Promise<Response> {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || req.headers.get("x-cron-secret") !== secret) return new Response("Forbidden", { status: 403 });
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return new Response("Missing VAPID keys", { status: 500 });
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com", pub, priv);
  // Supabase provides the service key automatically (classic name first, newer "secret keys" as a fallback).
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!key) { try { key = Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"))[0] as string ?? ""; } catch { /* none */ } }
  if (!key) return new Response("No service key available", { status: 500 });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
  try {
    const log = await run({
      db, now: Date.now(), appUrl: (Deno.env.get("APP_URL") ?? "").replace(/\/?$/, "/"),
      fetchJSON: async (url) => {
        const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": ESPN_UA }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      },
      send: async (s, payload, opts) => {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, opts);
      },
    });
    return Response.json(log);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

if (!(globalThis as any).__SD_TEST__) Deno.serve(handler);
