// Sports Digest widget for the Scriptable app (iPhone / iPad).
// Shows your teams' games: live scores, today's start times, recent finals and what's next.
// Works on the home screen (small, medium, large) and the lock screen.

// ========================= YOUR SETTINGS =========================
// Your Sports Digest account. Paste the same two values as the app's config.js.
// Then tap this script in Scriptable and choose "Sign in": the widget uses the
// teams you pick in the app's My Teams screen. No list to keep up to date here.
const SUPABASE_URL = "https://aunsqenueltgbhbsuxxn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1bnNxZW51ZWx0Z2JoYnN1eHhuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5MjMxNzYsImV4cCI6MjEwOTQ5OTE3Nn0.my0Lu1NNX6tNmq9YiWHnyHfmyJk4RecJFOPOU-z38mE";

// Teams to show when you're NOT signed in: "league:team".
// League is nfl, nba, nhl, mlb, cfb (college football), cbb (men's college basketball) or wnba.
// Team is the ESPN abbreviation (pro) or ESPN team number (college), e.g.
// espn.com/college-football/team/_/id/135/minnesota-golden-gophers  ->  135
const MY_TEAMS = [
  "nfl:min",   // Minnesota Vikings
  "nhl:min",   // Minnesota Wild
  "mlb:min",   // Minnesota Twins
  "cfb:135",   // Minnesota Golden Gophers football
  "cbb:135",   // Minnesota Golden Gophers basketball
];

// Where tapping the widget goes: your Sports Digest app address (SETUP.md step 9).
// Leave as "" to open ESPN instead.
const APP_URL = "https://brockstien.github.io/sports-digest-app/";

// Which teams the widget shows, in order of priority:
//   1. The widget's Parameter box (long-press > Edit Widget), e.g.  nfl:ari, nba:phx
//   2. Your Sports Digest account, if you've signed in
//   3. MY_TEAMS above
// =================================================================

const ESPN = "https://site.api.espn.com/apis/site/v2/sports";
const PATHS = {
  nfl: "football/nfl", nba: "basketball/nba", nhl: "hockey/nhl", mlb: "baseball/mlb", wnba: "basketball/wnba",
  cfb: "football/college-football", cbb: "basketball/mens-college-basketball",
};
const LEAGUE_NAMES = { nfl: "NFL", nba: "NBA", nhl: "NHL", mlb: "MLB", wnba: "WNBA", cfb: "CFB", cbb: "CBB" };

const RED = new Color("#c8102e");
const ACCENT = Color.dynamic(new Color("#1f5fbf"), new Color("#6aa2ff"));   // brand blue
const BG = Color.dynamic(new Color("#ffffff"), new Color("#1b1b1f"));
const INK = Color.dynamic(new Color("#18181b"), new Color("#f4f4f5"));
const MUTED = Color.dynamic(new Color("#71717a"), new Color("#a1a1aa"));
const LIVE = Color.dynamic(new Color("#c8102e"), new Color("#ff5c73"));

const fm = FileManager.local();
const CACHE_DIR = fm.joinPath(fm.cacheDirectory(), "sports-digest-widget");
if (!fm.fileExists(CACHE_DIR)) fm.createDirectory(CACHE_DIR, true);
const DATA_CACHE = fm.joinPath(CACHE_DIR, "games.json");

// ------------------------------------------------------------ settings
function parseTeams(text) {
  return text.split(/[,\n]/).map(s => s.trim().toLowerCase()).filter(Boolean).map(s => {
    const [league, team] = s.split(":").map(x => (x || "").trim());
    return PATHS[league] && team ? { league, team } : null;
  }).filter(Boolean);
}
const param = (typeof args !== "undefined" && args.widgetParameter) ? String(args.widgetParameter) : "";
let TEAMS = [];                 // filled in at the bottom (parameter, account or MY_TEAMS)
let ACCOUNT = { state: "off" }; // off | ok | cached | expired

// ------------------------------------------------------------ account (Supabase)
const ACCOUNT_ON = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const SESSION_KEY = "sports-digest-session";
const TEAMS_CACHE = fm.joinPath(CACHE_DIR, "account-teams.json");

