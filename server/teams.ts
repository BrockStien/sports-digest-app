// Sports Digest "teams" function: gives the app each league's team list from ESPN,
// with conferences for college teams. (Browsers can't read ESPN's team lists directly,
// so Supabase fetches them instead.) Only these leagues are allowed.
const PATHS: Record<string, string> = {
  nfl: "football/nfl",
  nba: "basketball/nba",
  wnba: "basketball/wnba",
  nhl: "hockey/nhl",
  mlb: "baseball/mlb",
  cfb: "football/college-football",
  cbb: "basketball/mens-college-basketball",
  // Individual sports: the list is people (golfers, drivers, fighters), not teams.
  pga: "golf/pga",
  f1: "racing/f1",
  nascar: "racing/nascar-premier",
  ufc: "mma/ufc",
};
// College conferences come from ESPN standings: [standings group, label prefix]
const CONF_GROUPS: Record<string, [string, string][]> = {
  cfb: [["80", "FBS"], ["81", "FCS"]],
  cbb: [["50", ""]],
};
// Pro leagues: divisions (e.g. "AFC North", "AL Central", "West · Pacific")
const DIVISIONS = new Set(["nfl", "nba", "nhl", "mlb"]);
// Shown first in the conference list
const MAJOR = ["SEC", "Big Ten", "Big 12", "ACC"];
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };
const cache = new Map<string, { at: number; body: string }>();

