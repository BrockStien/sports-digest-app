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
  ];
  const LEAGUE = Object.fromEntries(LEAGUES.map(l => [l.key, l]));
  const GAME_HOURS = { nfl: 3.5, cfb: 3.5, nba: 2.5, nhl: 2.5, mlb: 3, cbb: 2, ufc: 5 };
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
  };
  const PUSH_ON = !!(CFG.VAPID_PUBLIC_KEY && CFG.VAPID_PUBLIC_KEY.length > 40);
  const NOTIFY_DEFAULTS = {
    notify_start: true, notify_final: true, notify_scores: false, notify_big_plays: true,
    notify_digest: false, notify_start_minutes: 30, notify_digest_hour: 7,
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
    myTeamsOnly: true,
    showAllCollege: false,
    day: 0,            // -1 yesterday, 0 today, 1 tomorrow
    days: {},          // day -> {at, leagues:[{league, games, error}]}
    loadingDay: {},
    news: null,        // {at, items, failed}
    loadingNews: false,
    newsMine: null,    // null = use the person's "only news about my teams" setting
    chat: { ok: null, groups: null, groupId: null, thread: null, threadTitle: "", members: [], channel: null, poll: null, showSettings: false },
  };

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
      score: c.score, winner: !!c.winner,
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
  function parseGame(e, lg) {
    const comp = (e.competitions || [{}])[0];
    const cs = comp.competitors || [];
    const home = cs.find(c => c.homeAway === "home") || cs[0] || {};
    const away = cs.find(c => c.homeAway === "away") || cs[1] || {};
    const st = ((e.status || comp.status || {}).type) || {};
    const state = st.state || "pre";
    const bc = [].concat(...(comp.broadcasts || []).map(b => b.names || []));
    return {
      kind: "game", league: lg, id: e.id, key: `${lg}:${e.id}`, state,
      detail: st.shortDetail || st.detail || "",
      postponed: ["STATUS_POSTPONED", "STATUS_CANCELED"].includes(st.name),
      start: e.date ? new Date(e.date) : null,
      tbd: comp.timeValid === false,
      home: team(home), away: team(away),
      tv: [...new Set(bc)].join(", "),
      odds: state === "pre" ? ((comp.odds || [{}])[0] || {}).details || "" : "",
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
  function isFav(g, favs) {
    if (!favs.size) return false;
    const names = new Set();
    if (g.kind === "fight") {
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
    const matchup = g.kind === "fight" ? g.card : `${g.away.full} vs ${g.home.full}`;
    return { label: "Find tickets", url: "https://www.google.com/search?q=" + encodeURIComponent(`${matchup} tickets ${d}`) };
  }
  const utcStamp = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  function calendarLink(g, fav, s) {
    if (!upcoming(g) || !wanted(s.calendar_links, fav)) return null;
    const title = g.kind === "fight" ? g.card : `${g.away.name} @ ${g.home.name}`;
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
    const joinCode = (location.hash.match(/^#join=([0-9a-fA-F]{6,32})$/) || [])[1] || store.get("pendingJoin");
    const chatLink = location.hash.match(/^#chat\/([0-9a-f-]{36})(?:\/([a-z]{3,4}:\d+|general))?$/);
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
              <button class="btn link" id="forgot">Forgot password? (or first time setting one)</button>
              <button class="btn link" id="useCode">Email me a sign-in code instead</button>`}
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
      $("useCode").onclick = () => { remember(); renderCodeRequest(); };
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

  function renderCodeRequest(errorMsg = "") {
    $app.className = "no-tabs";
    $app.innerHTML = `<div class="signin">
      <img class="brand" src="icons/icon-192.png" alt="">
      <div class="kicker">${esc(APP_NAME)}</div>
      <h1>Sign in with a code</h1>
      <form id="emailForm" class="field" novalidate>
        <label for="email">Email</label>
        <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com" value="${esc(state.pendingEmail)}" required>
        <p class="error ${errorMsg ? "" : "hidden"}" id="err">${esc(errorMsg)}</p>
        <button class="btn primary block" style="margin-top:12px" id="send">Email me a sign-in code</button>
      </form>
      <button class="btn link" id="back">Sign in with a password instead</button>
    </div>`;
    document.getElementById("back").onclick = () => renderSignIn();
    const form = document.getElementById("emailForm");
    form.onsubmit = async ev => {
      ev.preventDefault();
      const email = document.getElementById("email").value.trim();
      const err = document.getElementById("err");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = "Enter a valid email address."; err.classList.remove("hidden"); return; }
      const btn = document.getElementById("send");
      btn.disabled = true; btn.textContent = "Sending…";
      const { error } = await sb.auth.signInWithOtp({
        email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname },
      });
      if (error) {
        btn.disabled = false; btn.textContent = "Email me a sign-in code";
        err.textContent = friendly(error);
        err.classList.remove("hidden");
        return;
      }
      state.pendingEmail = email;
      renderCode();
    };
  }

  function renderCode(errorMsg = "") {
    $app.className = "no-tabs";
    $app.innerHTML = `<div class="signin">
      <img class="brand" src="icons/icon-192.png" alt="">
      <h1>Check your email</h1>
      <p class="muted">We sent a code to <strong>${esc(state.pendingEmail)}</strong>. Type it below. (It may take a minute; check spam too.)</p>
      <form id="codeForm" class="field" novalidate>
        <label for="code">Sign-in code</label>
        <input id="code" class="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" required>
        <p class="error ${errorMsg ? "" : "hidden"}" id="err">${esc(errorMsg)}</p>
        <button class="btn primary block" style="margin-top:12px" id="verify">Sign in</button>
      </form>
      <button class="btn link" id="back">Use a different email</button>
      <p class="hint">Got a link instead of a code? Tap "Use a different email", then "Sign in with a password instead" and "Forgot password?" to set a password.</p>
    </div>`;
    const input = document.getElementById("code");
    input.focus();
    input.oninput = () => document.getElementById("err").classList.add("hidden");
    document.getElementById("back").onclick = () => renderCodeRequest();
    document.getElementById("codeForm").onsubmit = async ev => {
      ev.preventDefault();
      const token = input.value.replace(/\D/g, "");
      const err = document.getElementById("err");
      if (token.length < 6) { err.textContent = "Enter the code from the email."; err.classList.remove("hidden"); return; }
      const btn = document.getElementById("verify");
      btn.disabled = true; btn.textContent = "Checking…";
      const { data, error } = await sb.auth.verifyOtp({ email: state.pendingEmail, token, type: "email" });
      if (error || !data.session) {
        btn.disabled = false; btn.textContent = "Sign in";
        err.textContent = "That code didn't work. Check it, or go back and send a new one.";
        err.classList.remove("hidden");
        return;
      }
      await loadAccount(data.session.user);
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
  function renderApp() {
    $app.className = "";
    const first = !state.sub;
    if (!["today", "news", "chat", "teams"].includes(state.tab) || (state.tab === "chat" && state.chat.ok === false)) state.tab = "today";
    const tab = (key, icon, label) =>
      `<button data-tab="${key}" ${state.tab === key ? 'aria-current="page"' : ""}>${icon}${label}</button>`;
    $app.innerHTML = `
      <div id="view"></div>
      ${first ? "" : `<nav class="tabs" aria-label="Main">
        ${tab("today", ICON.today, "Games")}${tab("news", ICON.news, "News")}${state.chat.ok === false ? "" : tab("chat", ICON.chat, "Chat")}${tab("teams", ICON.teams, "My Teams")}
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
        const parse = lg.kind === "fight" ? parseCard : parseGame;
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
      const unit = lg.kind === "fight" ? "card" : "game";
      html += `<section class="card"><div class="card-head">${esc(lg.name)}<span>${games.length} ${unit}${games.length === 1 ? "" : "s"}</span></div>
        ${games.map(x => x.g.kind === "fight" ? cardRow(x.g, x.fav, s) : gameRow(x.g, x.fav, s)).join("")}
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
  function watchBox(g) {
    if (g.state === "post" || g.postponed) return "";
    return `<details class="watch"><summary>📺 How to watch</summary><ul>${
      watchInfo(g).map(([n, how]) => `<li><strong>${esc(n)}</strong> · ${esc(how)}</li>`).join("")
    }</ul><div class="small muted">Streaming deals change, so double-check with the service.</div></details>`;
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
    const meta = [g.tv, g.odds && `Line: ${g.odds}`].filter(Boolean).join(" · ");
    return `<div class="row ${fav ? "fav" : ""}">
      ${fav ? '<div class="small star" aria-label="Your team">★ Your team</div>' : ""}
      ${teamLine(g.away, showScore, aWin)}
      ${teamLine(g.home, showScore, hWin)}
      ${status}
      ${meta && !done ? `<div class="meta">${esc(meta)}</div>` : ""}
      ${actions(g, fav, s)}
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
    if (g.kind === "fight") return `<strong>${esc(g.card)}</strong> · ${g.state === "in" ? '<span class="live">● Live</span>' : g.state === "post" ? "Final" : esc(timeIn(g.start, state.sub.timezone))}`;
    const st = g.state === "in" ? `<span class="live">● ${esc(g.detail)}</span>` : g.state === "post" ? esc(g.detail || "Final") : esc(g.tbd ? "Time TBD" : timeIn(g.start, state.sub.timezone));
    const sc = g.state === "pre" ? "" : ` ${esc(g.away.score)}–${esc(g.home.score)}`;
    return `<strong>${esc(g.away.name)} @ ${esc(g.home.name)}</strong>${sc} · ${st}`;
  }
  function gameTitle(g) {
    const day = new Intl.DateTimeFormat("en-US", { timeZone: state.sub.timezone, weekday: "short", month: "short", day: "numeric" }).format(g.start || new Date());
    return (g.kind === "fight" ? g.card : `${g.away.name} @ ${g.home.name}`).slice(0, 60) + " · " + day;
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
    pick.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Choose a group"><div class="label">Discuss ${esc(g.kind === "fight" ? g.card : g.away.name + " @ " + g.home.name)} in…</div>
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
  async function loadTeams(keys) {
    await Promise.all(keys.filter(k => !state.teams[k] && LEAGUE[k] && LEAGUE[k].kind !== "fight").map(async k => {
      const cacheKey = "teams:" + k;
      const cached = store.get(cacheKey);
      if (cached && Date.now() - cached.at < 7 * 864e5) { state.teams[k] = cached.list; return; }
      try {
        const lg = LEAGUE[k];
        const data = await getJSON(`${ESPN}/${lg.path}/teams?` + qs(lg.teamParams || { limit: "100" }));
        const list = (((data.sports || [])[0] || {}).leagues || [{}])[0].teams || [];
        state.teams[k] = list.map(x => x.team || x).filter(t => t.displayName).map(t => ({
          name: t.displayName, abbr: t.abbreviation || "", nick: t.name || "", league: k,
          logo: (t.logos && t.logos[0] && t.logos[0].href) || "",
        }));
        store.set(cacheKey, { at: Date.now(), list: state.teams[k] });
      } catch {
        state.teamsFailed = true;
      }
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
        <label for="teamSearch">Favorite teams${d.leagues.includes("ufc") ? " and fighters" : ""}</label>
        <div class="chips" id="chips"></div>
        <input id="teamSearch" type="search" placeholder="Search teams, e.g. Vikings" autocomplete="off">
        <div class="results hidden" id="results"></div>
        <p class="hint" id="teamHint">Favorites are starred, listed first, and get ticket links and calendar invites.</p>
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
      if (cb.checked) loadTeams([k]);
      document.querySelector('label[for="teamSearch"]').textContent = "Favorite teams" + (d.leagues.includes("ufc") ? " and fighters" : "");
    });
    // simple fields
    view.querySelector("#name").oninput = e => d.name = e.target.value;
    ["timezone", "ticket_links", "calendar_links"].forEach(id => view.querySelector("#" + id).onchange = e => d[id] = e.target.value);
    ["active", "calendar_attachment", "favorites_only_headlines"].forEach(id => view.querySelector("#" + id).onchange = e => d[id] = e.target.checked);
    ["reminder_minutes", "headlines_per_league"].forEach(id => view.querySelector("#" + id).oninput = e => d[id] = e.target.value);
    if (PUSH_ON) wireNotify(view, d);

    paintChips();
    const search = view.querySelector("#teamSearch");
    search.oninput = () => paintResults(search.value);
    search.onfocus = () => { loadTeams(d.leagues).then(() => paintResults(search.value)); };
    loadTeams(d.leagues);

    view.querySelector("#save").onclick = save;
    view.querySelector("#setpw").onclick = () => renderSetPassword(state.user);
    view.querySelector("#signout").onclick = async () => { await phoneOff(true); await sb.auth.signOut(); };
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

  function addFavorite(name) {
    const d = state.draft;
    name = name.trim().slice(0, 60);
    if (!name) return;
    if (d.favorite_teams.some(t => t.toLowerCase() === name.toLowerCase())) { toast(`${name} is already a favorite`); return; }
    if (d.favorite_teams.length >= 60) { toast("That's the limit of 60 favorites"); return; }
    d.favorite_teams.push(name);
    paintChips();
    const s = document.getElementById("teamSearch");
    s.value = ""; paintResults("");
    s.focus();
  }

  function paintResults(q) {
    const box = document.getElementById("results");
    if (!box) return;
    q = q.trim().toLowerCase();
    if (q.length < 2) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    const d = state.draft;
    const chosen = new Set(d.favorite_teams.map(t => t.toLowerCase()));
    const pool = d.leagues.flatMap(k => state.teams[k] || []);
    const seen = new Set();
    const hits = pool.filter(t => !chosen.has(t.name.toLowerCase()) &&
        (t.name.toLowerCase().includes(q) || t.abbr.toLowerCase() === q || t.nick.toLowerCase().startsWith(q)))
      .filter(t => (seen.has(t.name) ? false : seen.add(t.name)))
      .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1))
      .slice(0, 15);
    const raw = document.getElementById("teamSearch").value.trim();
    const custom = d.leagues.includes("ufc") ? `Add "${raw}" (fighter or other name)` : `Add "${raw}" as typed`;
    box.innerHTML = hits.map((t, i) => `<button type="button" data-hit="${i}">
        ${t.logo ? `<img class="logo" src="${esc(t.logo)}" alt="" loading="lazy">` : ""}${esc(t.name)}<span class="lg">${esc(LEAGUE[t.league].name)}</span></button>`).join("")
      + `<button type="button" data-custom>${esc(custom)}</button>`;
    box.classList.remove("hidden");
    box.querySelectorAll("[data-hit]").forEach(b => b.onclick = () => addFavorite(hits[+b.dataset.hit].name));
    box.querySelector("[data-custom]").onclick = () => addFavorite(raw);
    const hint = document.getElementById("teamHint");
    if (state.teamsFailed && hint) hint.textContent = "Team search couldn't reach ESPN right now. You can still add a team by typing its full name, like \"Minnesota Vikings\".";
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
        ${sw("notify_big_plays", "Big plays and close finishes", "Turnovers, 40+ yard plays, home runs, tight games late")}
        ${sw("notify_final", "Final scores")}
        ${sw("notify_digest", "Morning summary", "Last night's results and today's games")}
        <div class="switch-row"><div class="txt"><div>Summary time</div></div>
          <select id="notify_digest_hour" aria-label="Summary time">${hours}</select></div>
      </div>
      <p class="hint">These go to every phone you've turned notifications on for. Remember to tap Save.</p>`;
  }

  function wireNotify(view, d) {
    ["notify_start", "notify_scores", "notify_big_plays", "notify_final", "notify_digest"].forEach(id =>
      view.querySelector("#" + id).onchange = e => d[id] = e.target.checked);
    ["notify_start_minutes", "notify_digest_hour"].forEach(id => view.querySelector("#" + id).onchange = e => d[id] = +e.target.value);
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
    const c = location.hash.match(/^#chat\/([0-9a-f-]{36})(?:\/([a-z]{3,4}:\d+|general))?$/);
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