async function supa(path, { method = "GET", body = null, token = null } = {}) {
  const req = new Request(SUPABASE_URL.replace(/\/$/, "") + path);
  req.method = method;
  req.timeoutInterval = 15;
  req.headers = { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json", Accept: "application/json",
                  ...(token || SUPABASE_ANON_KEY.split(".").length === 3 ? { Authorization: `Bearer ${token || SUPABASE_ANON_KEY}` } : {}) };
  if (body) req.body = JSON.stringify(body);
  let json = null;
  try { json = await req.loadJSON(); } catch (e) { if (!req.response || !req.response.statusCode) throw e; }
  const code = req.response ? req.response.statusCode : 0;
  if (code >= 400) {
    const err = new Error((json && (json.msg || json.message || json.error_description || json.error)) || `HTTP ${code}`);
    err.status = code;
    throw err;
  }
  return json;
}

function readSession() {
  try { return Keychain.contains(SESSION_KEY) ? JSON.parse(Keychain.get(SESSION_KEY)) : null; } catch (e) { return null; }
}
function saveSession(s) {
  Keychain.set(SESSION_KEY, JSON.stringify({
    access_token: s.access_token, refresh_token: s.refresh_token,
    expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
    user: { id: s.user.id, email: s.user.email },
  }));
}
function clearSession() { try { if (Keychain.contains(SESSION_KEY)) Keychain.remove(SESSION_KEY); } catch (e) {} }