async function espn(url: string) {
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

// team id -> conference name, e.g. "Big Ten" or "FCS · Missouri Valley"
async function conferences(league: string): Promise<Map<string, { conf: string; team: any }>> {
  const out = new Map<string, { conf: string; team: any }>();
  for (const [group, prefix] of CONF_GROUPS[league] ?? []) {
    try {
      const data = await espn(`https://site.api.espn.com/apis/v2/sports/${PATHS[league]}/standings?group=${group}`);
      for (const conf of data?.children ?? []) {
        const name = String(conf.shortName || conf.abbreviation || conf.name || "Other");
        const label = prefix && prefix !== "FBS" ? `${prefix} · ${name}` : name;
        const walk = (node: any) => {
          for (const e of node?.standings?.entries ?? []) if (e?.team?.id && !out.has(String(e.team.id))) out.set(String(e.team.id), { conf: label, team: e.team });
          for (const c of node?.children ?? []) walk(c);   // some conferences are split into divisions
        };
        walk(conf);
      }
    } catch { /* teams just show without a conference */ }
  }
  return out;
}

// team id -> division, e.g. "NFC North"
async function divisions(league: string): Promise<Map<string, { conf: string; team: any }>> {
  const out = new Map<string, { conf: string; team: any }>();
  try {
    const data = await espn(`https://site.api.espn.com/apis/v2/sports/${PATHS[league]}/standings?level=3`);
    for (const conf of data?.children ?? []) {
      const confShort = String(conf.name || "").replace(/ern Conference$/, "").replace(/ Conference$/, "");   // "Eastern Conference" -> "East"
      for (const div of conf?.children ?? []) {
        let name = String(div.name || "");
        if (league === "mlb") name = name.replace("American League", "AL").replace("National League", "NL");
        else if (league === "nhl" || league === "nba") name = `${confShort} · ${name.replace(/ Division$/, "")}`;
        for (const e of div?.standings?.entries ?? []) if (e?.team?.id) out.set(String(e.team.id), { conf: name, team: e.team });
      }
    }
  } catch { /* no divisions */ }
  return out;
}

// Golfers in this week's field, F1 / NASCAR drivers in the standings, fighters on upcoming cards.
async function athletes(league: string) {
  const people = new Map<string, any>();
  const add = (a: any, id?: string) => {
    const name = a?.displayName || a?.fullName;
    if (name && !people.has(name)) people.set(name, { id: String(id || a.id || name), name, abbr: "", nick: "", short: a.shortName || "", location: "", logo: a?.flag?.href || "", conf: "" });
  };
  if (league === "f1" || league === "nascar") {
    const data = await espn(`https://site.api.espn.com/apis/v2/sports/${PATHS[league]}/standings`);
    const drivers = (data?.children ?? []).find((c: any) => !/constructor/i.test(c.name || "")) ?? data?.children?.[0];
    for (const e of drivers?.standings?.entries ?? []) add(e.athlete, e.athlete?.id);
  } else {
    const data = await espn(`https://site.api.espn.com/apis/site/v2/sports/${PATHS[league]}/scoreboard`);
    for (const ev of data?.events ?? []) for (const c of ev?.competitions ?? []) for (const p of c?.competitors ?? []) add(p.athlete, p.id);
  }
  return [...people.values()];
}

// ---- Team page: ?league=nfl&team=16 -> info, roster (with injuries), recent/upcoming games, news.
const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const scoreOf = (s: any) => s == null ? null : typeof s === "object" ? (s.displayValue ?? s.value ?? null) : s;
function schedGames(data: any, teamId: string) {
  return (data?.events ?? []).map((e: any) => {
    const c = e.competitions?.[0] ?? {};
    const cs = c.competitors ?? [];
    const me = cs.find((x: any) => String(x.team?.id ?? x.id) === teamId) ?? cs[0] ?? {};
    const op = cs.find((x: any) => x !== me) ?? {};
    const st = c.status?.type ?? e.status?.type ?? {};
    const ms = scoreOf(me.score), os = scoreOf(op.score);
    return {
      id: String(e.id), date: e.date, home: me.homeAway === "home", state: st.state ?? "pre", detail: st.shortDetail ?? st.detail ?? "",
      opp: { name: op.team?.displayName ?? op.team?.shortDisplayName ?? "TBD", abbr: op.team?.abbreviation ?? "", logo: op.team?.logos?.[0]?.href ?? op.team?.logo ?? "", rank: op.curatedRank?.current && op.curatedRank.current <= 25 ? op.curatedRank.current : null },
      score: ms != null && os != null && st.state !== "pre" ? `${ms}-${os}` : "", result: st.state === "post" ? (me.winner ? "W" : op.winner ? "L" : "T") : "",
      tv: [...new Set((c.broadcasts ?? []).map((b: any) => b.media?.shortName ?? b.names?.[0]).filter(Boolean))].join(", "),
      tickets: c.tickets?.[0]?.startingPrice ? { price: c.tickets[0].startingPrice, link: c.tickets[0].links?.[0]?.href ?? "" } : null,
      link: (e.links ?? []).find((l: any) => (l.rel ?? []).includes("summary"))?.href ?? "",
    };
  });
}
// ESPN's "standingSummary" can be wrong (it called the 2nd-seeded Vikings "1st in National Football Conference"),
// so pro teams get their place from the standings: order within the division, and their conference/league seed.
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const shortConf = (n: string) => n.replace("National Football Conference", "NFC").replace("American Football Conference", "AFC")
  .replace("American League", "AL").replace("National League", "NL").replace(/^(Eastern|Western) Conference$/, (_m, w) => `${w.slice(0, 4)}ern Conference`);
export function standingFrom(data: any, league: string, id: string): { standing: string; conference: string } | null {
  for (const conf of data?.children ?? []) for (const div of conf?.children ?? []) {
    const entries = div?.standings?.entries ?? [];
    const i = entries.findIndex((e: any) => String(e?.team?.id) === id);
    if (i < 0) continue;
    const stat = (t: string) => (entries[i].stats ?? []).find((x: any) => x.type === t);
    let divName = String(div.name || "");
    if (league === "mlb") divName = divName.replace("American League", "AL").replace("National League", "NL");
    else if (league !== "nfl") divName = divName.replace(/ Division$/, "");
    const seed = Number(stat("playoffseed")?.value ?? stat("playoffseed")?.displayValue);
    const confName = shortConf(String(conf.name || ""));
    // Playoff spots per conference/league: inside them it's a "seed", outside just a place.
    const spots: Record<string, number> = { nfl: 7, nba: 10, nhl: 8, mlb: 6 };
    const conference = !Number.isFinite(seed) || seed <= 0 ? "" : seed <= (spots[league] ?? 0) ? `#${seed} seed in ${confName}` : `${ord(seed)} in ${confName}`;
    return { standing: `${ord(i + 1)} in ${divName}`, conference };
  }
  return null;
}
const PRO = new Set(["nfl", "nba", "nhl", "mlb"]);

async function teamPage(league: string, id: string) {
  const path = PATHS[league];
  const [info, roster, sched, news, standings] = await Promise.all([
    espn(`${SITE}/${path}/teams/${id}`),
    espn(`${SITE}/${path}/teams/${id}/roster`).catch(() => null),
    espn(`${SITE}/${path}/teams/${id}/schedule`).catch(() => null),
    espn(`${SITE}/${path}/news?limit=50`).catch(() => null),
    PRO.has(league) ? espn(`https://site.api.espn.com/apis/v2/sports/${path}/standings?level=3`).catch(() => null) : Promise.resolve(null),
  ]);
  const place = standings ? standingFrom(standings, league, id) : null;
  const t = info?.team ?? {};
  const groups: { name: string; players: any[] }[] = [];
  const injuries: any[] = [];
  const label = (g: string) => ({ offense: "Offense", defense: "Defense", specialTeam: "Special teams", injuredReserveOrOut: "Injured reserve / out", suspended: "Suspended", practiceSquad: "Practice squad" } as any)[g] ?? g;
  const raw = roster?.athletes ?? [];
  const lists = raw.length && raw[0]?.items ? raw.map((g: any) => ({ name: label(String(g.position ?? "Players")), items: g.items ?? [] })) : [{ name: "Players", items: raw }];
  for (const g of lists) {
    const players = g.items.map((a: any) => {
      const inj = (a.injuries ?? [])[0];
      const p = { name: a.displayName ?? a.fullName ?? "?", pos: a.position?.abbreviation ?? "", jersey: a.jersey ?? "", age: a.age ?? null,
        status: inj?.status ?? "", headshot: a.headshot?.href ?? "" };
      if (inj?.status) injuries.push({ name: p.name, pos: p.pos, status: inj.status, date: inj.date ?? "" });
      return p;
    });
    if (players.length) groups.push({ name: g.name, players });
  }
  const games = sched ? schedGames(sched, id) : [];
  const now = Date.now();
  const mineNews = (news?.articles ?? []).filter((a: any) => (a.categories ?? []).some((c: any) => c.type === "team" && String(c.teamId ?? c.team?.id ?? "") === id))
    .slice(0, 8).map((a: any) => ({ headline: a.headline, description: a.description ?? "", published: a.published, link: a.links?.web?.href ?? "", image: a.images?.[0]?.url ?? "" }));
  const order: Record<string, number> = { "Out": 0, "Injured Reserve": 1, "Doubtful": 2, "Questionable": 3, "Day-To-Day": 4 };
  injuries.sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || a.name.localeCompare(b.name));
  return {
    league, team: {
      id: String(t.id ?? id), name: t.displayName ?? "", short: t.shortDisplayName ?? "", abbr: t.abbreviation ?? "", logo: t.logos?.[0]?.href ?? "",
      color: t.color ? `#${t.color}` : "", record: t.record?.items?.[0]?.summary ?? "",
      standing: place?.standing ?? (PRO.has(league) ? "" : t.standingSummary ?? ""), conference: place?.conference ?? "",
      coach: roster?.coach?.[0] ? `${roster.coach[0].firstName ?? ""} ${roster.coach[0].lastName ?? ""}`.trim() : "",
      link: (t.links ?? []).find((l: any) => (l.rel ?? []).includes("clubhouse"))?.href ?? "",
    },
    recent: games.filter((g: any) => g.state === "post").slice(-6).reverse(),
    upcoming: games.filter((g: any) => g.state !== "post" && Date.parse(g.date) > now - 6 * 3600e3).slice(0, 6),
    injuries, roster: groups, news: mineNews,
  };
}

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { ...CORS, "Content-Type": "application/json", ...(status === 200 ? { "Cache-Control": "public, max-age=86400" } : {}) } });

