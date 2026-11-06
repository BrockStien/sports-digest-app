/* Sports Digest web app.
   Sign in with an emailed code, pick leagues/teams/options (saved to Supabase,
   read each morning by the daily email job), and see today's games live from ESPN. */
(() => {
  "use strict";

  // ------------------------------------------------------------------ setup
  const CFG = window.APP_CONFIG || {};
  const APP_NAME = CFG.APP_NAME || "Sports Digest";
  const ESPN = "https://site.api.espn.com/apis/site/v2/sports";
  const $app = document.getElementById("app");
  const $toast = document.getElementById("toast");

  const LEAGUES = [
    { key: "nfl", name: "NFL", path: "football/nfl" },
    { key: "nba", name: "NBA", path: "basketball/nba" },
    { key: "nhl", name: "NHL", path: "hockey/nhl" },
    { key: "mlb", name: "MLB", path: "baseball/mlb" },
    { key: "cfb", name: "College Football", path: "football/college-football",
      params: { groups: "80", limit: "300" }, teamParams: { limit: "1000" }, busy: 12 },
    { key: "cbb", name: "Men's College Basketball", path: "basketball/mens-college-basketball",
      params: { groups: "50", limit: "400" }, teamParams: { limit: "1000" }, busy: 12 },
    { key: "ufc", name: "UFC", path: "mma/ufc", kind: "fight" },
    { key: "pga", name: "PGA Tour Golf", path: "golf/pga", kind: "golf" },
    { key: "f1", name: "Formula 1", path: "racing/f1", kind: "race" },
    { key: "nascar", name: "NASCAR Cup Series", path: "racing/nascar-premier", kind: "race" },
  ];
  // Individual sports: favorites are people (fighters, golfers, drivers), shown as one "event" card.
  const PEOPLE = { fight: "fighter", golf: "golfer", race: "driver" };
  const isPeople = k => !!(LEAGUE[k] && LEAGUE[k].kind);
  const isEvent = g => g.kind !== "game";
  const LEAGUE = Object.fromEntries(LEAGUES.map(l => [l.key, l]));
  const GAME_HOURS = { nfl: 3.5, cfb: 3.5, nba: 2.5, nhl: 2.5, mlb: 3, cbb: 2, ufc: 5, pga: 5, f1: 2, nascar: 4 };
  const TIMEZONES = [
    ["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"],
    ["America/Phoenix", "Arizona"], ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"],
    ["Pacific/Honolulu", "Hawaii"],
  ];
  const detectedTz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Phoenix"; }
    catch { return "America/Phoenix"; }
  })();
  const DEFAULTS = {
    name: "", active: true, leagues: ["nfl", "nhl", "mlb", "cfb", "cbb"], favorite_teams: [],
    timezone: TIMEZONES.some(t => t[0] === detectedTz) ? detectedTz : "America/Phoenix",
    headlines_per_league: 3, favorites_only_headlines: true, calendar_links: "all",
    calendar_attachment: true, reminder_minutes: 30, ticket_links: "favorites",
    theme: "system",
  };
  const PUSH_ON = !!(CFG.VAPID_PUBLIC_KEY && CFG.VAPID_PUBLIC_KEY.length > 40);
  const NOTIFY_DEFAULTS = {
    notify_start: true, notify_final: true, notify_scores: false, notify_big_plays: true,
    notify_digest: false, notify_start_minutes: 30, notify_digest_hour: 7,
    notify_highlights: false, notify_milestones: false, notify_drama: false, notify_periods: false,
    notify_news: false, notify_schedule: false, notify_standings: false, notify_tickets: false,
    notify_ticket_price: 75, notify_events: false,
  };
  if (PUSH_ON) Object.assign(DEFAULTS, NOTIFY_DEFAULTS);
  const FIELDS = Object.keys(DEFAULTS);

  const configured = CFG.SUPABASE_URL && !/YOUR-PROJECT/.test(CFG.SUPABASE_URL)
    && CFG.SUPABASE_ANON_KEY && !/PASTE-YOUR/.test(CFG.SUPABASE_ANON_KEY);
  const sb = configured && window.supabase
    ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY,
        { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
    : null;

  const state = {
    user: null,        // signed-in account
    sub: null,         // saved settings row (null = hasn't finished signing up)
    draft: null,       // settings being edited
    tab: "today",
    pendingEmail: "",
    teams: {},         // league key -> [{name, abbr, logo, league}]
    teamsFailed: false,
    confs: {},          // college conferences per league
    myTeamsOnly: true,
    showAllCollege: false,
    day: 0,            // -1 yesterday, 0 today, 1 tomorrow
    days: {},          // day -> {at, leagues:[{league, games, error}]}
    loadingDay: {},
    news: null,        // {at, items, failed}
    loadingNews: false,
    newsMine: null,    // null = use the person's "only news about my teams" setting
    sched: { view: "schedule", teams: {}, standings: {}, showAll: {}, full: {}, loading: false },
    chat: { ok: null, groups: null, groupId: null, thread: null, threadTitle: "", members: [], channel: null, poll: null, showSettings: false },
  };

  // ---------------------------------------------------------------- theme
  // "system" follows the phone's light/dark setting; "light"/"dark" override it.
  // Remembered on this device (so it applies instantly) and in the account (so it follows you).
  function applyTheme(t) {
    t = t === "light" || t === "dark" ? t : "system";
    if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    try { localStorage.setItem("theme", t); } catch { /* private mode */ }
  }

  // ---------------------------------------------------------------- helpers
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove("show"), 3200);
  }
  const ICON = {
    today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    teams: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/></svg>',
    news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>',
    sched: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  };

  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  const qs = o => new URLSearchParams(o).toString();
  function ymdIn(tz, offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 864e5);
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(d).replace(/-/g, "");
  }
  function timeIn(date, tz) {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
  }
  function longDate(tz, offsetDays = 0) {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" })
      .format(new Date(Date.now() + offsetDays * 864e5));
  }

  // ------------------------------------------------------------ ESPN parsing
  function team(c) {
    const t = c.team || {};
    const rank = c.curatedRank && c.curatedRank.current;
    return {
      name: t.shortDisplayName || t.displayName || t.name || "?",
      full: t.displayName || t.shortDisplayName || "?",
      abbr: t.abbreviation || "",
      logo: t.logo || (t.logos && t.logos[0] && t.logos[0].href) || "",
      score: c.score && typeof c.score === "object" ? (c.score.displayValue ?? c.score.value) : c.score, winner: !!c.winner,
      id: String(t.id || ""),
      record: c.records && c.records[0] ? c.records[0].summary : "",
      rank: rank && rank <= 25 ? rank : null,
    };
  }
  function tickets(comp) {
    for (const t of comp.tickets || []) {
      const link = (t.links || []).find(l => l.href);
      if (link) return { summary: t.summary || "", url: link.href };
    }
    return null;
  }
  // Betting lines (ESPN's sportsbook partner): spread, total and moneyline.
  function parseLines(comp) {
    const o = (comp.odds || [])[0];
    if (!o || (!o.details && o.overUnder == null)) return null;
    const close = x => (x && (x.close || x.current || x.open)) || {};
    const ps = o.pointSpread || {}, ml = o.moneyline || {}, tot = o.total || {};
    return {
      provider: (o.provider || {}).name || "",
      details: o.details || "",
      spread: { away: close(ps.away), home: close(ps.home) },
      total: o.overUnder != null ? String(o.overUnder) : "",
      over: close(tot.over).odds || "", under: close(tot.under).odds || "",
      ml: { away: close(ml.away).odds || (o.awayTeamOdds || {}).moneyLine || "", home: close(ml.home).odds || (o.homeTeamOdds || {}).moneyLine || "" },
    };
  }
  // Video highlights and the written recap for finished games.
  function parseHighlights(comp) {
    const vids = (comp.highlights || []).map(h => ({
      title: h.headline || h.description || "Highlights", thumb: h.thumbnail || "",
      url: ((h.links || {}).web || {}).href || "", secs: +h.duration || 0,
    })).filter(v => v.url).slice(0, 3);
    const hl = (comp.headlines || [])[0] || {};
    return { vids, recap: hl.shortLinkText || hl.description || "" };
  }
  function parseGame(e, lg) {
    const comp = (e.competitions || [{}])[0];
    const cs = comp.competitors || [];
    const home = cs.find(c => c.homeAway === "home") || cs[0] || {};
    const away = cs.find(c => c.homeAway === "away") || cs[1] || {};
    const st = ((e.status || comp.status || {}).type) || {};
    const state = st.state || "pre";
    // Scoreboards list channel "names"; team schedules list "media.shortName".
    const bc = [].concat(...(comp.broadcasts || []).map(b => b.names || (b.media && b.media.shortName ? [b.media.shortName] : [])));
    return {
      kind: "game", league: lg, id: e.id, key: `${lg}:${e.id}`, state,
      detail: st.shortDetail || st.detail || "",
      postponed: ["STATUS_POSTPONED", "STATUS_CANCELED"].includes(st.name),
      start: e.date ? new Date(e.date) : null,
      tbd: comp.timeValid === false,
      home: team(home), away: team(away),
      tv: [...new Set(bc)].join(", "),
      odds: state === "pre" ? ((comp.odds || [{}])[0] || {}).details || "" : "",
      lines: state === "pre" ? parseLines(comp) : null,
      highlights: state === "post" ? parseHighlights(comp) : null,
      venue: (comp.venue || {}).fullName || "",
      link: ((e.links || []).find(l => (l.rel || []).includes("summary")) || {}).href || "",
      tickets: state === "pre" ? tickets(comp) : null,
    };
  }
  function fighter(c) {
    const a = c.athlete || {};
    const name = a.displayName || a.fullName || a.shortName || "TBA";
    return { name, short: a.shortName || name, winner: !!c.winner, record: c.records && c.records[0] ? c.records[0].summary : "" };
  }
  function parseCard(e, lg) {
    const bouts = (e.competitions || []).filter(c => (c.competitors || []).length >= 2).map(c => {
      const st = c.status || {};
      const stt = st.type || {};
      let result = "";
      if (stt.state === "post") {
        const method = (st.result || {}).displayName || (st.result || {}).name || "";
        const rnd = st.period ? `R${st.period} ${st.displayClock || ""}`.trim() : "";
        result = [method, rnd].filter(Boolean).join(" · ");
      }
      return { a: fighter(c.competitors[0]), b: fighter(c.competitors[1]), state: stt.state || "pre",
               division: (c.type || {}).abbreviation || (c.type || {}).text || "", result };
    }).reverse();
    const states = new Set(bouts.map(b => b.state));
    const evState = ((e.status || {}).type || {}).state;
    const state = evState || (states.has("in") ? "in" : (states.size && [...states].every(s => s === "post") ? "post" : "pre"));
    const last = (e.competitions || [{}]).slice(-1)[0] || {};
    const bc = [].concat(...(e.competitions || []).flatMap(c => (c.broadcasts || []).map(b => b.names || [])));
    return {
      kind: "fight", league: lg, id: e.id, key: `${lg}:${e.id}`, state, card: e.name || e.shortName || "UFC event", bouts,
      start: e.date ? new Date(e.date) : null, tbd: false, postponed: false,
      tv: [...new Set(bc)].join(", "), venue: (last.venue || e.venue || {}).fullName || "",
      link: ((e.links || [])[0] || {}).href || "", tickets: state === "pre" ? tickets(last) : null, odds: "",
    };
  }
  // Golf: one tournament per week, with a leaderboard.
  function athlete(c) {
    const a = c.athlete || {};
    const name = a.displayName || a.fullName || a.shortName || "?";
    return { name, short: a.shortName || name, flag: (a.flag || {}).href || "", order: Number(c.order) || 999, score: c.score != null ? String(c.score) : "", winner: !!c.winner };
  }
  function eventBase(e, lg, comp, kind) {
    const st = ((comp.status || e.status || {}).type) || {};
    const evSt = ((e.status || {}).type) || {};
    const bc = [].concat(...(comp.broadcasts || []).map(b => b.names || []));
    return {
      kind, league: lg, id: e.id, key: `${lg}:${e.id}`, card: e.name || e.shortName || LEAGUE[lg].name,
      state: evSt.state || st.state || "pre", detail: st.shortDetail || st.detail || "",
      start: comp.date || e.date ? new Date(comp.date || e.date) : null, tbd: comp.timeValid === false, postponed: false,
      tv: [...new Set(bc)].join(", "), odds: "", tickets: null,
      venue: (comp.venue || e.venue || {}).fullName || (e.circuit || {}).fullName || "",
      link: ((e.links || []).find(l => (l.rel || []).includes("summary")) || (e.links || [])[0] || {}).href || "",
    };
  }
  function parseGolf(e, lg) {
    const comp = (e.competitions || [{}])[0];
    const players = (comp.competitors || []).map(athlete).sort((a, b) => a.order - b.order);
    // Position with ties ("T3") from equal scores.
    players.forEach((p, i) => {
      const tied = players.filter(q => q.score === p.score).length > 1;
      const first = players.find(q => q.score === p.score) || p;
      const n = first.order < 999 ? first.order : players.indexOf(first) + 1;
      p.pos = p.score ? (tied ? "T" : "") + n : String(i + 1);
    });
    return { ...eventBase(e, lg, comp, "golf"), players, tbd: true };
  }
  // Racing: F1 weekends have practice/qualifying/race sessions; NASCAR has the race.
  function parseRace(e, lg) {
    const comps = e.competitions || [{}];
    const label = c => ((c.type || {}).abbreviation || "").replace(/^Qual$/, "Qualifying");
    const race = comps.find(c => /^race$/i.test((c.type || {}).abbreviation || "")) || comps[comps.length - 1] || {};
    const sessions = comps.map(c => ({ name: label(c) || "Race", state: (((c.status || {}).type) || {}).state || "pre",
      start: c.date ? new Date(c.date) : null, results: (c.competitors || []).map(athlete).sort((a, b) => a.order - b.order) }));
    const ev = eventBase(e, lg, race, "race");
    const raceSt = (((race.status || {}).type) || {}).state || "pre";
    // The weekend is "live" while any session runs, and final once the race is done.
    const anyIn = sessions.some(x => x.state === "in");
    ev.state = raceSt === "post" ? "post" : anyIn || raceSt === "in" ? "in" : "pre";
    ev.players = sessions.flatMap(x => x.results).filter((p, i, a) => a.findIndex(q => q.name === p.name) === i);
    ev.sessions = sessions;
    ev.results = (sessions.find(x => /^race$/i.test(x.name)) || sessions[sessions.length - 1] || { results: [] }).results;
    return ev;
  }
  function isFav(g, favs) {
    if (!favs.size) return false;
    const names = new Set();
    if (g.kind === "golf" || g.kind === "race") {
      g.players.forEach(f => [f.name, f.short, f.name.split(" ").pop()].forEach(n => n && names.add(n.toLowerCase())));
    } else if (g.kind === "fight") {
      g.bouts.forEach(b => [b.a, b.b].forEach(f => [f.name, f.short, f.name.split(" ").pop()].forEach(n => n && names.add(n.toLowerCase()))));
    } else {
      [g.home, g.away].forEach(t => [t.abbr, t.name, t.full].forEach(n => n && names.add(n.toLowerCase())));
    }
    for (const n of names) if (favs.has(n)) return true;
    return false;
  }

  // ------------------------------------------------------ tickets / calendar
  const wanted = (setting, fav) => setting === "all" || (setting === "favorites" && fav);
  const upcoming = g => g.state === "pre" && !g.postponed && g.start;
  function ticketLink(g, fav, s) {
    if (!upcoming(g) || !wanted(s.ticket_links, fav)) return null;
    if (g.tickets && g.tickets.url) {
      const price = (g.tickets.summary.match(/\$\s?[\d,]+(?:\.\d\d)?/) || [""])[0].replace(" ", "");
      return { label: price ? `Tickets from ${price}` : "Tickets", url: g.tickets.url };
    }
    const d = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" }).format(g.start);
    const matchup = isEvent(g) ? g.card : `${g.away.full} vs ${g.home.full}`;
    return { label: "Find tickets", url: "https://www.google.com/search?q=" + encodeURIComponent(`${matchup} tickets ${d}`) };
  }
  const utcStamp = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  function calendarLink(g, fav, s) {
    if (!upcoming(g) || !wanted(s.calendar_links, fav)) return null;
    const title = isEvent(g) ? g.card : `${g.away.name} @ ${g.home.name}`;
    let dates;
    if (g.tbd) {
      const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
      const day = ny.format(g.start).replace(/-/g, "");
      const next = ny.format(new Date(g.start.getTime() + 864e5)).replace(/-/g, "");
      dates = `${day}/${next}`;
    } else {
      dates = `${utcStamp(g.start)}/${utcStamp(new Date(g.start.getTime() + (GAME_HOURS[g.league] || 3) * 36e5))}`;
    }
    const details = [LEAGUE[g.league].name, g.tv && `TV: ${g.tv}`, g.odds && `Line: ${g.odds}`,
      g.tbd && "Start time not announced yet.", g.tickets && g.tickets.url && `Tickets: ${g.tickets.url}`, g.link].filter(Boolean).join("\n");
    const p = { action: "TEMPLATE", text: title, dates, details };
    if (g.venue) p.location = g.venue;
    return "https://calendar.google.com/calendar/render?" + qs(p);
  }

  // ------------------------------------------------------------------ auth
  async function boot() {
    if (!configured) return renderNotConfigured();
    if (!sb) {
      $app.innerHTML = `<div class="center"><p>Couldn't load the sign-in library. Check your connection and refresh.</p></div>`;
      return;
    }
    const h = location.hash;
    if (/type=recovery/.test(h)) state.recovering = true;
    const linkErr = /error_code=otp_expired|error=access_denied/.test(h)
      ? "That email link has expired or was already used. Sign in, or tap \"Forgot password?\" for a new one." : "";
    if (linkErr) history.replaceState(null, "", location.pathname + location.search);
    sb.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") { state.recovering = true; if (session) renderSetPassword(session.user); return; }
      if (event === "SIGNED_OUT") { stopLive(); state.user = null; state.sub = null; state.chat = { ok: null, groups: null, groupId: null, thread: null, threadTitle: "", members: [], channel: null, poll: null, showSettings: false }; renderSignIn(); }
      if (event === "SIGNED_IN" && session && (!state.user || state.user.id !== session.user.id)) loadAccount(session.user);
    });
    const pj = (location.hash.match(/^#join=([0-9a-fA-F]{6,32})$/) || [])[1];
    if (pj) store.set("pendingJoin", pj);
    const { data } = await sb.auth.getSession();
    if (data && data.session) await loadAccount(data.session.user);
    else renderSignIn(linkErr);
  }

  async function loadAccount(user) {
    state.user = user;
    if (state.recovering) return renderSetPassword(user);
    $app.innerHTML = `<div class="center muted">Loading your teams…</div>`;
    const { data, error } = await sb.from("subscribers").select("*").eq("id", user.id).maybeSingle();
    if (error) {
      $app.innerHTML = `<div class="center"><p>Couldn't load your settings.</p><p class="small muted">${esc(error.message)}</p>
        <button class="btn" id="retry">Try again</button></div>`;
      document.getElementById("retry").onclick = () => loadAccount(user);
      return;
    }
    state.sub = data;
    state.draft = { ...DEFAULTS, ...(data || {}) };
    if (data && data.theme) applyTheme(data.theme);
    const joinCode = (location.hash.match(/^#join=([0-9a-fA-F]{6,32})$/) || [])[1] || store.get("pendingJoin");
    const chatLink = location.hash.match(/^#chat\/([0-9a-f-]{36})(?:\/([a-z0-9]{2,8}:\d+|general))?$/);
    state.tab = data ? (location.hash === "#games" ? "today" : (store.get("tab") || "today")) : "teams";
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    if (data) loadGroups().then(() => { if (state.tab === "today" && state.days[state.day]) paintToday(); paintChatBadge(); });
    renderApp();
    if (data && joinCode) handleJoin(joinCode.toLowerCase());
    else if (joinCode) store.set("pendingJoin", joinCode);          // finish signing up first, then join
    else if (data && chatLink) openGroup(chatLink[1], chatLink[2] || null);
  }

  function renderNotConfigured() {
    $app.className = "no-tabs";
    $app.innerHTML = `<div class="signin">
      <img class="brand" src="icons/icon-192.png" alt="">
      <h1>Almost there</h1>
      <p>This app isn't connected to its database yet. Open <code>config.js</code> and paste in your
      Supabase project URL and anon public key (see the setup guide, step 3).</p></div>`;
  }

  // Sign in with email + password. (The emailed code still works as a backup.)
  function renderSignIn(errorMsg = "", mode = "signin", notice = "") {
    $app.className = "no-tabs";
    const up = mode === "signup";
    $app.innerHTML = `<div class="signin">
      <img class="brand" src="icons/icon-192.png" alt="">
      <div class="kicker">${esc(APP_NAME)}</div>
      <h1>${up ? "Create your account" : "Your teams, every morning"}</h1>
      <p class="muted">${up ? "Pick a password you'll use to sign in on any device."
        : "Scores, today's games, tickets and calendar invites, plus a daily email with just the teams you follow."}</p>
      ${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
      <form id="pwForm" class="field" novalidate>
        <label for="email">Email</label>
        <input id="email" type="email" inputmode="email" autocomplete="${up ? "email" : "username"}" placeholder="name@example.com" value="${esc(state.pendingEmail)}" required>
        <label for="password" style="margin-top:10px">Password</label>
        <input id="password" type="password" autocomplete="${up ? "new-password" : "current-password"}" minlength="8" placeholder="${up ? "At least 8 characters" : ""}" required>
        <p class="error ${errorMsg ? "" : "hidden"}" id="err">${esc(errorMsg)}</p>
        <button class="btn primary block" style="margin-top:12px" id="go">${up ? "Create account" : "Sign in"}</button>
      </form>
      ${up ? `<button class="btn link" id="toSignin">Already have an account? Sign in</button>`
           : `<button class="btn link" id="toSignup">New here? Create an account</button>
              <button class="btn link" id="forgot">Forgot password? (or first time setting one)</button>`}
      ${installHint()}
    </div>`;
    const $ = id => document.getElementById(id);
    const email = () => $("email").value.trim();
    const show = msg => { $("err").textContent = msg; $("err").classList.remove("hidden"); };
    const okEmail = () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email()) || (show("Enter a valid email address."), false);
    const remember = () => { state.pendingEmail = email(); };
    if (up) $("toSignin").onclick = () => { remember(); renderSignIn("", "signin"); };
    else {
      $("toSignup").onclick = () => { remember(); renderSignIn("", "signup"); };
      $("forgot").onclick = async () => {
        if (!okEmail()) return;
        remember();
        const { error } = await sb.auth.resetPasswordForEmail(email(), { redirectTo: location.origin + location.pathname });
        if (error) return show(friendly(error));
        renderSignIn("", "signin", `We emailed a link to ${email()}. Open it, choose a password, then come back here and sign in.`);
      };
    }
    $("pwForm").onsubmit = async ev => {
      ev.preventDefault();
      if (!okEmail()) return;
      const password = $("password").value;
      if (up && password.length < 8) return show("Use at least 8 characters.");
      if (!password) return show("Enter your password.");
      remember();
      const btn = $("go"); btn.disabled = true; btn.textContent = up ? "Creating…" : "Signing in…";
      const res = up
        ? await sb.auth.signUp({ email: email(), password, options: { emailRedirectTo: location.origin + location.pathname } })
        : await sb.auth.signInWithPassword({ email: email(), password });
      btn.disabled = false; btn.textContent = up ? "Create account" : "Sign in";
      if (res.error) {
        if (!up && /invalid login/i.test(res.error.message))
          return show("Wrong email or password. If you used to sign in with a code, tap \"Forgot password?\" to set one.");
        if (/not confirmed/i.test(res.error.message))
          return show("Confirm your email first: open the link we emailed you, then sign in here.");
        return show(friendly(res.error));
      }
      if (res.data.session) return loadAccount(res.data.session.user);
      if (up && res.data.user && Array.isArray(res.data.user.identities) && res.data.user.identities.length === 0)
        return show("That email already has an account. Sign in instead, or tap \"Forgot password?\" on the sign-in screen.");
      // Email confirmation is on: they tap the link once, then sign in with their password.
      renderSignIn("", "signin", `Almost done! We emailed a link to ${email()}. Open it to confirm your email, then come back here and sign in.`);
    };
  }

  function friendly(error) {
    const m = (error && error.message) || "Something went wrong.";
    if (/rate|seconds|limit/i.test(m)) return "Too many tries. Wait a minute, then try again.";
    if (/already registered|already exists/i.test(m)) return "That email already has an account. Sign in instead (or tap \"Forgot password?\").";
    if (/weak|pwned|easy to guess/i.test(m)) return "That password is too easy to guess. Try a longer one.";
    return m;
  }

  // Set a new password (after opening a "reset password" email link, or from My Teams).
  function renderSetPassword(user) {
    $app.className = "no-tabs";
    $app.innerHTML = `<div class="signin">
      <img class="brand" src="icons/icon-192.png" alt="">
      <h1>Choose a password</h1>
      <p class="muted">For <strong>${esc(user.email)}</strong>. You'll use it to sign in on your phone and computer.</p>
      <form id="setForm" class="field" novalidate>
        <label for="newpw">New password</label>
        <input id="newpw" type="password" autocomplete="new-password" minlength="8" placeholder="At least 8 characters" required>
        <p class="error hidden" id="err"></p>
        <button class="btn primary block" style="margin-top:12px" id="go">Save password</button>
      </form>
      <button class="btn link" id="cancel">Not now</button>
    </div>`;
    const $ = id => document.getElementById(id);
    $("newpw").focus();
    $("cancel").onclick = () => { state.recovering = false; loadAccount(user); };
    $("setForm").onsubmit = async ev => {
      ev.preventDefault();
      const password = $("newpw").value;
      const show = msg => { $("err").textContent = msg; $("err").classList.remove("hidden"); };
      if (password.length < 8) return show("Use at least 8 characters.");
      $("go").disabled = true;
      const { error } = await sb.auth.updateUser({ password });
      $("go").disabled = false;
      if (error) return show(/different from the old/i.test(error.message) ? "That's your current password. Pick a new one." : friendly(error));
      state.recovering = false;
      toast("Password saved. Use it to sign in from now on.");
      loadAccount(user);
    };
  }

  function installHint() {
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (standalone) return "";
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const how = ios ? "tap the Share button, then <strong>Add to Home Screen</strong>"
                    : "open your browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>";
    return `<div class="install">📱 Put it on your phone: ${how}.</div>`;
  }

  // -------------------------------------------------------------- app shell
  // "No favorites yet" prompt with a button that jumps to the team picker in My Teams.
  const addFavsBox = (msg = "You haven't picked any favorite teams yet.") =>
    `<div class="addfavs"><span>${msg}</span><button type="button" class="btn primary" data-addfavs>★ Add favorite teams</button></div>`;
  function goAddFavs() {
    state.tab = "teams"; store.set("tab", "teams"); renderApp();
    const box = document.getElementById("teamSearch");
    if (box) { box.scrollIntoView({ behavior: "smooth", block: "center" }); setTimeout(() => box.focus({ preventScroll: true }), 350); }
  }
  $app.addEventListener("click", e => { if (e.target.closest("[data-addfavs]")) { e.preventDefault(); goAddFavs(); } });

  function renderApp() {
    $app.className = "";
    const first = !state.sub;
    if (!["today", "sched", "news", "chat", "teams"].includes(state.tab) || (state.tab === "chat" && state.chat.ok === false)) state.tab = "today";
    const tab = (key, icon, label) =>
      `<button data-tab="${key}" ${state.tab === key ? 'aria-current="page"' : ""}>${icon}${label}</button>`;
    $app.innerHTML = `
      <div id="view"></div>
      ${first ? "" : `<nav class="tabs" aria-label="Main">
        ${tab("today", ICON.today, "Games")}${tab("sched", ICON.sched, "Schedule")}${tab("news", ICON.news, "News")}${state.chat.ok === false ? "" : tab("chat", ICON.chat, "Chat")}${tab("teams", ICON.teams, "My Teams")}
      </nav>`}`;
    if (first) $app.className = "no-tabs";
    $app.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
      if (b.dataset.tab === "chat" && state.tab === "chat") state.chat.groupId = null;   // tap Chat again: back to the list
      state.tab = b.dataset.tab; store.set("tab", state.tab); renderApp();
      window.scrollTo(0, 0);
    });
    if (state.tab !== "chat") stopLive();
    if (first || state.tab === "teams") renderTeams();
    else if (state.tab === "news") renderNews();
    else if (state.tab === "sched") renderSched();
    else if (state.tab === "chat") renderChat();
    else renderToday();
    paintChatBadge();
  }

  // ------------------------------------------- games: yesterday / today / tomorrow
  const favSet = () => new Set((state.sub ? state.sub.favorite_teams : []).map(f => f.toLowerCase()));
  const DAYS = [[-1, "Yesterday"], [0, "Today"], [1, "Tomorrow"]];
  const isStale = off => {
    const d = state.days[off];
    if (!d) return true;
    return Date.now() - d.at > (off === 0 ? 60e3 : 10 * 60e3);   // today refreshes every minute
  };

  async function loadDay(off) {
    if (state.loadingDay[off]) return;
    state.loadingDay[off] = true;
    paintRefresh();
    const s = state.sub;
    const ymd = ymdIn(s.timezone, off);
    const results = await Promise.all(s.leagues.filter(k => LEAGUE[k]).map(async key => {
      const lg = LEAGUE[key];
      try {
        const data = await getJSON(`${ESPN}/${lg.path}/scoreboard?` + qs({ ...(lg.params || {}), dates: ymd }));
        const parse = { fight: parseCard, golf: parseGolf, race: parseRace }[lg.kind] || parseGame;
        return { league: key, games: (data.events || []).map(e => parse(e, key)) };
      } catch (e) {
        return { league: key, games: [], error: true };
      }
    }));
    state.days[off] = { at: new Date(), leagues: results };
    state.loadingDay[off] = false;
    if (state.tab === "today" && state.day === off) paintToday(); else paintRefresh();
  }

  function renderToday() {
    const s = state.sub;
    const hasFavs = s.favorite_teams.length > 0;
    if (!hasFavs) state.myTeamsOnly = false;
    document.getElementById("view").innerHTML = `
      <header class="top">
        <div><div class="kicker">${s.name ? "Hi, " + esc(s.name) : esc(APP_NAME)}</div><h1>${esc(longDate(s.timezone, state.day))}</h1></div>
        <button class="icon-btn" id="refresh" aria-label="Refresh scores">${ICON.refresh}</button>
      </header>
      <div class="seg wide" role="group" aria-label="Which day">
        ${DAYS.map(([off, label]) => `<button data-day="${off}" aria-pressed="${state.day === off}">${label}</button>`).join("")}
      </div>
      <div class="bar">
        <div class="seg" role="group" aria-label="Which games">
          <button data-f="mine" aria-pressed="${state.myTeamsOnly}" ${hasFavs ? "" : "disabled"}>My teams</button>
          <button data-f="all" aria-pressed="${!state.myTeamsOnly}">All games</button>
        </div>
        <span class="small muted" id="updated"></span>
      </div>
      ${s.active ? "" : `<p class="install">⏸ Your daily email is off. Everything is still here in the app.</p>`}
      ${hasFavs ? "" : addFavsBox("Pick your favorite teams to see their games first, with tickets and alerts.")}
      <div id="games"><div class="empty">Loading games…</div></div>`;
    document.getElementById("refresh").onclick = () => loadDay(state.day);
    document.querySelectorAll("[data-day]").forEach(b => b.onclick = () => {
      state.day = +b.dataset.day; state.showAllCollege = false; renderToday();
    });
    document.querySelectorAll("[data-f]").forEach(b => b.onclick = () => {
      state.myTeamsOnly = b.dataset.f === "mine"; renderToday();
    });
    if (state.days[state.day]) paintToday();
    if (isStale(state.day)) loadDay(state.day);
  }

  function paintRefresh() {
    const r = document.getElementById("refresh");
    const busy = state.tab === "news" ? state.loadingNews : !!state.loadingDay[state.day];
    if (r) r.classList.toggle("spin", busy);
  }

  function updatedLabel(at) {
    const upd = document.getElementById("updated");
    if (upd) upd.textContent = "Updated " + new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(at);
  }

  function paintToday() {
    paintRefresh();
    const box = document.getElementById("games");
    const day = state.days[state.day];
    if (!box || !day) return;
    const s = state.sub;
    const favs = favSet();
    updatedLabel(day.at);

    let html = "";
    let shown = 0;
    let failed = 0;
    for (const r of day.leagues) {
      const lg = LEAGUE[r.league];
      if (r.error) { failed++; continue; }
      let games = r.games.map(g => ({ g, fav: isFav(g, favs) }));
      if (state.myTeamsOnly) games = games.filter(x => x.fav);
      let hidden = 0;
      if (!state.myTeamsOnly && lg.busy && games.length > lg.busy && !state.showAllCollege) {
        const keep = games.filter(x => x.fav || (x.g.home && (x.g.home.rank || x.g.away.rank)));
        hidden = games.length - keep.length;
        games = keep;
      }
      if (!games.length) continue;
      const order = { in: 0, pre: 1, post: 2 };
      games.sort((a, b) => (b.fav - a.fav) || (order[a.g.state] - order[b.g.state]) || ((a.g.start || 0) - (b.g.start || 0)));
      shown += games.length;
      const unit = { fight: "card", golf: "tournament", race: "race" }[lg.kind] || "game";
      html += `<section class="card"><div class="card-head">${esc(lg.name)}<span>${games.length} ${unit}${games.length === 1 ? "" : "s"}</span></div>
        ${games.map(x => x.g.kind === "fight" ? cardRow(x.g, x.fav, s) : isEvent(x.g) ? eventRow(x.g, x.fav, s) : gameRow(x.g, x.fav, s)).join("")}
        ${hidden ? `<div class="more"><button class="btn link" data-showall>Show ${hidden} more unranked games</button></div>` : ""}
      </section>`;
    }
    if (!shown) {
      const when = { "-1": "played yesterday", "0": "play today", "1": "play tomorrow" }[state.day];
      const word = { "-1": "yesterday", "0": "today", "1": "tomorrow" }[state.day];
      html = state.myTeamsOnly
        ? `<div class="empty">None of your teams ${when}.<br><button class="btn link" data-all>See all games</button></div>`
        : `<div class="empty">No games ${word} in your leagues.</div>`;
    }
    if (failed) html += `<p class="small muted center" style="padding:8px 0">Couldn't reach ESPN for ${failed} league${failed > 1 ? "s" : ""}. Tap ↻ to try again.</p>`;
    box.innerHTML = html;
    box.querySelectorAll("[data-showall]").forEach(b => b.onclick = () => { state.showAllCollege = true; paintToday(); });
    box.querySelectorAll("[data-discuss]").forEach(b => b.onclick = () => discuss(b.dataset.discuss));
    box.querySelectorAll("[data-all]").forEach(b => b.onclick = () => { state.myTeamsOnly = false; renderToday(); });
  }

  // ------------------------------------------------------------------- news
  function articleIsFav(a, favs) {
    // Same rules as the email: ESPN's team tags first, then full names in the headline.
    for (const c of a.categories || []) {
      if (c.type !== "team") continue;
      const t = c.team || {};
      const tags = [c.description, t.description, t.abbreviation, t.name].filter(Boolean).map(x => String(x).toLowerCase());
      if (tags.some(x => favs.has(x))) return true;
      if (tags.some(x => [...favs].some(f => f.length > 4 && x.includes(f)))) return true;
    }
    const text = `${a.headline} ${a.description}`.toLowerCase();
    return [...favs].some(f => f.length > 4 && text.includes(f));
  }

  async function loadNews() {
    if (state.loadingNews) return;
    state.loadingNews = true;
    paintRefresh();
    let failed = 0;
    const lists = await Promise.all(state.sub.leagues.filter(k => LEAGUE[k]).map(async key => {
      try {
        const data = await getJSON(`${ESPN}/${LEAGUE[key].path}/news?limit=50`);
        return (data.articles || []).filter(a => !["Media", "Video"].includes(a.type) && (a.headline || "").trim()).map(a => ({
          league: key,
          headline: a.headline.trim(),
          description: (a.description || "").trim(),
          url: ((a.links || {}).web || {}).href || "",
          image: ((a.images || [])[0] || {}).url || "",
          published: a.published ? new Date(a.published) : null,
          categories: a.categories || [],
        }));
      } catch (e) {
        failed++;
        return [];
      }
    }));
    state.news = { at: new Date(), items: lists.flat(), failed };
    state.loadingNews = false;
    if (state.tab === "news") paintNews(); else paintRefresh();
  }

  function renderNews() {
    const s = state.sub;
    const hasFavs = s.favorite_teams.length > 0;
    if (state.newsMine === null) state.newsMine = hasFavs && s.favorites_only_headlines;
    if (!hasFavs) state.newsMine = false;
    document.getElementById("view").innerHTML = `
      <header class="top">
        <div><div class="kicker">${s.name ? "Hi, " + esc(s.name) : esc(APP_NAME)}</div><h1>News</h1></div>
        <button class="icon-btn" id="refresh" aria-label="Refresh news">${ICON.refresh}</button>
      </header>
      <div class="bar">
        <div class="seg" role="group" aria-label="Which news">
          <button data-n="mine" aria-pressed="${state.newsMine}" ${hasFavs ? "" : "disabled"}>My teams</button>
          <button data-n="all" aria-pressed="${!state.newsMine}">All news</button>
        </div>
        <span class="small muted" id="updated"></span>
      </div>
      ${hasFavs ? "" : addFavsBox("Pick your favorite teams to get news about them.")}
      <div id="news"><div class="empty">Loading news…</div></div>`;
    document.getElementById("refresh").onclick = loadNews;
    document.querySelectorAll("[data-n]").forEach(b => b.onclick = () => { state.newsMine = b.dataset.n === "mine"; renderNews(); });
    if (state.news) paintNews();
    if (!state.news || Date.now() - state.news.at > 10 * 60e3) loadNews();
  }

  function ago(d) {
    if (!d || isNaN(d)) return "";
    const m = Math.round((Date.now() - d) / 60e3);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.round(h / 24);
    return days === 1 ? "yesterday" : `${days}d ago`;
  }

  function paintNews() {
    paintRefresh();
    const box = document.getElementById("news");
    if (!box || !state.news) return;
    updatedLabel(state.news.at);
    const favs = favSet();
    const seen = new Set();
    let items = state.news.items
      .filter(a => { const k = a.url || a.headline; return seen.has(k) ? false : seen.add(k); })
      .map(a => ({ ...a, fav: articleIsFav(a, favs) }));
    if (state.newsMine) items = items.filter(a => a.fav);
    items.sort((a, b) => (b.published || 0) - (a.published || 0));
    items = items.slice(0, 40);
    let html = items.length ? `<section class="card">${items.map(a => `
      <a class="news ${a.fav && !state.newsMine ? "fav" : ""}" href="${esc(a.url || "#")}" target="_blank" rel="noopener">
        <div class="news-txt">
          <div class="news-tag">${a.fav ? '<span class="star">★</span> ' : ""}${esc(LEAGUE[a.league].name)}${a.published ? ` · <span class="muted">${esc(ago(a.published))}</span>` : ""}</div>
          <div class="news-hl">${esc(a.headline)}</div>
          ${a.description ? `<div class="news-desc">${esc(a.description)}</div>` : ""}
        </div>
        ${a.image ? `<img class="news-img" src="${esc(a.image)}" alt="" loading="lazy">` : ""}
      </a>`).join("")}</section>`
      : state.newsMine
        ? `<div class="empty">No recent stories about your teams.<br><button class="btn link" data-allnews>See all news</button></div>`
        : `<div class="empty">No news right now.</div>`;
    if (state.news.failed) html += `<p class="small muted center" style="padding:8px 0">Couldn't reach ESPN for ${state.news.failed} league${state.news.failed > 1 ? "s" : ""}. Tap ↻ to try again.</p>`;
    box.innerHTML = html;
    box.querySelectorAll("[data-allnews]").forEach(b => b.onclick = () => { state.newsMine = false; renderNews(); });
  }

  // ------------------------------------------------------- schedule & standings
  // Each favorite team's upcoming games (with tickets) and the standings it's in.
  const STAND_COLS = {
    nfl: [["W-L", "rec"], ["PCT", "winpercent"], ["DIV", "divisionrecord"], ["STRK", "streak"]],
    nba: [["W-L", "rec"], ["PCT", "winpercent"], ["GB", "gamesbehind"], ["STRK", "streak"]],
    nhl: [["W-L-OT", "rec"], ["PTS", "points"], ["STRK", "streak"]],
    mlb: [["W-L", "rec"], ["PCT", "winpercent"], ["GB", "gamesbehind"], ["STRK", "streak"]],
    cfb: [["Conf", "vsconf"], ["Overall", "rec"], ["STRK", "streak"]],
    cbb: [["Conf", "vsconf"], ["Overall", "rec"], ["STRK", "streak"]],
    f1: [["PTS", "points"]],
    nascar: [["PTS", "points"]],
  };
  const STAND_URLS = {
    nfl: ["?level=3"], nba: ["?level=3"], nhl: ["?level=3"], mlb: ["?level=3"],
    cfb: ["?group=80", "?group=81"], cbb: ["?group=50"], f1: [""], nascar: [""],
  };
  const pctOf = rec => { const m = String(rec || "").match(/^(\d+)-(\d+)/); return m ? (+m[1] / Math.max(1, +m[1] + +m[2])) : 0; };

  // Favorites -> [{league, id, name, logo}] for team sports (uses the same team lists as My Teams).
  async function myTeamList() {
    const s = state.sub;
    const leagues = s.leagues.filter(k => LEAGUE[k] && !isPeople(k));
    await loadTeams(leagues);
    const favs = favSet();
    const out = [];
    for (const k of leagues) for (const t of state.teams[k] || []) {
      if (!t.id) continue;
      if ([t.name, t.nick, t.short, t.abbr].some(n => n && favs.has(n.toLowerCase())) && !out.some(o => o.league === k && o.id === t.id))
        out.push({ league: k, id: t.id, name: t.name, logo: t.logo, conf: t.conf || "" });
    }
    return out;
  }

  async function loadSchedules() {
    const sc = state.sched;
    if (sc.loading) return;
    sc.loading = true; paintSchedRefresh();
    try {
      sc.mine = await myTeamList();
      await Promise.all(sc.mine.map(async t => {
        const key = `${t.league}:${t.id}`;
        try {
          const data = await getJSON(`${ESPN}/${LEAGUE[t.league].path}/teams/${t.id}/schedule`);
          const games = (data.events || []).map(e => parseGame(e, t.league)).filter(g => g.start).sort((a, b) => a.start - b.start);
          const rec = ((data.team || {}).recordSummary) || "";
          const standing = ((data.team || {}).standingSummary) || "";
          sc.teams[key] = { at: Date.now(), games, rec, standing };
        } catch { sc.teams[key] = { at: Date.now(), games: [], failed: true }; }
      }));
    } finally { sc.loading = false; }
    sc.at = Date.now();
    if (state.tab === "sched") paintSched(); else paintSchedRefresh();
  }

  async function loadStandings() {
    const sc = state.sched;
    const leagues = state.sub.leagues.filter(k => STAND_URLS[k]);
    sc.loading = true; paintSchedRefresh();
    await Promise.all(leagues.map(async k => {
      const groups = [];
      try {
        for (const q of STAND_URLS[k]) {
          const data = await getJSON(`https://site.api.espn.com/apis/v2/sports/${LEAGUE[k].path}/standings${q}`);
          const isRace = LEAGUE[k].kind === "race";
          const walk = (node, parent) => {
            const entries = (node.standings || {}).entries || [];
            if (entries.length) {
              let name = String(node.shortName || node.name || "");
              if (k === "mlb") name = name.replace("American League", "AL").replace("National League", "NL");
              if ((k === "nba" || k === "nhl") && parent) name = `${String(parent.name || "").replace(/ern Conference$/, "").replace(/ Conference$/, "")} · ${String(node.name || "").replace(/ Division$/, "")}`;
              if (k === "cfb" && q === "?group=81") name = "FCS · " + name.replace(/^FCS /, "");
              if (isRace && /constructor/i.test(node.name || "")) return;    // drivers only
              groups.push({ name: isRace ? "Driver standings" : name, rows: entries.map(e => {
                const st = {};
                for (const x of e.stats || []) if (x.type && st[x.type] == null) st[x.type] = { v: x.value, d: x.displayValue ?? x.summary ?? "" };
                const who = e.team || e.athlete || {};
                const rec = st.total ? String(st.total.d).split(",")[0] : st.overall && st.overall.d ? String(st.overall.d).split(",")[0]
                  : st.wins ? `${st.wins.d}-${(st.losses || { d: 0 }).d}` + (st.otlosses ? `-${st.otlosses.d}` : "") : "";
                return { id: String(who.id || ""), name: who.displayName || who.name || "?", short: who.shortDisplayName || who.displayName || "?",
                         abbr: who.abbreviation || "", logo: (who.logos && who.logos[0] && who.logos[0].href) || (who.flag && who.flag.href) || "",
                         st, rec, rank: st.rank ? +st.rank.v : null };
              }) });
            }
            for (const c of node.children || []) walk(c, node);
          };
          walk(data, null);
        }
        for (const g of groups) g.rows.sort((a, b) => {
          if (k === "nhl") return ((b.st.points || {}).v || 0) - ((a.st.points || {}).v || 0);
          if (k === "cfb" || k === "cbb") return (pctOf((b.st.vsconf || {}).d) - pctOf((a.st.vsconf || {}).d)) || (pctOf(b.rec) - pctOf(a.rec));
          if (LEAGUE[k].kind === "race") return (a.rank || 999) - (b.rank || 999);
          return ((b.st.winpercent || {}).v ?? pctOf(b.rec)) - ((a.st.winpercent || {}).v ?? pctOf(a.rec));
        });
        sc.standings[k] = { at: Date.now(), groups };
      } catch { sc.standings[k] = { at: Date.now(), groups: [], failed: true }; }
    }));
    sc.loading = false;
    if (state.tab === "sched") paintSched(); else paintSchedRefresh();
  }

  function paintSchedRefresh() {
    const r = document.getElementById("refresh");
    if (r && state.tab === "sched") r.classList.toggle("spin", !!state.sched.loading);
  }

  function renderSched() {
    const sc = state.sched;
    if (!sc.inited) { sc.view = store.get("schedView") === "standings" ? "standings" : "schedule"; sc.inited = true; }
    document.getElementById("view").innerHTML = `
      <header class="top">
        <div><div class="kicker">My teams</div><h1>${sc.view === "standings" ? "Standings" : "Schedule"}</h1></div>
        <button class="icon-btn" id="refresh" aria-label="Refresh">${ICON.refresh}</button>
      </header>
      <div class="seg wide" role="group" aria-label="Schedule or standings">
        <button data-sv="schedule" aria-pressed="${sc.view === "schedule"}">Upcoming games</button>
        <button data-sv="standings" aria-pressed="${sc.view === "standings"}">Standings</button>
      </div>
      <div id="sched"><div class="empty">Loading…</div></div>`;
    document.querySelectorAll("[data-sv]").forEach(b => b.onclick = () => { sc.view = b.dataset.sv; store.set("schedView", sc.view); renderSched(); });
    document.getElementById("refresh").onclick = () => sc.view === "standings" ? loadStandings() : loadSchedules();
    const stale = at => !at || Date.now() - at > 10 * 60e3;
    if (sc.view === "standings") {
      paintSched();
      if (state.sub.leagues.some(k => STAND_URLS[k] && stale((sc.standings[k] || {}).at))) loadStandings();
      if (!sc.mine) myTeamList().then(m => { sc.mine = m; if (state.tab === "sched") paintSched(); });
    } else {
      paintSched();
      if (stale(sc.at)) loadSchedules();
    }
  }

  function paintSched() {
    const box = document.getElementById("sched");
    if (!box) return;
    paintSchedRefresh();
    const sc = state.sched, s = state.sub;
    if (sc.view === "standings") return paintStandings(box);
    if (!sc.mine) { box.innerHTML = `<div class="empty">Loading your teams…</div>`; return; }
    if (!sc.mine.length) {
      box.innerHTML = addFavsBox(state.sub.favorite_teams.length
          ? "None of your favorites are teams with a schedule here (golf, racing and UFC events are on the Games tab)."
          : "Pick your favorite teams to see their upcoming games and tickets here.");
      return;
    }
    const day = d => new Intl.DateTimeFormat("en-US", { timeZone: s.timezone, weekday: "short", month: "short", day: "numeric" }).format(d);
    box.innerHTML = sc.mine.map(t => {
      const key = `${t.league}:${t.id}`;
      const info = sc.teams[key];
      const head = `<div class="card-head"><span>${t.logo ? `<img class="logo" src="${esc(t.logo)}" alt="" loading="lazy"> ` : ""}${esc(t.name)}</span>
        <span>${esc(LEAGUE[t.league].name)}</span></div>`;
      if (!info) return `<section class="card">${head}<div class="row muted">Loading…</div></section>`;
      if (info.failed) return `<section class="card">${head}<div class="row muted">Couldn't load this schedule. Tap ↻ to try again.</div></section>`;
      const upcoming = info.games.filter(g => g.state !== "post" && !g.postponed);
      const last = info.games.filter(g => g.state === "post").slice(-1)[0];
      const n = sc.full[key] ? upcoming.length : 5;
      const opp = g => {
        const home = g.home.id === t.id;
        const o = home ? g.away : g.home;
        return `${home ? "vs" : "@"} ${o.rank ? "#" + o.rank + " " : ""}${o.name}`;
      };
      const lastLine = last ? (() => {
        const mine = last.home.id === t.id ? last.home : last.away, o = mine === last.home ? last.away : last.home;
        const wl = mine.winner ? "W" : o.winner ? "L" : (+mine.score > +o.score ? "W" : +mine.score < +o.score ? "L" : "T");
        return `<div class="sched-last small muted">Last game: <strong class="${wl === "W" ? "win" : ""}">${wl} ${esc(mine.score)}–${esc(o.score)}</strong> ${esc(opp(last))} · ${esc(day(last.start))}</div>`;
      })() : "";
      const summary = [info.rec && `Record ${info.rec}`, info.standing].filter(Boolean).join(" · ");
      const rows = upcoming.slice(0, n).map(g => {
        const tk = ticketLink(g, true, { ...s, ticket_links: s.ticket_links === "none" ? "favorites" : s.ticket_links });
        const cal = calendarLink(g, true, { ...s, calendar_links: s.calendar_links === "none" ? "favorites" : s.calendar_links });
        const time = g.state === "in" ? `<span class="live">● Live</span>` : g.tbd ? "Time TBD" : esc(timeIn(g.start, s.timezone));
        return `<div class="row sched-row">
          <div class="sched-main">
            <div class="sched-date">${esc(day(g.start))}</div>
            <div class="sched-opp"><strong>${esc(opp(g))}</strong></div>
            <div class="small muted">${time}${g.tv ? " · " + esc(g.tv) : ""}${g.venue ? " · " + esc(g.venue) : ""}</div>
          </div>
          <div class="actions">
            ${tk ? `<a class="pill ticket" href="${esc(tk.url)}" target="_blank" rel="noopener">🎟 ${esc(tk.label)}</a>` : ""}
            ${cal ? `<a class="pill cal" href="${esc(cal)}" target="_blank" rel="noopener">+ Calendar</a>` : ""}
          </div>
        </div>`;
      }).join("");
      return `<section class="card">${head}
        ${summary || lastLine ? `<div class="row sched-sum">${summary ? `<div class="small">${esc(summary)}</div>` : ""}${lastLine}</div>` : ""}
        ${rows || `<div class="row muted">No upcoming games scheduled right now.</div>`}
        ${upcoming.length > 5 ? `<div class="more"><button class="btn link" data-full="${esc(key)}">${sc.full[key] ? "Show fewer" : `Show all ${upcoming.length} upcoming games`}</button></div>` : ""}
      </section>`;
    }).join("") + `<p class="small muted center" style="padding:6px 0 14px">Ticket prices are from ESPN's ticket partner and change often. Golf, racing and UFC events are on the Games tab.</p>`;
    box.querySelectorAll("[data-full]").forEach(b => b.onclick = () => { sc.full[b.dataset.full] = !sc.full[b.dataset.full]; paintSched(); });
  }

  function paintStandings(box) {
    const sc = state.sched, s = state.sub;
    const favs = favSet();
    const mineIds = new Set((sc.mine || []).map(t => `${t.league}:${t.id}`));
    const isMine = (k, r) => mineIds.has(`${k}:${r.id}`) || [r.name, r.short, r.abbr, r.name.split(" ").pop()].some(n => n && favs.has(n.toLowerCase()));
    const leagues = s.leagues.filter(k => STAND_URLS[k]);
    const showAll = k => sc.showAll[k] || !s.favorite_teams.length;   // no favorites: show whole leagues
    if (!leagues.length) { box.innerHTML = `<div class="empty">Standings aren't available for your leagues.</div>`; return; }
    box.innerHTML = leagues.map(k => {
      const data = sc.standings[k];
      const head = `<div class="card-head"><span>${esc(LEAGUE[k].name)}</span>${data && data.groups.length && s.favorite_teams.length ? `<button class="btn link small" data-sall="${k}">${showAll(k) ? "Just my teams" : "Whole league"}</button>` : ""}</div>`;
      if (!data) return `<section class="card">${head}<div class="row muted">Loading…</div></section>`;
      if (data.failed || !data.groups.length) return `<section class="card">${head}<div class="row muted">No standings right now (it may be the off-season).</div></section>`;
      const race = LEAGUE[k].kind === "race";
      let groups = data.groups;
      if (!showAll(k)) {
        const withMine = groups.filter(g => g.rows.some(r => isMine(k, r)));
        groups = withMine.length ? withMine : race ? groups : [];
      }
      if (!groups.length) return `<section class="card">${head}<div class="row muted">None of your teams are in these standings. Tap <strong>Whole league</strong> to see them all.</div></section>`;
      const cols = STAND_COLS[k];
      return `<section class="card">${head}${groups.map(g => {
        let rows = g.rows;
        if (race && !showAll(k)) rows = rows.filter((r, i) => i < 10 || isMine(k, r));   // top 10 plus your drivers
        return `<div class="stand-group">${groups.length > 1 || !race ? `<div class="stand-name">${esc(g.name)}</div>` : ""}
          <table class="stand"><thead><tr><th class="tm">${race ? "Driver" : "Team"}</th>${cols.map(c => `<th>${c[0]}</th>`).join("")}</tr></thead>
          <tbody>${rows.map((r, i) => `<tr class="${isMine(k, r) ? "mine" : ""}">
            <td class="tm"><span class="rk">${race ? (r.rank || i + 1) : i + 1}</span>${r.logo && !race ? `<img class="logo" src="${esc(r.logo)}" alt="" loading="lazy">` : ""}${isMine(k, r) ? '<span class="star">★</span> ' : ""}${esc(race ? r.name : r.short)}</td>
            ${cols.map(c => `<td>${esc(c[1] === "rec" ? r.rec : ((r.st[c[1]] || {}).d ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      }).join("")}</section>`;
    }).join("");
    if (!s.favorite_teams.length) box.insertAdjacentHTML("afterbegin", addFavsBox("Pick your favorite teams to highlight them in the standings."));
    box.querySelectorAll("[data-sall]").forEach(b => b.onclick = () => { sc.showAll[b.dataset.sall] = !sc.showAll[b.dataset.sall]; paintSched(); });
  }

  // ------------------------------------------------------------- how to watch
  // Turns ESPN's channel names into plain guidance. Streaming deals change, so this is a guide, not gospel.
  const OUT_OF_MARKET = {
    nhl: "ESPN+ (NHL out-of-market games)", nba: "NBA League Pass", mlb: "MLB.TV",
    nfl: "NFL Sunday Ticket (YouTube TV)", wnba: "WNBA League Pass",
  };
  const NETWORKS = [
    [/^espn\+$/, "ESPN app with an ESPN+ or ESPN Unlimited plan"],
    [/^(espn|espn2|espnu|espnews|abc|sec network|secn|acc network|accn|longhorn network)$/, "On TV, or the ESPN app (TV provider login or ESPN Unlimited)"],
    [/^(fox|fs1|fs2|btn|big ten network)$/, "On TV, or stream on FOX One"],
    [/^cbs$/, "On TV (free with an antenna), or stream on Paramount+"],
    [/^(cbssn|cbs sports network)$/, "On cable or a live-TV streaming service"],
    [/^nbc$/, "On TV (free with an antenna), or stream on Peacock"],
    [/^peacock$/, "Stream on Peacock"],
    [/^(prime video|amazon prime video|amazon)$/, "Stream on Prime Video (with Amazon Prime)"],
    [/^netflix$/, "Stream on Netflix"],
    [/^(tnt|tbs|trutv)$/, "On TV, or stream on HBO Max"],
    [/^(apple tv|apple tv\+|mls season pass)$/, "Stream on Apple TV"],
    [/^(nfl network|nfln)$/, "On TV, or stream on NFL+"],
    [/^nba tv$/, "On TV, or NBA League Pass"],
    [/^(nhl network)$/, "On TV (cable or live-TV streaming)"],
    [/^(mlb network|mlbn)$/, "On TV, or MLB.TV"],
    [/^youtube$/, "Free on YouTube"],
    [/^(espn\+ ppv|ppv|pay-per-view)$/, "Pay-per-view in the ESPN app"],
    [/^(golf chnl|golf channel|gc)$/, "On cable, or stream on Peacock"],
    [/^(hbo max|max)$/, "Stream on HBO Max"],
    [/^(usa|usa network)$/, "On cable or a live-TV streaming service"],
    [/^(cw|the cw)$/, "On TV (free with an antenna), or the CW app"],
    [/^(f1 tv|f1tv)$/, "Stream on F1 TV"],
  ];
  function watchInfo(g) {
    const names = (g.tv || "").split(",").map(x => x.trim()).filter(Boolean);
    if (!names.length) return [["Not announced yet", "Channels are usually posted a few days before the game."]];
    return names.map(n => {
      const k = n.toLowerCase();
      for (const [re, how] of NETWORKS) if (re.test(k)) return [n, how];
      if (/ppv/i.test(n)) return [n, "Pay-per-view in the ESPN app"];
      // Anything else is usually a regional or local channel.
      const out = OUT_OF_MARKET[g.league];
      return [n, `Regional channel: near the team it's on cable or streaming TV that carries ${n}, or its own app.` +
                 (out ? ` Out of market? Try ${out}. Local games may be blacked out there.` : " Check the team's website for other options.")];
    });
  }
  // 📺 Where to watch: its own box, with the channel in view before you open it.
  function watchBox(g) {
    if (g.state === "post" || g.postponed) return "";
    return `<details class="panel watch"><summary><span class="ph">📺 Where to watch</span><span class="pv">${esc(g.tv || "TBA")}</span></summary><ul>${
      watchInfo(g).map(([n, how]) => `<li><strong>${esc(n)}</strong> · ${esc(how)}</li>`).join("")
    }</ul><div class="small muted">Streaming deals change, so double-check with the service.</div></details>`;
  }

  // 📈 Betting lines: separate box, summary up front, full spread / total / moneyline inside.
  function linesBox(g) {
    const L = g.lines;
    if (!L) return "";
    const sp = side => side.line ? `${side.line}${side.odds ? ` <span class="muted">(${esc(side.odds)})</span>` : ""}` : "–";
    const summary = [L.details, L.total && `O/U ${L.total}`].filter(Boolean).join(" · ");
    return `<details class="panel lines"><summary><span class="ph">📈 Betting lines</span><span class="pv">${esc(summary || "See lines")}</span></summary>
      <table class="odds"><thead><tr><th></th><th>Spread</th><th>Total</th><th>Money</th></tr></thead><tbody>
        <tr><td class="tm">${esc(g.away.abbr || g.away.name)}</td><td>${sp(L.spread.away)}</td><td>${L.total ? `o${esc(L.total)}${L.over ? ` <span class="muted">(${esc(L.over)})</span>` : ""}` : "–"}</td><td>${esc(L.ml.away || "–")}</td></tr>
        <tr><td class="tm">${esc(g.home.abbr || g.home.name)}</td><td>${sp(L.spread.home)}</td><td>${L.total ? `u${esc(L.total)}${L.under ? ` <span class="muted">(${esc(L.under)})</span>` : ""}` : "–"}</td><td>${esc(L.ml.home || "–")}</td></tr>
      </tbody></table>
      <div class="small muted">${L.provider ? `Lines from ${esc(L.provider)} via ESPN. ` : ""}For info only, and they move. Must be 21+ where legal.</div></details>`;
  }

  // 🎬 Highlights and recap for finished games (open by default for your teams).
  function highlightsBox(g, fav) {
    const h = g.highlights;
    if (!h || (!h.vids.length && !h.recap)) return "";
    const mins = s => s ? ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "";
    return `<details class="panel hl" ${fav ? "open" : ""}><summary><span class="ph">🎬 Highlights${h.recap ? " & recap" : ""}</span><span class="pv">${h.vids.length ? `${h.vids.length} video${h.vids.length > 1 ? "s" : ""}` : "Recap"}</span></summary>
      ${h.recap ? `<a class="recap" href="${esc(g.link || "#")}" target="_blank" rel="noopener">📰 ${esc(h.recap)}</a>` : ""}
      ${h.vids.map(v => `<a class="vid" href="${esc(v.url)}" target="_blank" rel="noopener">
        ${v.thumb ? `<span class="thumb"><img src="${esc(v.thumb)}" alt="" loading="lazy"><span class="play">▶</span></span>` : `<span class="thumb play-only">▶</span>`}
        <span class="vt">${esc(v.title)}<span class="small muted">${mins(v.secs)} · ESPN</span></span></a>`).join("")}
    </details>`;
  }

  function actions(g, fav, s) {
    const t = ticketLink(g, fav, s);
    const c = calendarLink(g, fav, s);
    const chat = chatReady() && (state.chat.groups || []).length ? g : null;
    const w = watchBox(g);
    if (!t && !c && !chat && !w) return "";
    return `<div class="actions">
      ${t ? `<a class="pill ticket" href="${esc(t.url)}" target="_blank" rel="noopener">🎟 ${esc(t.label)}</a>` : ""}
      ${c ? `<a class="pill cal" href="${esc(c)}" target="_blank" rel="noopener">+ Calendar</a>` : ""}
      ${chat ? `<button type="button" class="pill chatpill" data-discuss="${esc(g.key)}">💬 Discuss</button>` : ""}
    </div>${w}`;
  }

  function teamLine(t, showScore, win) {
    const label = (t.rank ? `#${t.rank} ` : "") + t.name;
    return `<div class="teamline ${win ? "win" : ""}">
      ${t.logo ? `<img class="logo" src="${esc(t.logo)}" alt="" loading="lazy">` : ""}
      <span class="nm">${esc(label)} ${t.record ? `<span class="rec">${esc(t.record)}</span>` : ""}</span>
      ${showScore ? `<span class="sc">${esc(t.score ?? "")}</span>` : ""}
    </div>`;
  }

  function gameRow(g, fav, s) {
    const live = g.state === "in", done = g.state === "post";
    const showScore = live || done;
    const aWin = done && (g.away.winner || (!g.home.winner && +g.away.score > +g.home.score));
    const hWin = done && !aWin;
    let status;
    if (g.postponed) status = `<div class="status">${esc(g.detail)}</div>`;
    else if (live) status = `<div class="status live">● Live · ${esc(g.detail)}</div>`;
    else if (done) status = `<div class="status">${esc(g.detail || "Final")}</div>`;
    else status = `<div class="status" style="text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink);font-weight:600">${g.tbd ? "Time TBD" : esc(timeIn(g.start, s.timezone))}</div>`;
    return `<div class="row ${fav ? "fav" : ""}">
      ${fav ? '<div class="small star" aria-label="Your team">★ Your team</div>' : ""}
      ${teamLine(g.away, showScore, aWin)}
      ${teamLine(g.home, showScore, hWin)}
      ${status}
      ${done ? highlightsBox(g, fav) : ""}
      ${actions(g, fav, s)}
      ${!done && !g.postponed ? linesBox(g) : ""}
    </div>`;
  }

  function cardRow(g, fav, s) {
    const when = g.state === "pre" ? esc(timeIn(g.start, s.timezone)) : g.state === "in" ? '<span class="status live">● Live</span>' : "Final";
    const bouts = g.bouts.slice(0, 5).map((b, i) => {
      const tag = i === 0 ? '<span class="tag">Main event</span>' : "";
      const div = b.division ? ` <span class="rec">· ${esc(b.division)}</span>` : "";
      if (b.state === "post" && (b.a.winner || b.b.winner)) {
        const [w, l] = b.a.winner ? [b.a, b.b] : [b.b, b.a];
        return `<div class="bout">${tag}<strong>${esc(w.name)}</strong> def. ${esc(l.name)}${b.result ? ` <span class="rec">(${esc(b.result)})</span>` : ""}${div}</div>`;
      }
      const rec = f => f.record ? ` <span class="rec">${esc(f.record)}</span>` : "";
      return `<div class="bout">${tag}${esc(b.a.name)}${rec(b.a)} <span class="muted">vs</span> ${esc(b.b.name)}${rec(b.b)}${div}</div>`;
    }).join("");
    return `<div class="row ${fav ? "fav" : ""}">
      <div class="matchup"><strong>${fav ? '<span class="star">★</span> ' : ""}${esc(g.card)}</strong><span class="when">${when}</span></div>
      ${[g.tv, g.venue].filter(Boolean).length ? `<div class="meta">${esc([g.tv, g.venue].filter(Boolean).join(" · "))}</div>` : ""}
      <div style="margin-top:6px">${bouts}</div>
      ${actions(g, fav, s)}
    </div>`;
  }

  // Golf leaderboard / race results card.
  function eventRow(g, fav, s) {
    const favs = new Set(s.favorite_teams.map(t => t.toLowerCase()));
    const mine = p => [p.name, p.short, p.name.split(" ").pop()].some(n => favs.has(n.toLowerCase()));
    const line = (pos, p, extra) => `<div class="bout ${mine(p) ? "mine" : ""}"><span class="pos">${esc(pos)}</span>${mine(p) ? '<span class="star">★</span> ' : ""}${esc(p.name)}${extra ? ` <span class="rec">${esc(extra)}</span>` : ""}</div>`;
    const top = (list, n, fmt) => {
      const shown = list.slice(0, n);
      const extraFavs = list.slice(n).filter(mine);     // your golfers/drivers further down
      return shown.map(fmt).join("") + (extraFavs.length ? `<div class="bout muted small">…</div>` + extraFavs.map(fmt).join("") : "");
    };
    let body = "", when;
    if (g.kind === "golf") {
      when = g.state === "in" ? `<span class="status live">● ${esc(g.detail || "Live")}</span>` : g.state === "post" ? "Final" : esc(new Intl.DateTimeFormat("en-US", { timeZone: s.timezone, weekday: "short", month: "short", day: "numeric" }).format(g.start));
      body = g.players.length && g.state !== "pre" ? top(g.players, 5, p => line(p.pos, p, p.score === "0" ? "E" : p.score)) : `<div class="bout muted">${g.players.length} players in the field</div>`;
    } else {
      const next = g.sessions.find(x => x.state !== "post");
      const live = g.sessions.find(x => x.state === "in");
      when = live ? `<span class="status live">● ${esc(live.name)}</span>` : g.state === "post" ? "Final"
        : g.start ? esc((g.sessions.length > 1 ? "Race " : "") + new Intl.DateTimeFormat("en-US", { timeZone: s.timezone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(g.start)) : "";
      if (g.state === "post" && g.results.length) {
        body = top(g.results, 3, p => line(["🥇", "🥈", "🥉"][p.order - 1] || `P${p.order}`, p, ""));
      } else {
        const done = [...g.sessions].reverse().find(x => x.state !== "pre" && x.results.length);
        if (done) body += `<div class="bout muted small">${esc(done.name)}${done.state === "in" ? " (live)" : ""}:</div>` + top(done.results, 3, p => line(`P${p.order}`, p, ""));
        if (g.sessions.length > 1) body += `<div class="sessions">${g.sessions.filter(x => x.state !== "post").map(x =>
          `<span>${esc(x.name)} <span class="muted">${x.start ? esc(new Intl.DateTimeFormat("en-US", { timeZone: s.timezone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(x.start)) : ""}</span></span>`).join("")}</div>`;
        if (!body && next) body = `<div class="bout muted">${esc(g.detail)}</div>`;
      }
    }
    return `<div class="row ${fav ? "fav" : ""}">
      <div class="matchup"><strong>${fav ? '<span class="star">★</span> ' : ""}${esc(g.card)}</strong><span class="when">${when}</span></div>
      ${[g.tv, g.venue].filter(Boolean).length ? `<div class="meta">${esc([g.tv, g.venue].filter(Boolean).join(" · "))}</div>` : ""}
      <div style="margin-top:6px">${body}</div>
      ${actions(g, fav, s)}
    </div>`;
  }

  // ------------------------------------------------------------------- chat
  // Private groups with a General chat and a thread per game. Messages arrive live
  // (Supabase Realtime), with a quiet refresh every few seconds as a backup.
  const chatReady = () => state.chat.ok !== false && !!state.user;
  const nameOf = (uid) => (state.chat.members.find(m => m.user_id === uid) || {}).display_name || "Former member";
  const me = () => state.user && state.user.id;

  function chatTime(iso) {
    const d = new Date(iso), now = new Date();
    const opts = sameLocalDay(d, now) ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" };
    return new Intl.DateTimeFormat("en-US", opts).format(d);
  }
  const sameLocalDay = (a, b) => a.toDateString() === b.toDateString();

  // Highlight @mentions of people in the group.
  function chatText(body) {
    let html = esc(body);
    const names = state.chat.members.map(m => m.display_name).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const n of names) {
      const re = new RegExp("@" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w])", "gi");
      html = html.replace(re, m => `<span class="mention">${m}</span>`);
    }
    return html;
  }

  function threadLabel(key, title) {
    if (key === "general") return "General";
    return title || key;
  }

  async function loadGroups() {
    const { data, error } = await sb.from("group_members")
      .select("group_id, role, chat_notify, last_read_at, display_name, groups(id, name, invite_code, created_by)")
      .eq("user_id", me());
    if (error) {
      // Chat tables not created yet (chat-setup.sql not run): hide chat quietly.
      if (/does not exist|schema cache|PGRST20/i.test(error.message + (error.code || ""))) {
        state.chat.ok = false;
        const t = document.querySelector('.tabs button[data-tab="chat"]');
        if (t) t.remove();
        if (state.tab === "chat") { state.tab = "today"; renderApp(); }
      }
      state.chat.groups = [];
      return;
    }
    state.chat.ok = true;
    const groups = (data || []).filter(r => r.groups).map(r => ({ ...r.groups, my: r }));
    if (groups.length) {
      const { data: recent } = await sb.from("messages").select("group_id, user_id, body, deleted, thread_title, created_at")
        .in("group_id", groups.map(g => g.id)).order("created_at", { ascending: false }).limit(200);
      for (const g of groups) {
        const mine = (recent || []).filter(m => m.group_id === g.id);
        g.last = mine[0] || null;
        g.unread = mine.some(m => m.user_id !== me() && new Date(m.created_at) > new Date(g.my.last_read_at));
      }
      groups.sort((a, b) => new Date(b.last ? b.last.created_at : 0) - new Date(a.last ? a.last.created_at : 0));
    }
    state.chat.groups = groups;
    paintChatBadge();
  }

  function paintChatBadge() {
    const btn = document.querySelector('.tabs button[data-tab="chat"]');
    if (btn) btn.classList.toggle("unread", (state.chat.groups || []).some(g => g.unread));
  }

  function stopLive() {
    clearInterval(state.chat.poll); state.chat.poll = null;
    if (state.chat.channel) { try { sb.removeChannel(state.chat.channel); } catch (e) {} state.chat.channel = null; }
  }
  function startLive(groupId, onChange) {
    stopLive();
    try {
      state.chat.channel = sb.channel("group-" + groupId)
        .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `group_id=eq.${groupId}` }, () => onChange())
        .subscribe();
    } catch (e) { /* Realtime not available: polling below still works */ }
    state.chat.poll = setInterval(() => { if (document.visibilityState === "visible") onChange(); }, 8000);
  }

  // ---- Chat tab: list of groups
  async function renderChat() {
    const view = document.getElementById("view");
    if (state.chat.groupId) return renderGroup();
    stopLive();
    view.innerHTML = `<header class="top"><div><div class="kicker">Your groups</div><h1>Chat</h1></div></header>
      <div id="chatBody"><div class="empty">Loading…</div></div>`;
    await loadGroups();
    if (state.tab !== "chat" || state.chat.groupId) return;
    const body = document.getElementById("chatBody");
    if (!body) return;
    if (state.chat.ok === false) {
      body.innerHTML = `<div class="empty">Group chat isn't set up yet.<br><span class="small">Whoever runs Sports Digest needs to run <code>chat-setup.sql</code> in Supabase.</span></div>`;
      return;
    }
    const groups = state.chat.groups;
    body.innerHTML = `
      ${groups.length ? `<section class="card">${groups.map(g => `
        <button type="button" class="grouprow" data-group="${esc(g.id)}">
          <div class="gr-main"><div class="gr-name">${g.unread ? '<span class="dot" aria-label="New messages"></span>' : ""}${esc(g.name)}</div>
            <div class="gr-last">${g.last ? (g.last.deleted ? "<em>Message deleted</em>" : esc((g.last.thread_title ? g.last.thread_title + ": " : "") + g.last.body)) : "No messages yet"}</div></div>
          <div class="gr-time">${g.last ? esc(chatTime(g.last.created_at)) : ""}</div>
        </button>`).join("")}</section>`
        : `<div class="empty">Chat with friends about your games.<br>Make a group and share the invite link.</div>`}
      <form id="newGroup" class="card" style="padding:14px" novalidate>
        <label for="groupName" class="label">New group</label>
        <div style="display:flex;gap:8px"><input id="groupName" type="text" maxlength="40" placeholder="e.g. Brock's crew">
        <button class="btn primary" style="height:46px">Create</button></div>
        <p class="error hidden" id="groupErr"></p>
        <p class="hint">Got an invite link? Just open it on this phone.</p>
      </form>`;
    body.querySelectorAll("[data-group]").forEach(b => b.onclick = () => openGroup(b.dataset.group));
    document.getElementById("newGroup").onsubmit = async ev => {
      ev.preventDefault();
      const name = document.getElementById("groupName").value.trim();
      const err = document.getElementById("groupErr");
      if (!name) { err.textContent = "Give your group a name."; err.classList.remove("hidden"); return; }
      const { data, error } = await sb.from("groups").insert({ name, created_by: me() }).select().single();
      if (error) { err.textContent = error.message; err.classList.remove("hidden"); return; }
      await loadGroups();
      state.chat.showSettings = true;     // show the invite link right away
      openGroup(data.id);
    };
  }

  function openGroup(id, thread = null, title = "") {
    if (thread) state.chat.showSettings = false;
    state.chat.groupId = id;
    state.chat.thread = thread;
    state.chat.threadTitle = title;
    if (state.tab !== "chat") { state.tab = "chat"; store.set("tab", "chat"); renderApp(); }
    else renderGroup();
    window.scrollTo(0, 0);
  }

  async function loadMembers(groupId) {
    const { data } = await sb.from("group_members").select("user_id, display_name, role, chat_notify").eq("group_id", groupId).order("joined_at");
    state.chat.members = data || [];
  }

  async function markRead(groupId) {
    await sb.from("group_members").update({ last_read_at: new Date().toISOString() }).eq("group_id", groupId).eq("user_id", me());
    const g = (state.chat.groups || []).find(x => x.id === groupId);
    if (g) { g.unread = false; g.my.last_read_at = new Date().toISOString(); }
    paintChatBadge();
  }

  // ---- One group: its threads (or one thread)
  async function renderGroup() {
    const view = document.getElementById("view");
    const id = state.chat.groupId;
    await loadGroups();                     // always re-check: you may have been removed
    if (state.chat.groupId !== id) return;  // moved on while loading
    const g = (state.chat.groups || []).find(x => x.id === id);
    if (!g) { state.chat.groupId = null; toast("You're not in that group anymore."); return renderChat(); }
    if (state.chat.thread) return renderThread(g);
    view.innerHTML = `
      <header class="top"><div><button class="btn link back" id="back">‹ Chat</button><h1>${esc(g.name)}</h1></div>
        <button class="icon-btn" id="gset" aria-label="Group settings">⋯</button></header>
      <div id="gsettings"></div>
      <div id="threads"><div class="empty">Loading…</div></div>
      <p class="hint">Start a game thread with 💬 Discuss on any game in the Games tab.</p>`;
    document.getElementById("back").onclick = () => { state.chat.groupId = null; renderChat(); };
    document.getElementById("gset").onclick = () => { state.chat.showSettings = !state.chat.showSettings; paintSettings(g); };
    await loadMembers(id);
    paintSettings(g);
    const paintThreads = async () => {
      const { data } = await sb.from("messages").select("thread, thread_title, body, deleted, user_id, created_at")
        .eq("group_id", id).order("created_at", { ascending: false }).limit(300);
      const box = document.getElementById("threads");
      if (!box || state.chat.groupId !== id || state.chat.thread) return;
      const byThread = new Map([["general", null]]);
      for (const m of data || []) if (!byThread.get(m.thread)) byThread.set(m.thread, m);
      const unreadSince = new Date(g.my.last_read_at);
      box.innerHTML = `<section class="card">${[...byThread.entries()].map(([t, m]) => `
        <button type="button" class="grouprow" data-thread="${esc(t)}" data-title="${esc(m ? m.thread_title : "")}">
          <div class="gr-main"><div class="gr-name">${m && m.user_id !== me() && new Date(m.created_at) > unreadSince ? '<span class="dot"></span>' : ""}${t === "general" ? "💬 General" : "🏟 " + esc(threadLabel(t, m && m.thread_title))}</div>
            <div class="gr-last">${m ? (m.deleted ? "<em>Message deleted</em>" : esc(nameOf(m.user_id) + ": " + m.body)) : "Say hi to the group"}</div></div>
          <div class="gr-time">${m ? esc(chatTime(m.created_at)) : ""}</div>
        </button>`).join("")}</section>`;
      box.querySelectorAll("[data-thread]").forEach(b => b.onclick = () => openGroup(id, b.dataset.thread, b.dataset.title));
    };
    await paintThreads();
    startLive(id, paintThreads);
  }

  function paintSettings(g) {
    const box = document.getElementById("gsettings");
    if (!box) return;
    if (!state.chat.showSettings) { box.innerHTML = ""; return; }
    const owner = g.my.role === "owner";
    const link = location.origin + location.pathname + "#join=" + g.invite_code;
    const notifyNote = PUSH_ON ? "" : `<p class="hint" style="margin:0 0 8px">Phone alerts start working once notifications are set up for Sports Digest.</p>`;
    box.innerHTML = `<section class="card" style="padding:14px">
      <div class="label">Invite friends</div>
      <div class="invite"><input type="text" readonly value="${esc(link)}" id="inviteLink" aria-label="Invite link">
        <button class="btn" id="shareLink" style="height:46px">${navigator.share ? "Share" : "Copy"}</button></div>
      <div class="small muted" style="margin:4px 0 12px">Anyone with this link can join (up to 50 people).
        ${owner ? `<button class="btn link small" id="newLink" style="padding:0">Make a new link</button>` : ""}</div>
      <div class="switch-row" style="padding:10px 0"><div class="txt"><div>Phone alerts for this group</div></div>
        <select id="chatNotify" aria-label="Phone alerts for this group">
          ${[["all", "Every message"], ["mentions", "When I'm @mentioned"], ["off", "Off"]].map(([k, l]) => `<option value="${k}" ${g.my.chat_notify === k ? "selected" : ""}>${l}</option>`).join("")}
        </select></div>${notifyNote}
      <div class="switch-row" style="padding:10px 0"><div class="txt"><div>My name here</div></div>
        <input type="text" id="myName" maxlength="40" value="${esc(g.my.display_name)}" style="width:150px;height:38px" aria-label="My name in this group"></div>
      <div class="label" style="margin-top:12px">People (${state.chat.members.length})</div>
      <div class="members">${state.chat.members.map(m => `<div class="member"><span>${esc(m.display_name)}${m.role === "owner" ? ' <span class="small muted">· owner</span>' : ""}${m.user_id === me() ? ' <span class="small muted">· you</span>' : ""}</span>
        ${owner && m.user_id !== me() ? `<button class="btn link small" data-remove="${esc(m.user_id)}" style="padding:0">Remove</button>` : ""}</div>`).join("")}</div>
      <div style="margin-top:12px">${owner
        ? `<button class="btn danger" id="deleteGroup">Delete group</button>`
        : `<button class="btn danger" id="leaveGroup">Leave group</button>`}</div>
    </section>`;
    const share = document.getElementById("shareLink");
    share.onclick = async () => {
      if (navigator.share) { try { await navigator.share({ title: `Join ${g.name} on Sports Digest`, url: link }); return; } catch (e) { return; } }
      try { await navigator.clipboard.writeText(link); toast("Invite link copied."); }
      catch (e) { document.getElementById("inviteLink").select(); toast("Select the link and copy it."); }
    };
    const nl = document.getElementById("newLink");
    if (nl) nl.onclick = async () => {
      if (!confirm("Make a new invite link? The old one will stop working.")) return;
      const { data, error } = await sb.rpc("new_invite_code", { g: g.id });
      if (error) return toast(error.message);
      g.invite_code = data; paintSettings(g); toast("New invite link ready.");
    };
    document.getElementById("chatNotify").onchange = async e => {
      const v = e.target.value;
      const { error } = await sb.from("group_members").update({ chat_notify: v }).eq("group_id", g.id).eq("user_id", me());
      if (error) return toast(error.message);
      g.my.chat_notify = v;
      toast(v === "off" ? "No phone alerts from this group." : v === "all" ? "You'll get every message." : "You'll get alerts when someone @mentions you.");
    };
    document.getElementById("myName").onchange = async e => {
      const v = e.target.value.trim().slice(0, 40);
      if (!v) { e.target.value = g.my.display_name; return; }
      const { error } = await sb.from("group_members").update({ display_name: v }).eq("group_id", g.id).eq("user_id", me());
      if (error) return toast(error.message);
      g.my.display_name = v; await loadMembers(g.id); paintSettings(g); toast("Name updated.");
    };
    box.querySelectorAll("[data-remove]").forEach(b => b.onclick = async () => {
      const who = nameOf(b.dataset.remove);
      if (!confirm(`Remove ${who} from ${g.name}?`)) return;
      const { error } = await sb.from("group_members").delete().eq("group_id", g.id).eq("user_id", b.dataset.remove);
      if (error) return toast(error.message);
      await loadMembers(g.id); paintSettings(g); toast(`${who} was removed.`);
    });
    const del = document.getElementById("deleteGroup");
    if (del) del.onclick = async () => {
      if (!confirm(`Delete ${g.name} and all its messages for everyone?`)) return;
      const { error } = await sb.from("groups").delete().eq("id", g.id);
      if (error) return toast(error.message);
      stopLive(); state.chat.groupId = null; state.chat.showSettings = false; toast("Group deleted."); renderChat();
    };
    const leave = document.getElementById("leaveGroup");
    if (leave) leave.onclick = async () => {
      if (!confirm(`Leave ${g.name}?`)) return;
      const { error } = await sb.from("group_members").delete().eq("group_id", g.id).eq("user_id", me());
      if (error) return toast(error.message);
      stopLive(); state.chat.groupId = null; state.chat.showSettings = false; toast(`You left ${g.name}.`); renderChat();
    };
  }

  // ---- One thread: the conversation
  async function renderThread(g) {
    const view = document.getElementById("view");
    const id = g.id, thread = state.chat.thread;
    const game = findGame(thread);
    view.innerHTML = `
      <header class="top"><div><button class="btn link back" id="back">‹ ${esc(g.name)}</button>
        <h1 style="font-size:22px">${thread === "general" ? "General" : esc(threadLabel(thread, state.chat.threadTitle))}</h1></div></header>
      ${game ? `<div class="card scoreline" id="scoreline">${scoreLine(game)}</div>` : ""}
      <div id="msgs" class="msgs" aria-live="polite"><div class="empty">Loading…</div></div>
      <form id="composer" class="composer" novalidate>
        <div id="mentionPick" class="mentionpick hidden"></div>
        <div class="composer-row">
          <textarea id="msg" rows="1" maxlength="1000" placeholder="Message ${esc(g.name)}" aria-label="Message"></textarea>
          <button class="btn primary" id="sendMsg" aria-label="Send">Send</button>
        </div>
      </form>`;
    document.getElementById("back").onclick = () => { state.chat.thread = null; renderGroup(); };
    let lastIds = "";
    const paint = async (scroll) => {
      const { data, error } = await sb.from("messages").select("id, user_id, body, deleted, created_at")
        .eq("group_id", id).eq("thread", thread).order("created_at", { ascending: false }).limit(200);
      const box = document.getElementById("msgs");
      if (!box || state.chat.thread !== thread || state.chat.groupId !== id) return;
      if (error) { box.innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
      const list = (data || []).reverse();
      const sig = list.map(m => m.id + (m.deleted ? "d" : "")).join(",");
      if (sig === lastIds) return;           // nothing new: don't redraw (keeps your scroll spot)
      const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
      lastIds = sig;
      const owner = g.my.role === "owner";
      box.innerHTML = list.length ? list.map(m => {
        const mine = m.user_id === me();
        const canDelete = !m.deleted && (mine || owner);
        return `<div class="msg ${mine ? "mine" : ""}">
          ${mine ? "" : `<div class="who">${esc(nameOf(m.user_id))}</div>`}
          <div class="bubble ${m.deleted ? "deleted" : ""}" ${canDelete ? `data-del="${m.id}" role="button" tabindex="0" title="Tap to delete"` : ""}>${m.deleted ? "Message deleted" : chatText(m.body)}</div>
          <div class="when">${esc(chatTime(m.created_at))}</div></div>`;
      }).join("") : `<div class="empty">No messages yet. Start the conversation!</div>`;
      box.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
        if (!confirm("Delete this message?")) return;
        const { error } = await sb.from("messages").update({ deleted: true }).eq("id", +b.dataset.del);
        if (error) return toast(error.message);
        paint(false);
      });
      if (scroll || nearBottom) window.scrollTo(0, document.body.scrollHeight);
      markRead(id);
    };

    const input = document.getElementById("msg");
    const picker = document.getElementById("mentionPick");
    input.oninput = () => {
      input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px";
      const m = input.value.slice(0, input.selectionStart).match(/@([\w .'-]{0,20})$/);
      const options = m ? state.chat.members.filter(x => x.user_id !== me() && x.display_name.toLowerCase().startsWith(m[1].toLowerCase())) : [];
      picker.classList.toggle("hidden", !options.length);
      picker.innerHTML = options.map(x => `<button type="button" data-mention="${esc(x.display_name)}">@${esc(x.display_name)}</button>`).join("");
      picker.querySelectorAll("[data-mention]").forEach(b => b.onclick = () => {
        const before = input.value.slice(0, input.selectionStart).replace(/@[\w .'-]{0,20}$/, "@" + b.dataset.mention + " ");
        input.value = before + input.value.slice(input.selectionStart);
        picker.classList.add("hidden"); input.focus();
      });
    };
    input.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !/iphone|ipad|android/i.test(navigator.userAgent)) { e.preventDefault(); document.getElementById("composer").requestSubmit(); } };
    document.getElementById("composer").onsubmit = async ev => {
      ev.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      const btn = document.getElementById("sendMsg");
      btn.disabled = true;
      const { error } = await sb.from("messages").insert({ group_id: id, thread, thread_title: thread === "general" ? "" : (state.chat.threadTitle || "").slice(0, 80), body: body.slice(0, 1000) });
      btn.disabled = false;
      if (error) return toast(/Slow down/.test(error.message) ? "Slow down! Too many messages in a minute." : "Couldn't send: " + error.message);
      input.value = ""; input.style.height = "auto"; picker.classList.add("hidden");
      await paint(true);
    };
    // Typing works right away; members and messages load next.
    await loadMembers(id);
    await paint(true);
    startLive(id, async () => { await paint(false); const sl = document.getElementById("scoreline"); const gm = findGame(thread); if (sl && gm) sl.innerHTML = scoreLine(gm); });
  }

  function findGame(key) {
    if (!key || key === "general") return null;
    for (const d of Object.values(state.days)) for (const r of d.leagues) for (const g of r.games) if (g.key === key) return g;
    return null;
  }
  function scoreLine(g) {
    if (isEvent(g)) return `<strong>${esc(g.card)}</strong> · ${g.state === "in" ? '<span class="live">● Live</span>' : g.state === "post" ? "Final" : esc(timeIn(g.start, state.sub.timezone))}`;
    const st = g.state === "in" ? `<span class="live">● ${esc(g.detail)}</span>` : g.state === "post" ? esc(g.detail || "Final") : esc(g.tbd ? "Time TBD" : timeIn(g.start, state.sub.timezone));
    const sc = g.state === "pre" ? "" : ` ${esc(g.away.score)}–${esc(g.home.score)}`;
    return `<strong>${esc(g.away.name)} @ ${esc(g.home.name)}</strong>${sc} · ${st}`;
  }
  function gameTitle(g) {
    const day = new Intl.DateTimeFormat("en-US", { timeZone: state.sub.timezone, weekday: "short", month: "short", day: "numeric" }).format(g.start || new Date());
    return (isEvent(g) ? g.card : `${g.away.name} @ ${g.home.name}`).slice(0, 60) + " · " + day;
  }

  // 💬 Discuss on a game: open (or start) that game's thread in one of your groups.
  async function discuss(key) {
    const g = findGame(key);
    if (!g) return;
    if (!state.chat.groups) await loadGroups();
    const groups = state.chat.groups || [];
    if (groups.length === 1) return openGroup(groups[0].id, key, gameTitle(g));
    const pick = document.createElement("div");
    pick.className = "sheet";
    pick.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Choose a group"><div class="label">Discuss ${esc(isEvent(g) ? g.card : g.away.name + " @ " + g.home.name)} in…</div>
      ${groups.map(x => `<button type="button" class="btn block" data-g="${esc(x.id)}" style="margin-top:8px">${esc(x.name)}</button>`).join("")}
      <button type="button" class="btn link block" id="cancelPick">Cancel</button></div>`;
    document.body.appendChild(pick);
    pick.onclick = e => { if (e.target === pick || e.target.id === "cancelPick") pick.remove(); };
    pick.querySelectorAll("[data-g]").forEach(b => b.onclick = () => { pick.remove(); openGroup(b.dataset.g, key, gameTitle(g)); });
  }

  // Invite links: .../#join=CODE
  async function handleJoin(code) {
    store.set("pendingJoin", null);
    const name = (state.sub && state.sub.name) || "";
    const view = document.getElementById("view");
    state.tab = "chat";
    $app.querySelectorAll(".tabs button").forEach(b => b.dataset.tab === "chat" ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
    view.innerHTML = `<header class="top"><div><div class="kicker">Group invite</div><h1>Join the group?</h1></div></header>
      <form id="joinForm" class="card" style="padding:14px" novalidate>
        <label for="joinName" class="label">Your name in the group</label>
        <input id="joinName" type="text" maxlength="40" value="${esc(name)}" placeholder="First name">
        <p class="error hidden" id="joinErr"></p>
        <button class="btn primary block" style="margin-top:12px">Join group</button>
        <button type="button" class="btn link block" id="noJoin">No thanks</button>
      </form>`;
    document.getElementById("noJoin").onclick = () => { renderApp(); };
    document.getElementById("joinForm").onsubmit = async ev => {
      ev.preventDefault();
      const nm = document.getElementById("joinName").value.trim();
      const err = document.getElementById("joinErr");
      if (!nm) { err.textContent = "Enter a name so friends know who you are."; err.classList.remove("hidden"); return; }
      const { data, error } = await sb.rpc("join_group", { code, name: nm });
      if (error) { err.textContent = error.message; err.classList.remove("hidden"); return; }
      await loadGroups();
      const g = state.chat.groups.find(x => x.id === data);
      toast(g ? `You joined ${g.name}!` : "You're in!");
      openGroup(data);
    };
  }

  // ---------------------------------------------------------------- my teams
  // Team lists come through our Supabase "teams" function (ESPN doesn't let web pages load them directly).
  async function loadTeams(keys) {
    await Promise.all(keys.filter(k => !state.teams[k] && LEAGUE[k]).map(k => {
      state.teamLoads = state.teamLoads || {};
      if (state.teamLoads[k]) return state.teamLoads[k];        // already loading: wait for that one
      return (state.teamLoads[k] = (async () => {
        const cacheKey = "teams4:" + k;
        const cached = store.get(cacheKey);
        if (cached && cached.list && cached.list.length && Date.now() - cached.at < (isPeople(k) ? 864e5 : 7 * 864e5)) { state.teams[k] = cached.list; state.confs[k] = cached.confs || []; return; }
        let confs = [];
        let list = [];
        try {
          const data = await getJSON(`${CFG.SUPABASE_URL.replace(/\/$/, "")}/functions/v1/teams?league=${encodeURIComponent(k)}`);
          const tidy = c => String(c || "").replace(/^FCS · FCS /, "FCS ");
          list = (data.teams || []).map(t => ({ id: String(t.id || ""), name: t.name, abbr: t.abbr || "", nick: t.nick || "", short: t.short || "", league: k, logo: t.logo || "", conf: tidy(t.conf) }));
          confs = (data.conferences || []).map(tidy);
        } catch { /* try ESPN directly below */ }
        if (!list.length && !isPeople(k)) {
          try {
            const lg = LEAGUE[k];
            const data = await getJSON(`${ESPN}/${lg.path}/teams?` + qs(lg.teamParams || { limit: "100" }));
            list = ((((data.sports || [])[0] || {}).leagues || [{}])[0].teams || []).map(x => x.team || x).filter(t => t.displayName)
              .map(t => ({ id: String(t.id || ""), name: t.displayName, abbr: t.abbreviation || "", nick: t.name || "", league: k, logo: (t.logos && t.logos[0] && t.logos[0].href) || "" }));
          } catch { /* shown as "couldn't load" */ }
        }
        if (list.length) { state.teams[k] = list; state.confs[k] = confs; store.set(cacheKey, { at: Date.now(), list, confs }); }
        else state.teamsFailed = true;
      })().finally(() => { delete state.teamLoads[k]; }));
    }));
  }

  function renderTeams() {
    const d = state.draft;
    const first = !state.sub;
    const view = document.getElementById("view");
    view.innerHTML = `
      <header class="top"><div>
        <div class="kicker">${first ? "Welcome" : "Settings"}</div>
        <h1>${first ? "Pick your teams" : "My Teams"}</h1>
      </div></header>
      ${first ? `<p class="muted">Choose what you follow. Your first email arrives tomorrow morning, and you can change anything later.</p>` : ""}

      <div class="field">
        <label for="name">Your first name <span class="muted" style="font-weight:400">(for "Good morning, ___")</span></label>
        <input id="name" type="text" maxlength="60" autocomplete="given-name" value="${esc(d.name)}">
      </div>

      <div class="field">
        <span class="label">Leagues</span>
        <div class="leagues">${LEAGUES.map(l => `
          <label class="check"><input type="checkbox" data-league="${l.key}" ${d.leagues.includes(l.key) ? "checked" : ""}>${esc(l.name)}</label>`).join("")}
        </div>
        <p class="error hidden" id="leagueErr">Pick at least one league.</p>
      </div>

      <div class="field">
        <label for="pickLeague">Favorite teams</label>
        <div class="chips" id="chips"></div>
        <div class="search-wrap">
          <input id="teamSearch" type="search" placeholder="🔍 Search teams, e.g. Gophers" autocomplete="off" enterkeyhint="search">
          <div class="results hidden" id="results"></div>
        </div>
        <div class="or muted small">or browse</div>
        <div class="picker stack">
          <select id="pickLeague" aria-label="League"></select>
          <select id="pickConf" aria-label="Conference" class="hidden"></select>
          <select id="pickTeam" aria-label="Team"></select>
        </div>
        <div class="picker ${d.leagues.some(isPeople) ? "" : "hidden"}" id="fighterRow">
          <input id="fighter" type="text" maxlength="60" placeholder="${esc(peoplePlaceholder(d))}" autocomplete="off">
          <button type="button" class="btn" id="addFighter">Add</button>
        </div>
        <p class="hint" id="teamHint">Search, or pick a league (and its conference or division), then a team. For golf, racing and UFC you pick people. Favorites are starred, listed first, and get ticket links and calendar invites.</p>
      </div>

      <h2>Daily email</h2>
      <div class="card">
        <div class="switch-row"><div class="txt"><div>Send my daily email</div><span class="small muted">Arrives around 6:45 AM Arizona time. Turn off to just use the app.</span></div>
          <label class="switch"><input type="checkbox" id="active" ${d.active ? "checked" : ""} aria-label="Send my daily email"><span></span></label></div>
        <div class="switch-row"><div class="txt"><div>Time zone</div><span class="small muted">For game times</span></div>
          <select id="timezone" aria-label="Time zone">${tzOptions(d.timezone)}</select></div>
        <div class="switch-row"><div class="txt"><div>Ticket links</div></div>
          <select id="ticket_links" aria-label="Ticket links">${opts(d.ticket_links)}</select></div>
        <div class="switch-row"><div class="txt"><div>Add-to-calendar links</div></div>
          <select id="calendar_links" aria-label="Calendar links">${opts(d.calendar_links)}</select></div>
        <div class="switch-row"><div class="txt"><div>Attach calendar file</div><span class="small muted">Adds your teams' games in one tap</span></div>
          <label class="switch"><input type="checkbox" id="calendar_attachment" ${d.calendar_attachment ? "checked" : ""} aria-label="Attach calendar file"><span></span></label></div>
        <div class="switch-row"><div class="txt"><div>Calendar reminder</div><span class="small muted">Minutes before game time</span></div>
          <input type="number" id="reminder_minutes" min="0" max="1440" step="5" value="${esc(d.reminder_minutes)}" aria-label="Reminder minutes"></div>
        <div class="switch-row"><div class="txt"><div>Headlines per league</div><span class="small muted">0 turns headlines off</span></div>
          <input type="number" id="headlines_per_league" min="0" max="10" step="1" value="${esc(d.headlines_per_league)}" aria-label="Headlines per league"></div>
        <div class="switch-row"><div class="txt"><div>Only news about my teams</div></div>
          <label class="switch"><input type="checkbox" id="favorites_only_headlines" ${d.favorites_only_headlines ? "checked" : ""} aria-label="Only news about my teams"><span></span></label></div>
      </div>

      ${PUSH_ON ? notifySection(d) : ""}

      <div class="savebar"><button class="btn primary block" id="save">${first ? "Start my daily email" : "Save changes"}</button></div>

      <h2>Appearance</h2>
      <div class="theme-pick" role="group" aria-label="Appearance">
        ${[["system", "System", "linear-gradient(135deg,#fff 50%,#1b1b1f 50%)"], ["light", "Light", "#fff"], ["dark", "Dark", "#1b1b1f"]].map(([k, label, bg]) =>
          `<button type="button" data-theme-pick="${k}" aria-pressed="${(d.theme || "system") === k}"><span class="sw" style="background:${bg}"></span>${label}</button>`).join("")}
      </div>
      <p class="hint">System matches your phone's light or dark setting.</p>

      <h2>Account</h2>
      <p class="small muted">Signed in as ${esc(state.user.email)}</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" id="setpw">Set or change password</button>
        <button class="btn" id="signout">Sign out</button>
        ${first ? "" : `<button class="btn danger" id="remove">Delete my settings</button>`}
      </div>
      ${installHint()}`;

    // leagues
    view.querySelectorAll("[data-league]").forEach(cb => cb.onchange = () => {
      const k = cb.dataset.league;
      d.leagues = cb.checked ? [...new Set([...d.leagues, k])] : d.leagues.filter(x => x !== k);
      d.leagues = LEAGUES.map(l => l.key).filter(x => d.leagues.includes(x));
      document.getElementById("leagueErr").classList.add("hidden");
      document.getElementById("fighterRow").classList.toggle("hidden", !d.leagues.some(isPeople));
      document.getElementById("fighter").placeholder = peoplePlaceholder(d);
      paintPicker(cb.checked ? k : null);
    });
    // simple fields
    view.querySelector("#name").oninput = e => d.name = e.target.value;
    ["timezone", "ticket_links", "calendar_links"].forEach(id => view.querySelector("#" + id).onchange = e => d[id] = e.target.value);
    ["active", "calendar_attachment", "favorites_only_headlines"].forEach(id => view.querySelector("#" + id).onchange = e => d[id] = e.target.checked);
    ["reminder_minutes", "headlines_per_league"].forEach(id => view.querySelector("#" + id).oninput = e => d[id] = e.target.value);
    if (PUSH_ON) wireNotify(view, d);

    paintChips();
    paintPicker();
    view.querySelector("#pickLeague").onchange = e => { state.pickConf = ""; paintPicker(e.target.value); };
    view.querySelector("#pickConf").onchange = e => { state.pickConf = e.target.value; paintPicker(); };
    const search = view.querySelector("#teamSearch");
    search.oninput = () => paintResults(search.value);
    search.onfocus = () => loadTeams(d.leagues).then(() => paintResults(search.value));
    view.querySelector("#pickTeam").onchange = e => { if (e.target.value) addFavorite(e.target.value); };
    const fighter = view.querySelector("#fighter");
    view.querySelector("#addFighter").onclick = () => { addFavorite(fighter.value); fighter.value = ""; };
    fighter.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); addFavorite(fighter.value); fighter.value = ""; } };

    view.querySelector("#save").onclick = save;
    view.querySelectorAll("[data-theme-pick]").forEach(b => b.onclick = async () => {
      const t = b.dataset.themePick;
      d.theme = t; applyTheme(t);
      view.querySelectorAll("[data-theme-pick]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      // Saved right away (no need to tap Save) once the account has settings.
      if (state.sub) {
        const { error } = await sb.from("subscribers").update({ theme: t }).eq("id", state.user.id);
        if (!error) state.sub.theme = t;
      }
    });
    view.querySelector("#setpw").onclick = () => renderSetPassword(state.user);
    view.querySelector("#signout").onclick = async () => { await phoneOff(true); await sb.auth.signOut({ scope: "local" }); };   /* only this phone: the widget and other devices stay signed in */
    const rm = view.querySelector("#remove");
    if (rm) rm.onclick = removeMe;
  }

  const opts = v => [["favorites", "My teams only"], ["all", "All games"], ["none", "Off"]]
    .map(([k, label]) => `<option value="${k}" ${v === k ? "selected" : ""}>${label}</option>`).join("");
  function tzOptions(v) {
    const list = TIMEZONES.some(t => t[0] === v) ? TIMEZONES : [[v, v], ...TIMEZONES];
    return list.map(([k, label]) => `<option value="${esc(k)}" ${v === k ? "selected" : ""}>${esc(label)}</option>`).join("");
  }

  function paintChips() {
    const d = state.draft;
    const box = document.getElementById("chips");
    if (!box) return;
    box.innerHTML = d.favorite_teams.length
      ? d.favorite_teams.map((t, i) => `<span class="chip"><span class="star">★</span> ${esc(t)}<button aria-label="Remove ${esc(t)}" data-rm="${i}">×</button></span>`).join("")
      : `<span class="small muted">No favorites yet.</span>`;
    box.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => {
      d.favorite_teams.splice(+b.dataset.rm, 1); paintChips();
    });
  }

  // "Not listed? Add a golfer or driver" (lists only show this week's golf field and current drivers).
  function peoplePlaceholder(d) {
    const kinds = [...new Set(d.leagues.filter(isPeople).map(k => PEOPLE[LEAGUE[k].kind]))];
    return `Not listed? Type a ${kinds.join(" or ") || "name"}`;
  }

  function addFavorite(name) {
    const d = state.draft;
    name = name.trim().slice(0, 60);
    if (!name) return;
    if (d.favorite_teams.some(t => t.toLowerCase() === name.toLowerCase())) { toast(`${name} is already a favorite`); paintPicker(); return; }
    if (d.favorite_teams.length >= 60) { toast("That's the limit of 60 favorites"); return; }
    d.favorite_teams.push(name);
    paintChips();
    paintPicker();
    const s = document.getElementById("teamSearch");
    if (s && s.value) { s.value = ""; paintResults(""); }
    toast(`★ ${name} added`);
  }

  // League dropdown + team dropdown (teams load from ESPN for the chosen league).
  async function paintPicker(leagueKey) {
    const d = state.draft;
    const lgSel = document.getElementById("pickLeague"), teamSel = document.getElementById("pickTeam");
    if (!lgSel || !teamSel) return;
    const teamLeagues = d.leagues.filter(k => LEAGUE[k]);
    if (!teamLeagues.length) {
      lgSel.innerHTML = `<option>Pick a league above first</option>`; lgSel.disabled = true;
      teamSel.innerHTML = ""; teamSel.classList.add("hidden");
      return;
    }
    lgSel.disabled = false;
    const cur = leagueKey && teamLeagues.includes(leagueKey) ? leagueKey
      : teamLeagues.includes(lgSel.value) ? lgSel.value : teamLeagues[0];
    lgSel.innerHTML = teamLeagues.map(k => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(LEAGUE[k].name)}</option>`).join("");
    teamSel.classList.remove("hidden");
    if (!state.teams[cur]) {
      teamSel.disabled = true; teamSel.innerHTML = `<option>Loading teams…</option>`;
      await loadTeams([cur]);
      if (document.getElementById("pickLeague") !== lgSel || lgSel.value !== cur) return;   // screen or league changed meanwhile
    }
    const chosen = new Set(d.favorite_teams.map(t => t.toLowerCase()));
    const all = [...(state.teams[cur] || [])].sort((a, b) => a.name.localeCompare(b.name));
    // College: conference dropdown, and the team list grouped by conference.
    const confSel = document.getElementById("pickConf");
    const confs = state.confs[cur] || [];
    if (confSel) {
      confSel.classList.toggle("hidden", !confs.length);
      if (state.pickConf && !confs.includes(state.pickConf)) state.pickConf = "";
      const word = ["cfb", "cbb"].includes(cur) ? "conferences" : "divisions";
      confSel.innerHTML = `<option value="">All ${word}</option>` +
        confs.map(c => `<option value="${esc(c)}" ${c === state.pickConf ? "selected" : ""}>${esc(c)}</option>`).join("");
    }
    const list = confs.length && state.pickConf ? all.filter(t => t.conf === state.pickConf) : all;
    const opt = t => `<option value="${esc(t.name)}" ${chosen.has(t.name.toLowerCase()) ? "disabled" : ""}>${esc(t.name)}${chosen.has(t.name.toLowerCase()) ? " ★" : ""}</option>`;
    teamSel.disabled = !list.length;
    teamSel.innerHTML = !list.length ? (isPeople(cur)
        ? `<option>No list right now. Type a name in the box below.</option>`
        : `<option>Couldn't load teams. Close and reopen the app to try again.</option>`)
      : `<option value="">＋ Choose a ${isPeople(cur) ? PEOPLE[LEAGUE[cur].kind] : "team"}…</option>` + (confs.length && !state.pickConf
        ? confs.map(c => `<optgroup label="${esc(c)}">${list.filter(t => t.conf === c).map(opt).join("")}</optgroup>`).join("")
        : list.map(opt).join(""));
  }

  // Search box: matching teams from all your leagues, tap one to add it.
  function paintResults(q) {
    const box = document.getElementById("results");
    if (!box) return;
    q = q.trim().toLowerCase();
    if (q.length < 2) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    const d = state.draft;
    const chosen = new Set(d.favorite_teams.map(t => t.toLowerCase()));
    const pool = d.leagues.flatMap(k => state.teams[k] || []);
    const hay = t => [t.name, t.abbr, t.nick, t.short, t.conf].join(" ").toLowerCase();
    const hits = pool.filter(t => !chosen.has(t.name.toLowerCase()) && (hay(t).includes(q) || t.abbr.toLowerCase() === q))
      .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1) || a.name.localeCompare(b.name))
      .slice(0, 25);
    const loading = d.leagues.some(k => LEAGUE[k] && !state.teams[k]);
    box.innerHTML = hits.length
      ? hits.map((t, i) => `<button type="button" data-hit="${i}">
          ${t.logo ? `<img class="logo" src="${esc(t.logo)}" alt="" loading="lazy">` : ""}<span>${esc(t.name)}</span>
          <span class="lg">${esc(LEAGUE[t.league].name)}${t.conf ? " · " + esc(t.conf) : ""}</span></button>`).join("")
      : `<div class="small muted" style="padding:10px 12px">${loading ? "Loading teams…" : "No teams match. Check the spelling, or make sure that league is checked above."}</div>`;
    box.classList.remove("hidden");
    box.querySelectorAll("[data-hit]").forEach(b => b.onclick = () => addFavorite(hits[+b.dataset.hit].name));
  }

  function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  }

  async function save() {
    const d = state.draft;
    if (!d.leagues.length) {
      const e = document.getElementById("leagueErr");
      e.classList.remove("hidden"); e.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const row = { id: state.user.id, email: state.user.email };
    for (const f of FIELDS) row[f] = d[f];
    row.name = String(d.name || "").trim().slice(0, 60);
    row.reminder_minutes = clampInt(d.reminder_minutes, 0, 1440, 30);
    row.headlines_per_league = clampInt(d.headlines_per_league, 0, 10, 3);
    if (PUSH_ON) {
      row.notify_start_minutes = clampInt(d.notify_start_minutes, 5, 180, 30);
      row.notify_digest_hour = clampInt(d.notify_digest_hour, 0, 23, 7);
      row.notify_ticket_price = clampInt(d.notify_ticket_price, 1, 5000, 75);
    }
    const btn = document.getElementById("save");
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Saving…";
    const { data, error } = await sb.from("subscribers").upsert(row).select().single();
    btn.disabled = false; btn.textContent = label;
    if (error) { toast("Couldn't save: " + error.message); return; }
    const first = !state.sub;
    state.sub = data;
    state.draft = { ...DEFAULTS, ...data };
    state.days = {};
    state.news = null;
    state.newsMine = null;
    if (first) {
      state.tab = "today"; store.set("tab", "today");
      renderApp();
      loadGroups();
      const pj = store.get("pendingJoin");
      if (pj) { handleJoin(String(pj).toLowerCase()); return; }
      toast("You're in! Your first email arrives tomorrow morning.");
    } else {
      toast(data.active ? "Saved. Changes apply to tomorrow's email." : "Saved. Daily email is off; everything is still in the app.");
    }
  }

  async function removeMe() {
    if (!window.confirm("Delete your settings and stop the daily email? You can sign up again any time.")) return;
    const { error } = await sb.from("subscribers").delete().eq("id", state.user.id);
    if (error) { toast("Couldn't delete: " + error.message); return; }
    if (PUSH_ON) { await phoneOff(true); await sb.from("push_subscriptions").delete().eq("user_id", state.user.id); }
    await sb.auth.signOut();
    toast("Deleted. You won't get any more emails.");
  }


  // ----------------------------------------------------------- notifications
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  function notifySection(d) {
    const sw = (id, title, hint) => `<div class="switch-row"><div class="txt"><div>${title}</div>${hint ? `<span class="small muted">${hint}</span>` : ""}</div>
      <label class="switch"><input type="checkbox" id="${id}" ${d[id] ? "checked" : ""} aria-label="${title}"><span></span></label></div>`;
    const minutes = [10, 15, 30, 60, 120].map(m => `<option value="${m}" ${+d.notify_start_minutes === m ? "selected" : ""}>${m < 60 ? m + " min" : m / 60 + " hr"} before</option>`).join("");
    const hours = [5, 6, 7, 8, 9, 10].map(h => `<option value="${h}" ${+d.notify_digest_hour === h ? "selected" : ""}>${h}:00 AM</option>`).join("");
    return `
      <h2>Notifications</h2>
      <div class="card" style="padding:14px" id="phoneBox"><div class="small muted">Checking this phone…</div></div>
      <div class="card">
        ${sw("notify_start", "Game starting soon")}
        <div class="switch-row"><div class="txt"><div>How early</div></div>
          <select id="notify_start_minutes" aria-label="How early">${minutes}</select></div>
        ${sw("notify_scores", "Score updates", "Every score during your teams' games")}
        ${sw("notify_big_plays", "Big plays and close finishes", "Turnovers, 40+ yard plays, home runs, alley-oop dunks, short-handed goals, tight games late")}
        ${sw("notify_final", "Final scores")}
        ${sw("notify_digest", "Morning summary", "Last night's results and today's games")}
        <div class="switch-row"><div class="txt"><div>Summary time</div></div>
          <select id="notify_digest_hour" aria-label="Summary time">${hours}</select></div>
      </div>
      <h3 class="subhead">During games</h3>
      <div class="card">
        ${sw("notify_highlights", "🎬 Highlight clips", "ESPN's video of dunks, goals and big plays, as they're posted")}
        ${sw("notify_milestones", "🔥 Player milestones", "40-point games, triple-doubles, hat tricks, 300-yard passers, no-hitter watch")}
        ${sw("notify_drama", "🔄 Comebacks, overtime and upsets", "Your team rallies from way behind, a game goes to OT, a ranked team is in trouble late")}
        ${sw("notify_periods", "⏸️ Score at each break", "End of each quarter or period, and halftime")}
      </div>
      <h3 class="subhead">Team news</h3>
      <div class="card">
        ${sw("notify_news", "📰 Injuries and roster moves", "ESPN stories about your teams: injuries, trades, signings")}
        ${sw("notify_schedule", "🗓️ Schedule changes", "A game time moves, or a game is postponed")}
        ${sw("notify_standings", "📊 Standings", "Clinched a playoff spot, moved into 1st, new AP Top 25 rank")}
        ${sw("notify_tickets", "🎟️ Ticket price drop", "When cheap seats show up for your teams' games in the next 45 days")}
        <div class="switch-row"><div class="txt"><div>Alert me at or below</div><span class="small muted">Cheapest ticket price</span></div>
          <select id="notify_ticket_price" aria-label="Ticket price">${[25, 40, 50, 75, 100, 150, 200, 300].map(p => `<option value="${p}" ${+d.notify_ticket_price === p ? "selected" : ""}>$${p}</option>`).join("")}</select></div>
      </div>
      <h3 class="subhead">Golf, racing and UFC</h3>
      <div class="card">
        ${sw("notify_events", "⛳🏁🥊 Your golfers, drivers and fighters", "Takes the lead, pole position, race start and results, your fighter's bout and result")}
      </div>
      <p class="hint">These go to every phone you've turned notifications on for. Remember to tap Save.</p>`;
  }

  function wireNotify(view, d) {
    ["notify_start", "notify_scores", "notify_big_plays", "notify_final", "notify_digest",
     "notify_highlights", "notify_milestones", "notify_drama", "notify_periods", "notify_news",
     "notify_schedule", "notify_standings", "notify_tickets", "notify_events"].forEach(id =>
      view.querySelector("#" + id).onchange = e => d[id] = e.target.checked);
    ["notify_start_minutes", "notify_digest_hour", "notify_ticket_price"].forEach(id => view.querySelector("#" + id).onchange = e => d[id] = +e.target.value);
    paintPhone();
  }

  async function currentSub() {
    try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); }
    catch { return null; }
  }

  async function paintPhone() {
    const box = document.getElementById("phoneBox");
    if (!box) return;
    const msg = (html) => { box.innerHTML = html; };
    if (isIOS && !standalone()) {
      return msg(`<div style="font-weight:600">Add the app to your Home Screen first</div>
        <p class="small muted" style="margin:4px 0 0">On iPhone, notifications only work from the Home Screen app. Tap the Share button, then <strong>Add to Home Screen</strong>, open Sports Digest from there, and come back to this screen.</p>`);
    }
    if (!pushSupported()) return msg(`<div class="small muted">This browser can't show notifications. Try Safari on iPhone (from the Home Screen) or Chrome on Android.</div>`);
    if (Notification.permission === "denied") {
      return msg(`<div style="font-weight:600">Notifications are blocked</div>
        <p class="small muted" style="margin:4px 0 0">${isIOS ? "Open your iPhone's <strong>Settings → Notifications → Sports Digest</strong> and turn on Allow Notifications." : "Allow notifications for this site in your browser's settings, then reload."}</p>`);
    }
    const sub = Notification.permission === "granted" ? await currentSub() : null;
    if (!box.isConnected) return;   // they moved to another tab while we were checking
    if (sub) {
      msg(`<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div><div style="font-weight:600">🔔 On for this phone</div><span class="small muted">Choose which alerts below.</span></div>
        <button class="btn" id="phoneOff" style="height:40px">Turn off</button></div>`);
      box.querySelector("#phoneOff").onclick = async () => { await phoneOff(); paintPhone(); toast("Notifications off for this phone."); };
    } else {
      msg(`<div style="font-weight:600">Get alerts on this phone</div>
        <p class="small muted" style="margin:4px 0 10px">Games starting, scores, big plays and finals for your teams.</p>
        <button class="btn primary block" id="phoneOn">🔔 Turn on notifications</button>`);
      box.querySelector("#phoneOn").onclick = phoneOn;
    }
  }

  function keyBytes(b64) {
    const pad = "=".repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  async function phoneOn() {
    const btn = document.getElementById("phoneOn");
    if (btn) { btn.disabled = true; btn.textContent = "Turning on…"; }
    try {
      const perm = await Notification.requestPermission();      // must come straight from a tap
      if (perm !== "granted") { paintPhone(); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(CFG.VAPID_PUBLIC_KEY) });
      const j = sub.toJSON();
      const { error } = await sb.from("push_subscriptions").upsert({
        endpoint: j.endpoint, user_id: state.user.id, p256dh: j.keys.p256dh, auth: j.keys.auth,
        user_agent: navigator.userAgent.slice(0, 200),
      });
      if (error) throw error;
      // If they haven't saved settings yet, the alerts still need a saved account; make sure it exists.
      toast(state.sub ? "Notifications are on for this phone." : "Notifications are on. Tap Start my daily email to finish.");
    } catch (e) {
      toast("Couldn't turn on notifications: " + (e.message || e));
    }
    paintPhone();
  }

  // quiet = during sign-out/delete: don't complain if anything is already gone.
  async function phoneOff(quiet = false) {
    if (!PUSH_ON || !pushSupported()) return;
    try {
      const sub = await currentSub();
      if (!sub) return;
      await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    } catch (e) {
      if (!quiet) toast("Couldn't turn off: " + (e.message || e));
    }
  }

  // ---------------------------------------------------------------- start
  setInterval(() => {
    if (document.visibilityState !== "visible" || !state.sub) return;
    if (state.tab === "today" && state.day === 0) loadDay(0);   // live scores
    if (state.tab !== "chat" && state.chat.ok) loadGroups();       // unread dot on the Chat tab
  }, 60e3);
  // Tapping a notification opens .../#games, possibly in an already-open app.
  window.addEventListener("hashchange", () => {
    const j = location.hash.match(/^#join=([0-9a-fA-F]{6,32})$/);
    const c = location.hash.match(/^#chat\/([0-9a-f-]{36})(?:\/([a-z0-9]{2,8}:\d+|general))?$/);
    if (j || c) {
      history.replaceState(null, "", location.pathname + location.search);
      if (!state.sub) { if (j) store.set("pendingJoin", j[1]); return; }
      if (j) handleJoin(j[1].toLowerCase()); else openGroup(c[1], c[2] || null);
      return;
    }
    if (location.hash !== "#games") return;
    history.replaceState(null, "", location.pathname + location.search);
    if (!state.sub) return;
    state.tab = "today"; state.day = 0; store.set("tab", "today"); renderApp(); window.scrollTo(0, 0);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !state.sub) return;
    if (state.tab === "today" && isStale(state.day)) loadDay(state.day);
    if (state.tab === "news" && state.news && Date.now() - state.news.at > 10 * 60e3) loadNews();
  });
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  boot();
})();