// A signed-in session, refreshed when needed. null = not signed in, "expired" = must sign in again.
async function validSession() {
  const s = readSession();
  if (!s) return null;
  if (s.expires_at - 60 > Date.now() / 1000) return s;
  try {
    const fresh = await supa("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: s.refresh_token } });
    saveSession(fresh);
    return readSession();
  } catch (e) {
    return e.status ? "expired" : "offline";   // no status = no internet; keep the session for later
  }
}

// Turn the app's favorites ("Minnesota Vikings") into ESPN team numbers for each chosen league.
async function resolveTeams(row) {
  const favs = new Set((row.favorite_teams || []).map(f => String(f).toLowerCase()));
  const leagues = (row.leagues || []).filter(l => PATHS[l]);
  const key = "v3|" + JSON.stringify([...favs].sort()) + "|" + leagues.join(",");
  if (fm.fileExists(TEAMS_CACHE)) {
    try {
      const c = JSON.parse(fm.readString(TEAMS_CACHE));
      if (c.key === key && c.teams && c.teams.length && Date.now() - c.at < 30 * 24 * 36e5) return c.teams;
    } catch (e) { /* re-check below */ }
  }
  const teams = [];
  for (const lg of leagues) {
    // Team lists come from the app's Supabase "teams" function (the same list as My Teams); ESPN directly as a backup.
    let list = [];
    try {
      const d = await getJSON(`${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/teams?league=${lg}`);
      list = (d.teams || []).map(t => ({ id: t.id, displayName: t.name, shortDisplayName: t.short, name: t.nick, location: t.location, abbreviation: t.abbr }));
    } catch (e) { /* fall back to ESPN */ }
    if (!list.length) {
      const data = await getJSON(`${ESPN}/${PATHS[lg]}/teams?limit=1000`);
      list = (((data.sports || [])[0] || {}).leagues || [{}])[0].teams || [];
    }
    for (const item of list) {
      const t = item.team || item;
      // Match any of ESPN's names: "Minnesota Vikings", "Vikings", "Minnesota", "MIN" (same as the email).
      const names = [t && t.displayName, t && t.shortDisplayName, t && t.name, t && t.nickname, t && t.location, t && t.abbreviation]
        .filter(Boolean).map(x => String(x).toLowerCase());
      if (t && t.id && names.some(n => favs.has(n)) && !teams.includes(`${lg}:${t.id}`)) teams.push(`${lg}:${t.id}`);
    }
  }
  if (teams.length) fm.writeString(TEAMS_CACHE, JSON.stringify({ key, at: Date.now(), teams }));
  return teams;
}

function cachedAccountTeams() {
  if (!fm.fileExists(TEAMS_CACHE)) return null;
  try { return JSON.parse(fm.readString(TEAMS_CACHE)).teams; } catch (e) { return null; }
}

// Teams from the account: {state, teams}. Falls back to the last known teams when offline.
async function accountTeams() {
  if (!ACCOUNT_ON) return { state: "off" };
  const s = await validSession();
  if (s === null) return { state: "off" };
  if (s === "expired") return { state: "expired", teams: cachedAccountTeams() };
  if (s === "offline") return { state: "cached", teams: cachedAccountTeams() };
  try {
    const rows = await supa(`/rest/v1/subscribers?select=favorite_teams,leagues&id=eq.${s.user.id}`, { token: s.access_token });
    if (!rows || !rows.length) return { state: "ok", teams: [], noSettings: true, email: s.user.email };
    const favCount = (rows[0].favorite_teams || []).length;
    const teams = await resolveTeams(rows[0]);
    return { state: "ok", teams, favCount, email: s.user.email };
  } catch (e) {
    if (e.status === 401) return { state: "expired", teams: cachedAccountTeams() };
    return { state: "cached", teams: cachedAccountTeams(), error: String(e.message || e) };
  }
}

async function ask(title, message, placeholder, keyboard, button) {
  const a = new Alert();
  a.title = title; a.message = message;
  const f = a.addTextField(placeholder, "");
  if (keyboard === "email") f.setEmailAddressKeyboard();
  if (keyboard === "number") f.setNumberPadKeyboard();
  a.addAction(button);
  a.addCancelAction("Cancel");
  const i = await a.presentAlert();
  return i === -1 ? null : a.textFieldValue(0).trim();
}
async function tell(title, message) {
  const a = new Alert(); a.title = title; a.message = message; a.addAction("OK"); await a.presentAlert();
}

// Sign in with the same email and password as the app. Make the account in the app first.
async function signIn() {
  if (!ACCOUNT_ON) {
    await tell("Almost there", "Paste your SUPABASE_URL and SUPABASE_ANON_KEY at the top of this script first (the same values as the app's config.js).");
    return false;
  }
  for (let tries = 0; tries < 3; tries++) {
    const a = new Alert();
    a.title = "Sign in to Sports Digest";
    a.message = tries ? "Wrong email or password. Try again." : "Use the same email and password as the app.";
    const ef = a.addTextField("name@example.com", ""); ef.setEmailAddressKeyboard();
    a.addSecureTextField("Password", "");
    a.addAction("Sign in");
    a.addCancelAction("Cancel");
    if (await a.presentAlert() === -1) return false;
    const email = a.textFieldValue(0).trim(), password = a.textFieldValue(1);
    if (!email || !password) continue;
    try {
      const s = await supa("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
      saveSession(s);
      if (fm.fileExists(TEAMS_CACHE)) fm.remove(TEAMS_CACHE);
      return true;
    } catch (e) {
      if (/not confirmed/i.test(e.message)) { await tell("Confirm your email first", "Open the link we emailed you when you made your account, then try again."); return false; }
      if (/rate|seconds|too many/i.test(e.message)) { await tell("Too many tries", "Wait a minute and try again."); return false; }
      if (e.status && e.status !== 400) { await tell("Couldn't sign in", e.message); return false; }
    }
  }
  await tell("Couldn't sign in", "No password yet, or forgot it? Open the app and tap \"Forgot password?\" to set one, then run this again.");
  return false;
}

async function menu() {
  let s = readSession();
  let expired = false;
  // A saved sign-in stops working if you sign out of the app on every device: start fresh.
  if (s && ACCOUNT_ON && (await validSession()) === "expired") { clearSession(); s = null; expired = true; }
  const a = new Alert();
  a.title = "Sports Digest widget";
  a.message = !ACCOUNT_ON ? "Showing the teams listed in this script."
    : expired ? "Your sign-in expired. Tap Sign in and use your app email and password."
    : s ? `Signed in as ${s.user.email}. Showing your teams from the app.` : "Sign in to use the teams you picked in the app.";
  a.addAction("Preview widget");
  if (ACCOUNT_ON && !s) a.addAction("Sign in");
  if (s) { a.addAction("Update my teams now"); a.addDestructiveAction("Sign out"); }
  a.addCancelAction("Close");
  const i = await a.presentSheet();
  const choice = i === -1 ? "Close" : ["Preview widget", ...(ACCOUNT_ON && !s ? ["Sign in"] : []), ...(s ? ["Update my teams now", "Sign out"] : [])][i];
  if (choice === "Sign in") { if (await signIn()) await tell("Signed in", "Your widget now shows the teams from your account."); }
  if (choice === "Update my teams now" && fm.fileExists(TEAMS_CACHE)) fm.remove(TEAMS_CACHE);
  if (choice === "Sign out") {
    clearSession();
    if (fm.fileExists(TEAMS_CACHE)) fm.remove(TEAMS_CACHE);
    await tell("Signed out", "The widget will show the teams listed in the script.");
  }
  return choice !== "Close";
}

// ------------------------------------------------------------ data
// ESPN turns away requests that don't look like a web browser, so identify as Safari.
const BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
async function getJSON(url) {
  const req = new Request(url);
  req.timeoutInterval = 15;
  req.headers = { Accept: "application/json", "User-Agent": BROWSER_UA };
  let json = null;
  try { json = await req.loadJSON(); } catch (e) { if (!req.response || !req.response.statusCode) throw e; }
  const code = req.response ? req.response.statusCode : 0;
  if (code >= 400 || !json) throw new Error(`ESPN said ${code || "no response"}`);
  return json;
}

function scoreOf(c) {
  const s = c.score;
  if (s === undefined || s === null) return "";
  return typeof s === "object" ? String(s.displayValue ?? s.value ?? "") : String(s);
}

function logoOf(team) {
  if (!team) return "";
  if (team.logo) return team.logo;
  return team.logos && team.logos[0] ? team.logos[0].href : "";
}

// One request per favorite: ESPN's team page includes its current or next game.
async function loadTeamGame(fav) {
  const data = await getJSON(`${ESPN}/${PATHS[fav.league]}/teams/${encodeURIComponent(fav.team)}`);
  const t = data.team;
  if (!t) return { fav, error: "not found" };
  const ev = (t.nextEvent || [])[0];
  if (!ev) return { fav, team: t.displayName, none: true };
  const comp = (ev.competitions || [])[0] || {};
  const cs = comp.competitors || [];
  const side = c => ({
    abbr: (c.team && c.team.abbreviation) || "?",
    name: (c.team && (c.team.shortDisplayName || c.team.displayName)) || "?",
    id: c.team && String(c.team.id),
    logo: logoOf(c.team),
    score: scoreOf(c),
    winner: !!c.winner,
    rank: c.curatedRank && c.curatedRank.current <= 25 ? c.curatedRank.current : null,
  });
  const home = side(cs.find(c => c.homeAway === "home") || cs[0] || {});
  const away = side(cs.find(c => c.homeAway === "away") || cs[1] || {});
  const status = (comp.status || ev.status || {}).type || {};
  const tv = [];
  for (const b of comp.broadcasts || []) {
    if (b.media && b.media.shortName) tv.push(b.media.shortName);
    for (const n of b.names || []) tv.push(n);
  }
  const link = ((ev.links || []).find(l => (l.rel || []).includes("summary")) || (ev.links || [])[0] || {}).href || "";
  return {
    fav, league: fav.league, myId: String(t.id), myAbbr: t.abbreviation,
    record: t.record && t.record.items && t.record.items[0] ? t.record.items[0].summary : "",
    id: String(ev.id || ""), date: ev.date, tbd: comp.timeValid === false || ev.timeValid === false,
    state: status.state || "pre", detail: status.shortDetail || status.detail || "",
    home, away, tv: [...new Set(tv)].join(", "), link,
  };
}

async function loadAll() {
  const results = await Promise.all(TEAMS.map(f => loadTeamGame(f).catch(e => ({ fav: f, error: String(e) }))));
  const ok = results.filter(r => !r.error);
  if (!ok.length && results.length) {
    // Offline or ESPN down: show the last good data.
    if (fm.fileExists(DATA_CACHE)) {
      const cached = JSON.parse(fm.readString(DATA_CACHE));
      cached.offline = true;
      return cached;
    }
    return { games: [], offline: true, at: Date.now(), failed: results.length, error: results[0] && results[0].error };
  }
  // Two favorites playing each other show once.
  const seen = new Set();
  const games = ok.filter(g => !g.none && (seen.has(g.id) ? false : seen.add(g.id)));
  const out = { games, at: Date.now(), failed: results.length - ok.length };
  fm.writeString(DATA_CACHE, JSON.stringify(out));
  return out;
}

// ------------------------------------------------------------ ordering
const HOUR = 36e5;
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function rank(g, now) {
  const d = new Date(g.date);
  if (g.state === "in") return 0;                                   // live
  if (g.state === "pre" && sameDay(d, now)) return 1;               // later today
  if (g.state === "post" && now - d < 18 * HOUR) return 2;          // just finished
  if (g.state === "pre") return 3;                                  // coming up
  return 4;                                                         // older result
}
function ordered(games) {
  const now = new Date();
  // Within a group: upcoming games soonest first, finished games most recent first.
  const key = g => {
    const r = rank(g, now), t = new Date(g.date).getTime();
    return [r, r === 2 || r === 4 ? -t : t];
  };
  return games.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
}

// ------------------------------------------------------------ formatting
function fmtDate(date, pattern) { const df = new DateFormatter(); df.dateFormat = pattern; return df.string(date); }
function whenText(g) {
  const d = new Date(g.date), now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * HOUR);
  const day = sameDay(d, now) ? "" : sameDay(d, tomorrow) ? "Tmrw " : fmtDate(d, "EEE ");
  return g.tbd ? `${day || "Today "}TBD`.trim() : `${day}${fmtDate(d, "h:mm a")}`;
}
function statusText(g) {
  if (g.state === "in") return g.detail || "Live";
  if (g.state === "post") return /final/i.test(g.detail) ? g.detail.replace(/^Final\/?/, "Final ").trim() : (g.detail || "Final");
  return whenText(g);
}
const label = t => (t.rank ? `#${t.rank} ` : "") + t.abbr;

async function logo(url, size) {
  if (!url) return null;
  const file = fm.joinPath(CACHE_DIR, "logo-" + url.replace(/[^a-z0-9]/gi, "").slice(-60) + ".png");
  try {
    if (fm.fileExists(file)) return fm.readImage(file);
    const img = await new Request(url).loadImage();
    fm.writeImage(file, img);
    return img;
  } catch (e) { return null; }
}

// ------------------------------------------------------------ layouts
function header(w, data, size = 11) {
  const h = w.addStack();
  h.layoutHorizontally(); h.centerAlignContent();
  const t = h.addText("SPORTS DIGEST");
  t.font = Font.boldSystemFont(size); t.textColor = ACCENT;
  h.addSpacer();
  const u = h.addText(ACCOUNT.state === "expired" ? "Tap to sign in" : data.offline ? "Offline" : fmtDate(new Date(data.at), "h:mm a"));
  u.font = Font.systemFont(size - 1); u.textColor = ACCOUNT.state === "expired" ? RED : MUTED;
}

async function teamLine(stack, t, g, logoSize, fontSize, showScore) {
  const row = stack.addStack();
  row.layoutHorizontally(); row.centerAlignContent(); row.spacing = 6;
  const img = await logo(t.logo, logoSize);
  if (img) { const wi = row.addImage(img); wi.imageSize = new Size(logoSize, logoSize); }
  const won = g.state === "post" && t.winner;
  const mine = t.id === g.myId;
  const n = row.addText(label(t));
  n.font = (won || mine) ? Font.boldSystemFont(fontSize) : Font.mediumSystemFont(fontSize);
  n.textColor = INK; n.lineLimit = 1;
  row.addSpacer();
  if (showScore) {
    const s = row.addText(t.score || "0");
    s.font = won || g.state === "in" ? Font.boldSystemFont(fontSize) : Font.systemFont(fontSize);
    s.textColor = g.state === "post" && !won ? MUTED : INK;
  }
}

async function bigGame(w, g) {
  const showScore = g.state !== "pre";
  await teamLine(w, g.away, g, 26, 17, showScore);
  w.addSpacer(4);
  await teamLine(w, g.home, g, 26, 17, showScore);
  w.addSpacer(6);
  const s = w.addText((g.state === "in" ? "● " : "") + statusText(g));
  s.font = Font.semiboldSystemFont(12); s.textColor = g.state === "in" ? LIVE : INK; s.lineLimit = 1;
  const meta = [LEAGUE_NAMES[g.league], g.state === "pre" ? g.tv : ""].filter(Boolean).join(" · ");
  if (meta) { const m = w.addText(meta); m.font = Font.systemFont(10); m.textColor = MUTED; m.lineLimit = 1; }
}

async function gameRow(w, g, compact) {
  const row = w.addStack();
  row.layoutHorizontally(); row.centerAlignContent(); row.spacing = 6;
  if (g.link) row.url = g.link;
  const showScore = g.state !== "pre";
  for (const [i, t] of [[0, g.away], [1, g.home]]) {
    if (i === 1) { const at = row.addText(showScore ? "–" : "@"); at.font = Font.systemFont(13); at.textColor = MUTED; }
    const img = await logo(t.logo, 20);
    const side = row.addStack(); side.layoutHorizontally(); side.centerAlignContent(); side.spacing = 4;
    if (img && i === 0) { const wi = side.addImage(img); wi.imageSize = new Size(20, 20); }
    if (i === 1 && showScore) { const sc = side.addText(t.score || "0"); sc.font = Font.boldSystemFont(14); sc.textColor = g.state === "post" && !t.winner ? MUTED : INK; }
    const n = side.addText(label(t));
    n.font = (t.id === g.myId) ? Font.boldSystemFont(14) : Font.mediumSystemFont(14); n.textColor = INK; n.lineLimit = 1;
    if (i === 0 && showScore) { const sc = side.addText(t.score || "0"); sc.font = Font.boldSystemFont(14); sc.textColor = g.state === "post" && !t.winner ? MUTED : INK; }
    if (img && i === 1) { const wi = side.addImage(img); wi.imageSize = new Size(20, 20); }
  }
  row.addSpacer();
  const right = row.addStack(); right.layoutVertically();
  const s = right.addText((g.state === "in" ? "● " : "") + statusText(g));
  s.font = Font.semiboldSystemFont(12); s.textColor = g.state === "in" ? LIVE : INK; s.lineLimit = 1; s.rightAlignText();
  if (!compact) {
    const meta = [LEAGUE_NAMES[g.league], g.state === "pre" ? g.tv : ""].filter(Boolean).join(" · ");
    const m = right.addText(meta); m.font = Font.systemFont(10); m.textColor = MUTED; m.lineLimit = 1; m.rightAlignText();
  }
}

function emptyMessage(w, data) {
  const t = w.addText(data.offline ? "Can't reach ESPN right now. It'll try again soon."
    : ACCOUNT.error && !TEAMS.length ? "Couldn't load your teams. Open Scriptable and run the script to see why."
    : ACCOUNT.noSettings ? "Pick your teams in the Sports Digest app."
    : TEAMS.length ? "No upcoming games for your teams."
    : ACCOUNT.favCount ? "Your favorites are golfers, drivers or fighters; the widget shows team games."
    : ACCOUNT.state !== "off" ? "Add favorite teams in the app's My Teams screen." : "Add your teams at the top of the script.");
  t.font = Font.systemFont(13); t.textColor = MUTED;
}

async function buildWidget(data, family) {
  const w = new ListWidget();
  const games = ordered(data.games || []);
  w.url = ACCOUNT.state === "expired" ? URLScheme.forRunningScript()
        : APP_URL || (games[0] && games[0].link) || "https://www.espn.com";
  // Ask iOS to refresh sooner during live games (iOS decides the exact timing).
  const refreshMin = games.some(g => g.state === "in") ? 5
    : games.some(g => g.state === "pre" && new Date(g.date) - Date.now() < 2 * HOUR) ? 15 : 60;
  w.refreshAfterDate = new Date(Date.now() + refreshMin * 60e3);

  // Lock screen
  if (family === "accessoryInline") {
    w.setPadding(0, 0, 0, 0);
    const g = games[0];
    w.addText(g ? `${label(g.away)} ${g.state !== "pre" ? g.away.score + "–" + g.home.score + " " : "@ "}${label(g.home)} · ${statusText(g)}` : "No games");
    return w;
  }
  if (family === "accessoryCircular") {
    w.setPadding(0, 0, 0, 0);
    const g = games[0];
    w.addSpacer();
    const a = w.addText(g ? (g.state === "pre" ? (g.myAbbr || "") : `${g.away.score}-${g.home.score}`) : "—");
    a.font = Font.boldSystemFont(14); a.centerAlignText(); a.minimumScaleFactor = 0.6;
    const b = w.addText(g ? (g.state === "pre" ? fmtDate(new Date(g.date), "h:mm") : g.state === "in" ? "LIVE" : "F") : "");
    b.font = Font.systemFont(10); b.centerAlignText();
    w.addSpacer();
    return w;
  }
  if (family === "accessoryRectangular") {
    w.setPadding(0, 0, 0, 0);
    if (!games.length) {
      const t = w.addText("Sports Digest"); t.font = Font.boldSystemFont(14);
      emptyMessage(w, data); return w;
    }
    const g = games[0];
    const line = w.addText(`${label(g.away)} ${g.state !== "pre" ? g.away.score + " – " + g.home.score + " " : "@ "}${label(g.home)}`);
    line.font = Font.boldSystemFont(15); line.lineLimit = 1; line.minimumScaleFactor = 0.7;
    const st = w.addText((g.state === "in" ? "● " : "") + statusText(g));
    st.font = Font.systemFont(13); st.lineLimit = 1;
    const n = games[1];
    if (n) {
      const nx = w.addText(`Next: ${label(n.away)} ${n.state !== "pre" ? n.away.score + "–" + n.home.score + " " : "@ "}${label(n.home)} · ${statusText(n)}`);
      nx.font = Font.systemFont(11); nx.lineLimit = 1; nx.minimumScaleFactor = 0.8; nx.textOpacity = 0.75;
    }
    return w;
  }

  // Home screen
  w.backgroundColor = BG;

  if (family === "small") {
    w.setPadding(12, 12, 12, 12);
    header(w, data, 9);
    w.addSpacer(8);
    if (!games.length) { emptyMessage(w, data); w.addSpacer(); return w; }
    await bigGame(w, games[0]);
    w.addSpacer();
    if (games.length > 1) {
      const more = w.addText(`+${games.length - 1} more`);
      more.font = Font.systemFont(10); more.textColor = MUTED;
    }
    return w;
  }

  const max = family === "medium" ? 3 : family === "extraLarge" ? 8 : 6;
  w.setPadding(12, 14, 12, 14);
  header(w, data, 11);
  w.addSpacer(family === "medium" ? 6 : 10);
  if (!games.length) { emptyMessage(w, data); w.addSpacer(); return w; }
  const list = games.slice(0, max);
  for (let i = 0; i < list.length; i++) {
    if (i) w.addSpacer(family === "medium" ? 6 : 10);
    await gameRow(w, list[i], family === "medium");
  }
  w.addSpacer();
  return w;
}

// ------------------------------------------------------------ run
// Inside the Scriptable app, show the sign-in menu first.
const proceed = config.runsInWidget ? true : await menu();

if (proceed) {
  if (param) {
    TEAMS = parseTeams(param);
  } else {
    ACCOUNT = await accountTeams();
    TEAMS = ACCOUNT.teams ? parseTeams(ACCOUNT.teams.join(",")) : parseTeams(MY_TEAMS.join(","));
  }

  const data = await loadAll();
  const family = config.widgetFamily || "medium";
  // Inside the Scriptable app: say plainly what's wrong, if anything.
  if (!config.runsInWidget) {
    const problems = [];
    if (ACCOUNT.error) problems.push(`Loading your teams failed: ${ACCOUNT.error}`);
    if (ACCOUNT.state === "ok" && ACCOUNT.favCount && !TEAMS.length) problems.push("None of your favorites matched a team. In the app's My Teams, pick teams from the dropdowns.");
    if (data.offline) problems.push(`Couldn't get games from ESPN${data.error ? `: ${data.error}` : ""}.`);
    if (problems.length) await tell("Widget check", problems.join("\n\n"));
  }
  const widget = await buildWidget(data, family);
  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    // Run inside Scriptable: show a preview.
    if (family === "small") await widget.presentSmall();
    else if (family === "large") await widget.presentLarge();
    else await widget.presentMedium();
  }
}
Script.complete();