// Team pages change during the day (injuries, scores): cache 10 minutes, not a day.
const teamJson = (body: string) => new Response(body, { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=600" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const params = new URL(req.url).searchParams;
  const league = params.get("league") || "";
  const path = PATHS[league];
  if (!path) return json(JSON.stringify({ error: "unknown league" }), 400);
  const teamId = params.get("team") || "";
  if (teamId) {
    if (!/^\d{1,10}$/.test(teamId) || ["pga", "f1", "nascar", "ufc"].includes(league)) return json(JSON.stringify({ error: "bad team" }), 400);
    const ck = `team:${league}:${teamId}`, h = cache.get(ck);
    if (h && Date.now() - h.at < 10 * 60e3) return teamJson(h.body);
    try {
      const body = JSON.stringify(await teamPage(league, teamId));
      cache.set(ck, { at: Date.now(), body });
      return teamJson(body);
    } catch (e) { return json(JSON.stringify({ error: String(e) }), 502); }
  }

  const hit = cache.get(league);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return json(hit.body);
  try {
    if (["pga", "f1", "nascar", "ufc"].includes(league)) {
      const teams = (await athletes(league)).sort((a, b) => a.name.localeCompare(b.name));
      const body = JSON.stringify({ league, teams, conferences: [], people: true });
      if (teams.length) cache.set(league, { at: Date.now(), body });
      return json(body);
    }
    const [data, confs] = await Promise.all([
      espn(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams?limit=1000`).catch(() => null),
      DIVISIONS.has(league) ? divisions(league) : conferences(league),
    ]);
    const college = !!CONF_GROUPS[league];
    const grouped = college || DIVISIONS.has(league);
    const fromTeams = (data?.sports?.[0]?.leagues?.[0]?.teams || []).map((x: any) => x.team || x).filter((t: any) => t && t.displayName);
    // College: every Division I team, from the conference standings (plus anything only in the team list).
    const byId = new Map<string, any>();
    for (const t of fromTeams) byId.set(String(t.id), t);
    if (college) for (const [id, c] of confs) if (!byId.has(id) && c.team?.displayName) byId.set(id, c.team);
    const teams = [...byId.values()]
      .map((t: any) => ({
        id: String(t.id), name: t.displayName, abbr: t.abbreviation || "", nick: t.name || "", short: t.shortDisplayName || "",
        location: t.location || "", logo: t.logos?.[0]?.href || "",
        ...(grouped ? { conf: confs.get(String(t.id))?.conf || "" } : {}),
      }))
      // College: only Division I teams (the ones with a conference), unless conferences couldn't be loaded.
      .filter((t: any) => !college || !confs.size || t.conf);
    const confList = grouped
      ? [...new Set(teams.map((t: any) => t.conf).filter(Boolean))].sort((a: any, b: any) => {
          const ra = MAJOR.indexOf(a), rb = MAJOR.indexOf(b);
          const fa = a.startsWith("FCS"), fb = b.startsWith("FCS");
          if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
          if (fa !== fb) return fa ? 1 : -1;
          return a.localeCompare(b);
        })
      : [];
    const body = JSON.stringify({ league, teams, conferences: confList });
    if (teams.length) cache.set(league, { at: Date.now(), body });
    return json(body);
  } catch (e) {
    return json(JSON.stringify({ error: String(e) }), 502);
  }
});
