/* ============================================================
   NHL Goal Scorer Tracker — Frontend App
   ============================================================ */

"use strict";

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
const state = {
  oddsData: null,
  scorersData: null,
  currentView: "odds",
  sortKey: "probability",
  sortDir: -1,          // -1 = desc, 1 = asc
  teamFilter: "",
  posFilter: "",
  nameFilter: "",
  dateFilter: "",       // YYYY-MM-DD, "" = today
  gameFilter: "",       // "AWAY:HOME" matchup key, "" = all games
  tonightOnly: false,
  fullRosterOdds: false,
  loadingDetail: false,
  charts: {},
};

// ---------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function formatTime(utc) {
  if (!utc) return "";
  try {
    return new Date(utc).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  } catch { return ""; }
}

function matchupKey(game) {
  return `${game.awayTeam}:${game.homeTeam}`;
}

function matchupLabel(game) {
  const time = formatTime(game.startTimeUTC);
  return `${game.awayTeam} @ ${game.homeTeam}${time ? " · " + time : ""}`;
}

// ---------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------
const $ = id => document.getElementById(id);
const views     = document.querySelectorAll(".view");
const navBtns   = document.querySelectorAll("nav button[data-view]");
const panel     = $("detail-panel");
const overlay   = $("overlay");
const mainTbody = $("main-tbody");

// ---------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------
function showView(name) {
  state.currentView = name;
  views.forEach(v => v.classList.toggle("active", v.id === `view-${name}`));
  navBtns.forEach(b => b.classList.toggle("active", b.dataset.view === name));

  if (name === "odds" && !state.oddsData)       loadOdds();
  if (name === "scorers" && !state.scorersData) loadScorers();
  if (name === "predict")                       loadPredict();
}

navBtns.forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function probColor(prob) {
  if (prob >= 0.55) return "#4ade80";
  if (prob >= 0.40) return "#34d399";
  if (prob >= 0.28) return "#60a5fa";
  if (prob >= 0.18) return "#fbbf24";
  return "#f87171";
}

function tierBadge(tier) {
  return `<span class="badge tier-${tier}">${tier.toUpperCase()}</span>`;
}

function oddsHtml(odds) {
  if (!odds || odds === "N/A") return `<span class="text-muted">N/A</span>`;
  const cls = odds.startsWith("+") ? "odds-pos" : "odds-neg";
  return `<span class="${cls}">${odds}</span>`;
}

function cfBar(cfPct) {
  const pct  = Math.round(cfPct);
  const good = cfPct >= 52;
  const clr  = cfPct >= 55 ? "var(--green)" : cfPct >= 50 ? "var(--accent)" : cfPct >= 45 ? "var(--text-muted)" : "var(--red)";
  return `<span style="color:${clr};font-weight:600">${pct}%</span>`;
}

function situationBars(mf) {
  if (!mf || mf.totalGoals === 0) return "";
  const ev = mf.evGoals || 0;
  const pp = mf.ppGoals || 0;
  const tot = Math.max(ev + pp, 1);
  const evPct = Math.round(ev / tot * 100);
  const ppPct = 100 - evPct;
  return `
    <div class="model-row" style="flex-direction:column;gap:4px;align-items:stretch">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted)">
        <span>Situations (EV vs PP)</span>
        <span>${ev}EV · ${pp}PP</span>
      </div>
      <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;gap:2px">
        <div style="background:var(--accent);width:${evPct}%;border-radius:2px"></div>
        <div style="background:var(--gold);width:${ppPct}%;border-radius:2px"></div>
      </div>
    </div>`;
}

function factorBadges(factors) {
  if (!factors || !factors.length) return "";
  return factors.map(f => `<span class="factor-badge">${f}</span>`).join(" ");
}

function probBar(prob) {
  const pct = Math.round(prob * 100);
  const color = probColor(prob);
  return `
    <div class="prob-bar-wrap">
      <div class="prob-bar-bg">
        <div class="prob-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="prob-val">${pct}%</span>
    </div>`;
}

function avatarHtml(src, name) {
  const initials = (name || "?").split(" ").map(p => p[0]).join("").slice(0, 2).toUpperCase();
  if (src) {
    return `<img src="${src}" alt="${name}" onerror="this.outerHTML='<div class=\\'avatar-fallback\\'>${initials}</div>'" loading="lazy">`;
  }
  return `<div class="avatar-fallback">${initials}</div>`;
}

function loading(msg = "Loading data…") {
  return `<div class="loading-wrap"><div class="spinner"></div><span>${msg}</span></div>`;
}

function empty(msg) {
  return `<div class="loading-wrap" style="color:var(--text-muted)">${msg}</div>`;
}

// ---------------------------------------------------------------
// Schedule loading (populates game filter dropdown)
// ---------------------------------------------------------------
async function loadSchedule(date) {
  const qs = date ? `?date=${date}` : "";
  try {
    const res = await fetch(`/api/schedule${qs}`);
    if (!res.ok) return;
    const data = await res.json();
    populateGameFilter(data.games || []);
  } catch (_) {}
}

function populateGameFilter(games) {
  const sel = $("odds-filter-game");
  if (!sel) return;
  // Keep first "All Games" option, replace the rest
  while (sel.options.length > 1) sel.remove(1);
  for (const g of games) {
    const opt = document.createElement("option");
    opt.value = matchupKey(g);
    opt.textContent = matchupLabel(g);
    sel.appendChild(opt);
  }
  // Reset game filter if previously selected game is no longer present
  const keys = games.map(matchupKey);
  if (state.gameFilter && !keys.includes(state.gameFilter)) {
    state.gameFilter = "";
    sel.value = "";
  }

  // Populate "Tonight's Teams" optgroup in the team dropdown
  const grp = $("odds-tonight-teams");
  if (grp) {
    while (grp.firstChild) grp.removeChild(grp.firstChild);
    const teams = [...new Set(games.flatMap(g => [g.awayTeam, g.homeTeam]))].sort();
    for (const t of teams) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      grp.appendChild(opt);
    }
    grp.style.display = teams.length ? "" : "none";
  }
}

// ---------------------------------------------------------------
// Odds view
// ---------------------------------------------------------------
async function loadOdds() {
  const msg = state.fullRosterOdds
    ? "Loading full rosters + odds model (~15 s first load)…"
    : "Fetching goal scorer odds…";
  $("odds-container").innerHTML = loading(msg);
  const dateParam      = state.dateFilter ? `&date=${state.dateFilter}` : "";
  const rosterParam    = state.fullRosterOdds ? "&full_roster=true" : "";
  try {
    const [oddsRes] = await Promise.all([
      fetch(`/api/odds?limit=100${dateParam}${rosterParam}`),
      loadSchedule(state.dateFilter),
    ]);
    if (!oddsRes.ok) throw new Error(`HTTP ${oddsRes.status}`);
    state.oddsData = await oddsRes.json();
    $("odds-season").textContent = formatSeason(state.oddsData.season);
    renderOddsTable();
  } catch (e) {
    $("odds-container").innerHTML = `<div class="loading-wrap" style="color:var(--red)">
      Error loading odds: ${e.message}</div>`;
  }
}

function formatSeason(s) {
  if (!s || s.length < 8) return s || "";
  return `${s.slice(0, 4)}–${s.slice(6)}`;
}

function renderOddsTable() {
  const players = filteredPlayers(state.oddsData?.players || [], state.sortKey, state.sortDir);

  if (!players.length) {
    $("odds-container").innerHTML = empty("No players match the current filter.");
    return;
  }

  const rows = players.map((p, i) => {
    const g = p.tonightGame;
    let gameCell = `<span style="color:var(--text-muted);font-size:11px">—</span>`;
    if (g) {
      const ha = g.homeAway === "H" ? "vs" : "@";
      const time = formatTime(g.startTimeUTC);
      gameCell = `<div style="display:flex;flex-direction:column;gap:2px">
        <span style="font-weight:600;color:var(--accent)">${ha} ${g.opponent}</span>
        ${time ? `<span style="font-size:10px;color:var(--text-muted)">${time}</span>` : ""}
      </div>`;
    }
    return `
    <tr data-pid="${p.playerId}">
      <td style="color:var(--text-muted);font-weight:700">${i + 1}</td>
      <td>
        <div class="player-cell">
          ${avatarHtml(p.headshot, p.name)}
          <div>
            <div class="name">${p.name}</div>
            <div class="meta">${p.team} · ${p.position}</div>
            ${p.keyFactors?.length ? `<div class="factor-row">${factorBadges(p.keyFactors)}</div>` : ""}
          </div>
        </div>
      </td>
      <td>${gameCell}</td>
      <td>${probBar(p.probability)}</td>
      <td>${oddsHtml(p.americanOdds)}</td>
      <td>${p.decimalOdds?.toFixed(2) || "—"}</td>
      <td>${p.fractionalOdds || "—"}</td>
      <td>${tierBadge(p.tier)}</td>
      <td style="font-weight:700">${p.seasonGoals}</td>
      <td>${p.gamesPlayed}</td>
      <td>${p.seasonGPG?.toFixed(3) || "—"}</td>
      <td style="color:var(--gold);font-weight:700">${p.recentGoals10}</td>
      <td>${p.recentGPG?.toFixed(3) || "—"}</td>
      <td>${p.ixGpg != null ? `<span style="color:var(--accent)">${p.ixGpg.toFixed(3)}</span>` : `<span style="color:var(--text-muted)">—</span>`}</td>
      <td>${p["CF%"] != null ? cfBar(p["CF%"]) : `<span style="color:var(--text-muted)">—</span>`}</td>
      <td>${p["xGF%"] != null ? `<span style="color:${p["xGF%"] >= 50 ? "var(--green)" : "var(--red)"}">${p["xGF%"]}%</span>` : `<span style="color:var(--text-muted)">—</span>`}</td>
    </tr>`;
  }).join("");

  $("odds-container").innerHTML = `
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th data-sort="name">Player</th>
            <th data-sort="isPlayingTonight">Tonight's Game</th>
            <th data-sort="probability">Probability</th>
            <th data-sort="americanOdds">US Odds</th>
            <th data-sort="decimalOdds">Decimal</th>
            <th>Fraction</th>
            <th data-sort="tier">Tier</th>
            <th data-sort="seasonGoals">Goals</th>
            <th data-sort="gamesPlayed">GP</th>
            <th data-sort="seasonGPG">GPG</th>
            <th data-sort="recentGoals10">L10 G</th>
            <th data-sort="recentGPG">L10 GPG</th>
            <th data-sort="ixGpg" title="Individual expected goals per game (MoneyPuck)">ixG/G</th>
            <th data-sort="CF%" title="On-ice Corsi for % — possession quality">CF%</th>
            <th data-sort="xGF%" title="On-ice expected goals for % — shot quality">xGF%</th>
          </tr>
        </thead>
        <tbody id="odds-tbody">${rows}</tbody>
      </table>
    </div>`;

  // Highlight sorted column
  document.querySelectorAll("#odds-container thead th[data-sort]").forEach(th => {
    th.classList.toggle("sorted", th.dataset.sort === state.sortKey);
    th.addEventListener("click", () => sortBy(th.dataset.sort, "odds"));
  });

  document.querySelectorAll("#odds-tbody tr").forEach(tr => {
    tr.addEventListener("click", () => openDetail(+tr.dataset.pid, state.oddsData?.players));
  });
}

// ---------------------------------------------------------------
// Predictions view
// ---------------------------------------------------------------
async function loadPredict() {
  const dateEl      = $("predict-filter-date");
  const rosterEl    = $("predict-filter-roster");
  if (dateEl && !dateEl.value) dateEl.value = todayStr();
  const date        = (dateEl && dateEl.value) || todayStr();
  const fullRoster  = rosterEl ? rosterEl.checked : false;

  $("predict-container").innerHTML = loading(fullRoster
    ? "Loading full rosters + advanced model (first load may take ~15 s)…"
    : "Building game-day predictions…");
  try {
    const res = await fetch(`/api/predict?date=${date}&limit=150&full_roster=${fullRoster}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderPredictions(data);
  } catch (e) {
    $("predict-container").innerHTML = `<div class="loading-wrap" style="color:var(--red)">Error: ${e.message}</div>`;
  }
}

function renderPredictions(data) {
  const allGames     = data.games || [];
  const games        = allGames.filter(g => g.players && g.players.length > 0);
  const emptyGames   = allGames.filter(g => !g.players || g.players.length === 0);

  if (allGames.length === 0) {
    $("predict-container").innerHTML = `
      <div class="loading-wrap" style="flex-direction:column;gap:12px;color:var(--text-muted)">
        <div>📅 No NHL games scheduled for this date.</div>
        <div style="font-size:12px">Try selecting a different date above.</div>
      </div>`;
    return;
  }

  if (!games.length) {
    // Games exist but no players loaded — likely a slow first load or API rate limit
    const gameList = emptyGames.map(g =>
      `<span style="color:var(--accent)">${g.awayTeam} @ ${g.homeTeam}</span>`
    ).join(" · ");
    $("predict-container").innerHTML = `
      <div class="loading-wrap" style="flex-direction:column;gap:12px;color:var(--text-muted)">
        <div>⚠️ Games found but player data could not be loaded.</div>
        <div style="font-size:13px">${gameList}</div>
        <div style="font-size:12px">This can happen on the first load when fetching many gamelogs. Try again.</div>
        <button onclick="loadPredict()" style="padding:6px 16px;background:var(--accent);color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:600">
          🔄 Retry
        </button>
      </div>`;
    return;
  }

  const html = games.map(game => {
    const time     = formatTime(game.startTimeUTC);
    const topCount = data.fullRoster ? 12 : 8;
    const top      = game.players.slice(0, topCount);

    // Game-level context badges
    const homeDR  = game.homeTeamDefenseRank;
    const awayDR  = game.awayTeamDefenseRank;
    const homeSV  = game.homeTeamGoalieSvPct;
    const awaySV  = game.awayTeamGoalieSvPct;

    function defBadge(rank) {
      if (!rank) return "";
      const clr = rank <= 8 ? "var(--red)" : rank >= 24 ? "var(--green)" : "var(--text-muted)";
      return `<span style="color:${clr};font-size:11px" title="Defense rank (1=best)">#${rank} def</span>`;
    }
    function svBadge(sv) {
      if (!sv) return "";
      const clr = sv >= 0.925 ? "var(--red)" : sv <= 0.895 ? "var(--green)" : "var(--text-muted)";
      return `<span style="color:${clr};font-size:11px" title="Goalie save %">${(sv*100).toFixed(1)}% SV</span>`;
    }

    const cards = top.map((p, i) => {
      const mf  = p.modelFactors || {};
      const pct = Math.round(p.probability * 100);
      const clr = probColor(p.probability);

      // xG bar — show alongside probability
      const hasXG = p.ixGpg != null;
      const xgPct = hasXG ? Math.min(Math.round(p.ixGpg * 100), 100) : 0;

      const oppDetail = mf.vsOpponentGPG != null
        ? `<div class="model-row"><span>vs ${game.awayTeam === p.team ? game.homeTeam : game.awayTeam}</span><span>${mf.vsOpponentGPG} GPG (${mf.vsOpponentGames}g)</span></div>` : "";
      const haDetail = mf.homeAwayGPG != null
        ? `<div class="model-row"><span>${p.tonightGame?.homeAway === "H" ? "Home" : "Away"} GPG</span><span>${mf.homeAwayGPG}</span></div>` : "";
      const streakDetail = mf.activeStreak > 0
        ? `<div class="model-row"><span>Streak</span><span style="color:var(--green)">${mf.activeStreak}g 🔥</span></div>` : "";
      const goalieDetail = mf.goalieSvPct != null
        ? `<div class="model-row"><span>Opp Goalie SV%</span><span style="color:${mf.goalieSvPct >= 0.925 ? "var(--red)" : "var(--green)"}">${(mf.goalieSvPct*100).toFixed(1)}%</span></div>` : "";
      const defDetail = mf.defenseRank != null
        ? `<div class="model-row"><span>Opp Defense Rank</span><span>${mf.defenseRank}/32</span></div>` : "";
      const corsiDetail = mf["CF%"] != null
        ? `<div class="model-row"><span>CF% · FF% · xGF%</span><span>${mf["CF%"]} · ${mf["FF%"]} · ${mf["xGF%"]}</span></div>` : "";
      const xgDetail = mf.ixGpg != null
        ? `<div class="model-row"><span>ixG/game</span><span style="color:var(--accent)">${mf.ixGpg}</span></div>` : "";
      const hdDetail = mf.hdRate != null
        ? `<div class="model-row"><span>HD Goals/G</span><span>${(mf.hdRate).toFixed(3)}</span></div>` : "";

      return `
      <div class="predict-card" data-pid="${p.playerId}">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="font-size:16px;font-weight:800;color:var(--text-muted);width:20px;text-align:center">${i + 1}</div>
          ${avatarHtml(p.headshot, p.name)}
          <div style="flex:1;min-width:0">
            <div class="name" style="font-size:14px">${p.name}</div>
            <div class="meta">${p.team} · ${p.position} · ${p.seasonGoals}G</div>
            ${p.keyFactors?.length ? `<div class="factor-row">${factorBadges(p.keyFactors)}</div>` : ""}
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-size:20px;font-weight:800;color:${clr}">${pct}%</div>
            <div style="font-size:12px;color:var(--text-muted)">${oddsHtml(p.americanOdds)}</div>
            <div style="margin-top:3px">${tierBadge(p.tier)}</div>
          </div>
        </div>
        <div style="margin-top:8px">${probBar(p.probability)}</div>
        ${hasXG ? `
        <div style="margin-top:4px;display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;color:var(--text-muted);width:40px">ixG/G</span>
          <div style="flex:1;background:var(--bg-secondary);border-radius:4px;height:4px">
            <div style="width:${xgPct}%;background:var(--accent);border-radius:4px;height:4px"></div>
          </div>
          <span style="font-size:11px;color:var(--accent)">${p.ixGpg.toFixed(3)}</span>
        </div>` : ""}
        <div class="model-breakdown">
          ${mf.source === "moneypuck" ?
            `<div class="model-row" style="color:var(--accent);font-size:10px;margin-bottom:2px"><span>🔬 MoneyPuck xG Model</span><span></span></div>`
            : `<div class="model-row" style="color:var(--text-muted);font-size:10px;margin-bottom:2px"><span>📊 Gamelog Model</span><span></span></div>`
          }
          ${xgDetail}${hdDetail}
          <div class="model-row"><span>Season GPG</span><span>${mf.seasonGPG}</span></div>
          <div class="model-row"><span>Recent GPG (L10)</span><span>${mf.recentGPG}</span></div>
          ${corsiDetail}${oppDetail}${haDetail}${goalieDetail}${defDetail}${streakDetail}
          ${situationBars(mf)}
          <div class="model-row" style="border-top:1px solid var(--border);padding-top:6px;margin-top:4px;font-weight:700">
            <span>λ (Exp Goals)</span><span style="color:var(--gold)">${mf.lambda}</span>
          </div>
        </div>
      </div>`;
    }).join("");

    // Game header with defense & goalie context
    const awayCtx = `${defBadge(awayDR)} ${svBadge(awaySV)}`;
    const homeCtx = `${defBadge(homeDR)} ${svBadge(homeSV)}`;

    return `
    <div class="card" style="margin-bottom:24px">
      <div class="card-title" style="font-size:18px;justify-content:space-between;flex-wrap:wrap;gap:6px">
        <span>
          🏒 <span style="color:var(--text-secondary)">${game.awayTeam}</span>
          <span style="display:inline-flex;gap:4px;font-size:11px;vertical-align:middle;margin-left:4px">${awayCtx}</span>
          <span style="color:var(--text-muted);font-size:14px"> @ </span>
          <span style="color:var(--text-secondary)">${game.homeTeam}</span>
          <span style="display:inline-flex;gap:4px;font-size:11px;vertical-align:middle;margin-left:4px">${homeCtx}</span>
        </span>
        ${time ? `<span style="font-size:12px;color:var(--text-muted);font-weight:400">${time}</span>` : ""}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">
        ${cards}
      </div>
    </div>`;
  }).join("");

  $("predict-container").innerHTML = html;

  document.querySelectorAll(".predict-card[data-pid]").forEach(el => {
    el.addEventListener("click", () => openDetail(+el.dataset.pid, []));
    el.style.cursor = "pointer";
  });
}

// ---------------------------------------------------------------
// Scorers view
// ---------------------------------------------------------------
async function loadScorers() {
  $("scorers-container").innerHTML = loading("Fetching season goal leaders…");
  try {
    const res = await fetch("/api/scorers?limit=100");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.scorersData = await res.json();
    renderScorersTable();
  } catch (e) {
    $("scorers-container").innerHTML = `<div class="loading-wrap" style="color:var(--red)">
      Error: ${e.message}</div>`;
  }
}

function renderScorersTable() {
  const players = filteredPlayers(state.scorersData?.players || [], state.sortKey, state.sortDir);

  if (!players.length) {
    $("scorers-container").innerHTML = empty("No players match.");
    return;
  }

  const rows = players.map((p, i) => `
    <tr data-pid="${p.playerId}">
      <td style="color:var(--text-muted);font-weight:700">${i + 1}</td>
      <td>
        <div class="player-cell">
          ${avatarHtml(p.headshot, p.name)}
          <div>
            <div class="name">${p.name}</div>
            <div class="meta">#${p.number || "—"} · ${p.position}</div>
          </div>
        </div>
      </td>
      <td><span class="badge-team">${p.team}</span></td>
      <td style="font-size:20px;font-weight:800;color:var(--gold)">${p.goals}</td>
      <td>${p.gamesPlayed}</td>
      <td>${(p.goals / (p.gamesPlayed || 1)).toFixed(3)}</td>
    </tr>`).join("");

  $("scorers-container").innerHTML = `
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th data-sort="name">Player</th>
            <th data-sort="team">Team</th>
            <th data-sort="goals">Goals</th>
            <th data-sort="gamesPlayed">GP</th>
            <th data-sort="gpg">GPG</th>
          </tr>
        </thead>
        <tbody id="scorers-tbody">${rows}</tbody>
      </table>
    </div>`;

  document.querySelectorAll("#scorers-container thead th[data-sort]").forEach(th => {
    th.classList.toggle("sorted", th.dataset.sort === state.sortKey);
    th.addEventListener("click", () => sortBy(th.dataset.sort, "scorers"));
  });

  document.querySelectorAll("#scorers-tbody tr").forEach(tr => {
    tr.addEventListener("click", () => openDetail(+tr.dataset.pid, state.scorersData?.players));
  });
}

// ---------------------------------------------------------------
// Sorting / Filtering
// ---------------------------------------------------------------
function sortBy(key, view) {
  if (state.sortKey === key) {
    state.sortDir *= -1;
  } else {
    state.sortKey = key;
    state.sortDir = -1;
  }
  if (view === "odds") renderOddsTable();
  else renderScorersTable();
}

function filteredPlayers(players, sortKey, sortDir) {
  let list = [...players];

  const name = state.nameFilter.toLowerCase();
  const team = state.teamFilter.toUpperCase();
  const pos  = state.posFilter;

  if (name) list = list.filter(p => p.name?.toLowerCase().includes(name));
  if (team) list = list.filter(p => p.team === team);
  if (pos)  list = list.filter(p => p.position === pos);

  // Game-day filters (odds view only)
  if (state.tonightOnly) list = list.filter(p => p.isPlayingTonight);
  if (state.gameFilter) {
    const [away, home] = state.gameFilter.split(":");
    list = list.filter(p => p.team === away || p.team === home);
  }

  list.sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === "string") av = av.toLowerCase();
    if (typeof bv === "string") bv = bv.toLowerCase();
    if (av < bv) return sortDir;
    if (av > bv) return -sortDir;
    return 0;
  });

  return list;
}

// ---------------------------------------------------------------
// Filter bar wiring
// ---------------------------------------------------------------
function wireFilters(view) {
  const nameEl = $(`${view}-filter-name`);
  const teamEl = $(`${view}-filter-team`);
  const posEl  = $(`${view}-filter-pos`);

  if (nameEl) nameEl.addEventListener("input", e => {
    state.nameFilter = e.target.value;
    view === "odds" ? renderOddsTable() : renderScorersTable();
  });
  if (teamEl) teamEl.addEventListener("change", e => {
    state.teamFilter = e.target.value;
    view === "odds" ? renderOddsTable() : renderScorersTable();
  });
  if (posEl) posEl.addEventListener("change", e => {
    state.posFilter = e.target.value;
    view === "odds" ? renderOddsTable() : renderScorersTable();
  });
}

// Wire odds-only game-day controls
function wireGameDayFilters() {
  const dateEl       = $("odds-filter-date");
  const gameEl       = $("odds-filter-game");
  const tonightEl    = $("odds-filter-tonight");
  const fullRosterEl = $("odds-filter-fullroster");

  // Set date input to today
  if (dateEl) {
    dateEl.value = todayStr();
    dateEl.addEventListener("change", e => {
      state.dateFilter = e.target.value;
      state.gameFilter = "";
      if (gameEl) gameEl.value = "";
      state.oddsData = null;
      loadOdds();
    });
  }

  if (gameEl) {
    gameEl.addEventListener("change", e => {
      state.gameFilter = e.target.value;
      // Selecting a specific game auto-enables tonight-only filter
      if (e.target.value && tonightEl) {
        state.tonightOnly = true;
        tonightEl.checked = true;
      }
      renderOddsTable();
    });
  }

  if (tonightEl) {
    tonightEl.addEventListener("change", e => {
      state.tonightOnly = e.target.checked;
      if (!e.target.checked && gameEl) {
        state.gameFilter = "";
        gameEl.value = "";
      }
      renderOddsTable();
    });
  }

  if (fullRosterEl) {
    fullRosterEl.addEventListener("change", e => {
      state.fullRosterOdds = e.target.checked;
      // Full roster mode implies tonight-only — enable it automatically
      if (e.target.checked && tonightEl) {
        state.tonightOnly = true;
        tonightEl.checked = true;
      }
      state.oddsData = null;
      loadOdds();
    });
  }
}

wireFilters("odds");
wireFilters("scorers");
wireGameDayFilters();

// Predict controls
const predictDateEl   = $("predict-filter-date");
const predictRosterEl = $("predict-filter-roster");
if (predictDateEl)   predictDateEl.addEventListener("change",   () => loadPredict());
if (predictRosterEl) predictRosterEl.addEventListener("change", () => loadPredict());

// ---------------------------------------------------------------
// Player Detail Panel
// ---------------------------------------------------------------
async function openDetail(playerId, playerList) {
  if (!playerId) return;

  // Find basic info from existing list
  const basic = (playerList || []).find(p => p.playerId === playerId) || {};

  // Show panel immediately with skeleton
  panel.innerHTML = `
    <div class="detail-header">
      ${avatarHtml(basic.headshot, basic.name)}
      <div>
        <div class="player-name">${basic.name || "Loading…"}</div>
        <div class="player-meta">${basic.team || ""} · ${basic.position || ""}</div>
      </div>
      <button class="close-btn" id="close-detail">✕</button>
    </div>
    <div class="detail-body">${loading("Loading player data…")}</div>`;

  panel.classList.add("open");
  overlay.classList.add("active");
  document.body.style.overflow = "hidden";

  $("close-detail").addEventListener("click", closeDetail);

  try {
    const [info, gamelog] = await Promise.all([
      fetch(`/api/player/${playerId}`).then(r => r.json()),
      fetch(`/api/player/${playerId}/gamelog`).then(r => r.json()),
    ]);

    // Fetch all detail tabs + advanced stats concurrently
    const [vsTeams, streaks, shotQuality, advStats] = await Promise.all([
      fetch(`/api/player/${playerId}/vs-teams`).then(r => r.json()),
      fetch(`/api/player/${playerId}/streaks`).then(r => r.json()),
      fetch(`/api/player/${playerId}/shot-quality`).then(r => r.json()),
      fetch(`/api/advanced-stats/${playerId}`).then(r => r.json()).catch(() => ({})),
    ]);

    renderDetailPanel(playerId, basic, info, gamelog, vsTeams, streaks, shotQuality, advStats);
  } catch (e) {
    const body = panel.querySelector(".detail-body");
    if (body) body.innerHTML = `<div style="color:var(--red);padding:20px">Error: ${e.message}</div>`;
  }
}

function closeDetail() {
  panel.classList.remove("open");
  overlay.classList.remove("active");
  document.body.style.overflow = "";
  // Destroy charts to free memory
  Object.values(state.charts).forEach(c => c.destroy());
  state.charts = {};
}

overlay.addEventListener("click", closeDetail);

function renderDetailPanel(pid, basic, info, gamelogData, vsTeamsData, streaks, shotQuality, advStats) {
  const games = gamelogData.games || [];
  const probability = basic.probability || 0;
  const lam = basic.expectedGoals || 0;

  panel.innerHTML = `
    <div class="detail-header">
      ${avatarHtml(info.headshot || basic.headshot, info.name || basic.name)}
      <div>
        <div class="player-name">${info.name || basic.name}</div>
        <div class="player-meta">
          ${info.team || basic.team}
          · ${info.position || basic.position}
          · #${info.seasonStats?.sweaterNumber || "—"}
          ${streaks.active_streak > 1 ? `<span class="streak-fire"> 🔥 ${streaks.active_streak}-game streak</span>` : ""}
        </div>
      </div>
      <button class="close-btn" id="close-detail">✕</button>
    </div>
    <div class="detail-body">

      <!-- Odds summary -->
      <div class="card">
        <div class="card-title">⚡ Anytime Goal Odds</div>
        <div class="stat-grid">
          <div class="stat-box">
            <div class="val">${Math.round(probability * 100)}%</div>
            <div class="lbl">Probability</div>
          </div>
          <div class="stat-box">
            <div class="val" style="color:${probability >= 0.5 ? 'var(--red)' : 'var(--green)'}">${basic.americanOdds || "—"}</div>
            <div class="lbl">US Odds</div>
          </div>
          <div class="stat-box">
            <div class="val">${basic.decimalOdds || "—"}</div>
            <div class="lbl">Decimal</div>
          </div>
          <div class="stat-box">
            <div class="val">${basic.fractionalOdds || "—"}</div>
            <div class="lbl">Fractional</div>
          </div>
          <div class="stat-box">
            <div class="val">${lam.toFixed(3)}</div>
            <div class="lbl">Exp. Goals (λ)</div>
          </div>
          <div class="stat-box">
            <div class="val">${tierBadge(OddsCalculator_tier(probability))}</div>
            <div class="lbl">Tier</div>
          </div>
        </div>
      </div>

      <!-- Tabs -->
      <div class="tabs">
        <button class="tab-btn active" data-tab="overview">Overview</button>
        <button class="tab-btn" data-tab="advanced">📐 Advanced</button>
        <button class="tab-btn" data-tab="vs-teams">Vs Teams</button>
        <button class="tab-btn" data-tab="vs-goalies">Vs Goalies</button>
        <button class="tab-btn" data-tab="streaks">Streaks</button>
        <button class="tab-btn" data-tab="shot-quality">Shot Quality</button>
        <button class="tab-btn" data-tab="gamelog">Game Log</button>
      </div>

      <div id="tab-content">
        ${renderOverviewTab(info, shotQuality, games)}
      </div>

    </div>`;

  $("close-detail").addEventListener("click", closeDetail);

  // Tab wiring
  panel.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      panel.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      const tc = $("tab-content");

      if (tab === "overview")     tc.innerHTML = renderOverviewTab(info, shotQuality, games);
      if (tab === "advanced")     tc.innerHTML = renderAdvancedTab(advStats, basic);
      if (tab === "vs-teams")     tc.innerHTML = renderVsTeamsTab(vsTeamsData.vsTeams || []);
      if (tab === "streaks")      tc.innerHTML = renderStreaksTab(streaks);
      if (tab === "shot-quality") tc.innerHTML = renderShotQualityTab(shotQuality);
      if (tab === "gamelog")      tc.innerHTML = renderGamelogTab(games);
      if (tab === "vs-goalies") {
        tc.innerHTML = loading("Fetching goalie data (may take a moment)…");
        try {
          const gd = await fetch(`/api/player/${pid}/vs-goalies`).then(r => r.json());
          tc.innerHTML = renderVsGoaliesTab(gd.vsGoalies || []);
        } catch (e) {
          tc.innerHTML = `<div style="color:var(--red)">Error: ${e.message}</div>`;
        }
      }

      // Render charts after DOM update
      requestAnimationFrame(() => renderCharts(tab, shotQuality, streaks));
    });
  });

  requestAnimationFrame(() => renderCharts("overview", shotQuality, streaks));
}

function OddsCalculator_tier(prob) {
  if (prob >= 0.55) return "elite";
  if (prob >= 0.40) return "strong";
  if (prob >= 0.28) return "moderate";
  if (prob >= 0.18) return "low";
  return "longshot";
}

// ---------------------------------------------------------------
// Tab renderers
// ---------------------------------------------------------------
function renderAdvancedTab(advStats, basic) {
  const mp  = advStats?.moneypuck || {};
  const sit = advStats?.situationSplits || {};
  const ev  = mp.ev  || {};
  const pp  = mp.pp  || {};

  if (!mp.ixG && !sit.goals) {
    return `<div class="loading-wrap" style="color:var(--text-muted)">
      No MoneyPuck data available for this player this season.</div>`;
  }

  function statRow(label, val, desc, color) {
    if (val == null || val === "") return "";
    return `<div class="model-row" style="padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--text-muted)">${label}
        ${desc ? `<span style="font-size:10px;color:var(--text-muted);display:block">${desc}</span>` : ""}
      </span>
      <span style="font-weight:700;color:${color || "var(--text-primary)"}">${val}</span>
    </div>`;
  }

  function cfGauge(pct, label) {
    if (pct == null) return "";
    const clr = pct >= 55 ? "var(--green)" : pct >= 50 ? "var(--accent)" : pct >= 45 ? "var(--text-muted)" : "var(--red)";
    const barW = Math.round(pct);
    return `
      <div style="margin:8px 0">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
          <span style="color:var(--text-muted)">${label}</span>
          <span style="font-weight:700;color:${clr}">${pct}%</span>
        </div>
        <div style="position:relative;background:var(--bg-secondary);border-radius:4px;height:8px">
          <div style="position:absolute;left:50%;height:100%;width:2px;background:var(--border);z-index:1"></div>
          <div style="width:${barW}%;background:${clr};border-radius:4px;height:8px"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:2px">
          <span>0%</span><span>50% (avg)</span><span>100%</span>
        </div>
      </div>`;
  }

  const ppGoalPct = sit.ppGoalPct ? `${sit.ppGoalPct}%` : null;
  const evGoalPct = sit.evGoalPct ? `${sit.evGoalPct}%` : null;

  return `
    <div class="card">
      <div class="card-title">🔬 Individual xG (MoneyPuck)</div>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="val" style="color:var(--accent)">${mp.ixG ?? "—"}</div>
          <div class="lbl">Total ixG</div>
        </div>
        <div class="stat-box">
          <div class="val" style="color:var(--accent)">${mp.ixGpg?.toFixed(3) ?? "—"}</div>
          <div class="lbl">ixG/Game</div>
        </div>
        <div class="stat-box">
          <div class="val">${mp.ixGp60?.toFixed(2) ?? "—"}</div>
          <div class="lbl">ixG/60</div>
        </div>
        <div class="stat-box">
          <div class="val" style="color:var(--gold)">${mp.iHDGoals ?? "—"}</div>
          <div class="lbl">HD Goals</div>
        </div>
        <div class="stat-box">
          <div class="val">${mp.iHDxG?.toFixed(2) ?? "—"}</div>
          <div class="lbl">HD xG</div>
        </div>
        <div class="stat-box">
          <div class="val">${mp["iHDSh%"] != null ? mp["iHDSh%"] + "%" : "—"}</div>
          <div class="lbl">HD Sh%</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">📊 Corsi, Fenwick & Possession</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
        On-ice stats (with the player on the ice). 50% = league average.
        CF% counts all shot attempts; FF% excludes blocked shots; xGF% weights by shot quality.
      </p>
      ${cfGauge(mp["CF%"],   "Corsi For % (all shot attempts)")}
      ${cfGauge(mp["FF%"],   "Fenwick For % (unblocked attempts)")}
      ${cfGauge(mp["xGF%"],  "Expected Goals For % (shot quality)")}
      ${cfGauge(mp["HDCF%"], "High Danger Corsi For %")}
      <div style="margin-top:12px">
        ${statRow("iCorsi (shot attempts)", mp.iCorsi, "Total individual shot attempts this season")}
        ${statRow("iFenwick (unblocked)", mp.iFenwick, "Unblocked shot attempts")}
        ${statRow("iCorsi/60", mp.iCorsip60?.toFixed(1), "Pace-adjusted shot attempts per 60 min")}
        ${statRow("Avg TOI/Game", mp.icetimePG ? mp.icetimePG + " min" : null, "Average ice time per game")}
      </div>
    </div>

    <div class="card">
      <div class="card-title">🎯 Situation Splits (PP vs EV)</div>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="val" style="color:var(--gold)">${sit.goals ?? "—"}</div>
          <div class="lbl">Total Goals</div>
        </div>
        <div class="stat-box">
          <div class="val">${sit.evGoals ?? "—"}</div>
          <div class="lbl">EV Goals <span style="font-size:10px">(${evGoalPct ?? "—"})</span></div>
        </div>
        <div class="stat-box">
          <div class="val" style="color:var(--gold)">${sit.ppGoals ?? "—"}</div>
          <div class="lbl">PP Goals <span style="font-size:10px">(${ppGoalPct ?? "—"})</span></div>
        </div>
        <div class="stat-box">
          <div class="val">${sit.ppPoints ?? "—"}</div>
          <div class="lbl">PP Points</div>
        </div>
      </div>
      ${sit.ppGoals != null ? `
      <div style="margin-top:12px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Goals by situation</div>
        <div style="display:flex;height:20px;border-radius:6px;overflow:hidden;gap:2px">
          <div style="background:var(--accent);flex:${sit.evGoals || 0};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">
            ${sit.evGoals > 0 ? `EV ${sit.evGoals}` : ""}
          </div>
          <div style="background:var(--gold);flex:${sit.ppGoals || 0};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#000">
            ${sit.ppGoals > 0 ? `PP ${sit.ppGoals}` : ""}
          </div>
          ${sit.shGoals > 0 ? `<div style="background:var(--green);flex:${sit.shGoals};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">SH ${sit.shGoals}</div>` : ""}
        </div>
      </div>` : ""}
      ${pp.ixGpg ? `
      <div style="margin-top:12px">
        ${statRow("PP ixG/Game", pp.ixGpg?.toFixed(3), "Individual xG per game on the power play", "var(--gold)")}
        ${statRow("PP iCorsi/60", pp.iCorsip60?.toFixed(1), "Shot attempts per 60 on the power play")}
        ${statRow("EV ixG/Game", ev.ixGpg?.toFixed(3), "Individual xG per game at even strength", "var(--accent)")}
      </div>` : ""}
    </div>`;
}

function renderOverviewTab(info, sq, games) {
  const cs = info.seasonStats || {};
  return `
    <div class="stat-grid">
      <div class="stat-box"><div class="val" style="color:var(--gold)">${cs.goals ?? sq.goals ?? "—"}</div><div class="lbl">Goals</div></div>
      <div class="stat-box"><div class="val">${cs.assists ?? "—"}</div><div class="lbl">Assists</div></div>
      <div class="stat-box"><div class="val">${cs.points ?? "—"}</div><div class="lbl">Points</div></div>
      <div class="stat-box"><div class="val">${cs.gamesPlayed ?? sq.games ?? "—"}</div><div class="lbl">GP</div></div>
      <div class="stat-box"><div class="val">${sq.shotsPerGame ?? "—"}</div><div class="lbl">Shots/G</div></div>
      <div class="stat-box"><div class="val">${sq.shootingPct ?? "—"}%</div><div class="lbl">S%</div></div>
      <div class="stat-box"><div class="val">${sq.ppGoals ?? "—"}</div><div class="lbl">PP Goals</div></div>
      <div class="stat-box"><div class="val">${sq.gameWinningGoals ?? "—"}</div><div class="lbl">GWG</div></div>
    </div>
    <div class="card">
      <div class="card-title">📊 Goals by Month</div>
      <div class="chart-wrap"><canvas id="chart-monthly"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">📋 Bio</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
        ${bioRow("Shoots", info.shootsCatches)}
        ${bioRow("Born", info.birthDate)}
        ${bioRow("Birthplace", [info.birthCity, info.nationality].filter(Boolean).join(", "))}
        ${bioRow("Height", info.heightInInches ? `${Math.floor(info.heightInInches/12)}′${info.heightInInches%12}″` : null)}
        ${bioRow("Weight", info.weightInPounds ? `${info.weightInPounds} lbs` : null)}
        ${bioRow("Draft", formatDraft(info.draftDetails))}
      </div>
    </div>`;
}

function bioRow(label, val) {
  if (!val) return "";
  return `<div><span style="color:var(--text-muted)">${label}:</span> ${val}</div>`;
}

function formatDraft(d) {
  if (!d || !d.year) return null;
  return `${d.year} Rd ${d.round} #${d.pickInRound} (${d.teamAbbrev || ""})`;
}

function renderVsTeamsTab(vsTeams) {
  if (!vsTeams.length) return empty("No data available.");
  const rows = vsTeams.map(t => `
    <tr>
      <td><span class="badge-team">${t.team}</span></td>
      <td style="font-weight:700;color:var(--gold)">${t.goals}</td>
      <td>${t.assists}</td>
      <td>${t.points}</td>
      <td>${t.games}</td>
      <td>${t.goalsPerGame}</td>
      <td>${t.shots}</td>
      <td>${t.shootingPct}%</td>
      <td>${t.ppGoals}</td>
    </tr>`).join("");

  return `
    <div class="card">
      <div class="card-title">🏒 Goals vs Each Team</div>
      <div class="tbl-wrap"><table>
        <thead><tr>
          <th>Team</th><th>G</th><th>A</th><th>PTS</th><th>GP</th><th>GPG</th><th>SOG</th><th>S%</th><th>PPG</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}

function renderVsGoaliesTab(vsGoalies) {
  if (!vsGoalies.length) return empty("No goalie data found (player may not have scored yet this season).");
  const rows = vsGoalies.map(g => `
    <tr>
      <td style="font-weight:600">${g.goalie}</td>
      <td><span class="badge-team">${g.team}</span></td>
      <td style="font-weight:700;color:var(--gold)">${g.goals}</td>
      <td>${g.games}</td>
      <td>${g.shots}</td>
      <td>${g.shootingPct}%</td>
    </tr>`).join("");

  return `
    <div class="card">
      <div class="card-title">🥅 Goals vs Each Goalie</div>
      <div class="tbl-wrap"><table>
        <thead><tr>
          <th>Goalie</th><th>Team</th><th>G</th><th>Games</th><th>SOG</th><th>S%</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}

function renderStreaksTab(s) {
  const monthly = (s.monthly || []).map(m => `
    <tr>
      <td>${m.month}</td>
      <td style="font-weight:700;color:var(--gold)">${m.goals}</td>
      <td>${m.games}</td>
      <td>${(m.goals / (m.games || 1)).toFixed(2)}</td>
    </tr>`).join("");

  const streakRows = (s.streaks || []).slice(0, 8).map(st => `
    <tr>
      <td style="font-weight:700;color:${st.active ? 'var(--green)' : 'var(--text-primary)'}">${st.length} games${st.active ? " 🔥" : ""}</td>
      <td style="color:var(--gold)">${st.goals}</td>
      <td>${st.start}</td>
      <td>${st.end}</td>
    </tr>`).join("");

  return `
    <div class="stat-grid" style="margin-bottom:16px">
      <div class="stat-box">
        <div class="val" style="color:var(--green)">${s.active_streak}</div>
        <div class="lbl">Active Streak</div>
      </div>
      <div class="stat-box">
        <div class="val" style="color:var(--gold)">${s.longest_streak}</div>
        <div class="lbl">Longest Streak</div>
      </div>
      <div class="stat-box">
        <div class="val" style="color:var(--red)">${s.longest_slump}</div>
        <div class="lbl">Longest Slump</div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">🔥 Goal Streaks</div>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Streak</th><th>Goals</th><th>Start</th><th>End</th></tr></thead>
        <tbody>${streakRows || "<tr><td colspan=4 style='color:var(--text-muted);padding:12px'>No streaks yet</td></tr>"}</tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="card-title">📅 Monthly Breakdown</div>
      <div class="chart-wrap"><canvas id="chart-streak-monthly"></canvas></div>
      <div class="tbl-wrap" style="margin-top:12px"><table>
        <thead><tr><th>Month</th><th>Goals</th><th>GP</th><th>GPG</th></tr></thead>
        <tbody>${monthly}</tbody>
      </table></div>
    </div>`;
}

function renderShotQualityTab(sq) {
  if (!sq || !sq.games) return empty("No shot data available.");
  return `
    <div class="stat-grid">
      <div class="stat-box"><div class="val">${sq.shotsPerGame}</div><div class="lbl">Shots/Game</div></div>
      <div class="stat-box"><div class="val" style="color:var(--gold)">${sq.shootingPct}%</div><div class="lbl">Shooting %</div></div>
      <div class="stat-box"><div class="val">${sq.recentGoals10}</div><div class="lbl">Goals (L10)</div></div>
      <div class="stat-box"><div class="val">${sq.recentShootingPct}%</div><div class="lbl">S% (L10)</div></div>
      <div class="stat-box"><div class="val" style="color:var(--green)">${sq.homeGPG}</div><div class="lbl">Home GPG</div></div>
      <div class="stat-box"><div class="val" style="color:var(--accent)">${sq.awayGPG}</div><div class="lbl">Away GPG</div></div>
      <div class="stat-box"><div class="val">${sq.ppGoalPct}%</div><div class="lbl">PP Goal %</div></div>
      <div class="stat-box"><div class="val">${sq.multiGoalGames}</div><div class="lbl">Multi-G Games</div></div>
      <div class="stat-box"><div class="val" style="color:var(--gold)">${sq.hatTricks}</div><div class="lbl">Hat Tricks</div></div>
    </div>
    <div class="card">
      <div class="card-title">🏠 Home vs Away Split</div>
      <div class="chart-wrap" style="height:160px"><canvas id="chart-split"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">📈 Shot Distribution (per game)</div>
      <div class="chart-wrap" style="height:180px"><canvas id="chart-shots"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">🥅 Goal Distribution (per game)</div>
      <div class="chart-wrap" style="height:180px"><canvas id="chart-goals"></canvas></div>
    </div>`;
}

function renderGamelogTab(games) {
  if (!games.length) return empty("No games played yet.");
  const sorted = [...games].sort((a, b) => b.gameDate.localeCompare(a.gameDate));
  const rows = sorted.map(g => `
    <tr>
      <td>${g.gameDate}</td>
      <td><span class="badge-team">${g.opponentAbbrev || "—"}</span></td>
      <td style="font-size:11px;color:var(--text-muted)">${g.homeRoadFlag === "H" ? "Home" : "Away"}</td>
      <td style="font-weight:700;color:${g.goals > 0 ? 'var(--gold)' : 'var(--text-primary)'}">${g.goals}</td>
      <td>${g.assists}</td>
      <td>${(g.goals || 0) + (g.assists || 0)}</td>
      <td>${g.shots ?? "—"}</td>
      <td>${g.powerPlayGoals ?? 0}</td>
      <td style="color:${(g.plusMinus || 0) > 0 ? 'var(--green)' : (g.plusMinus || 0) < 0 ? 'var(--red)' : 'var(--text-muted)'}">${g.plusMinus > 0 ? `+${g.plusMinus}` : g.plusMinus ?? "—"}</td>
      <td style="font-size:11px;color:var(--text-muted)">${g.toi || "—"}</td>
    </tr>`).join("");

  return `
    <div class="card">
      <div class="card-title">📋 Full Game Log (${games.length} games)</div>
      <div class="tbl-wrap"><table>
        <thead><tr>
          <th>Date</th><th>Opp</th><th>H/A</th><th>G</th><th>A</th><th>PTS</th><th>SOG</th><th>PPG</th><th>+/-</th><th>TOI</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}

// ---------------------------------------------------------------
// Charts (Chart.js)
// ---------------------------------------------------------------
function renderCharts(tab, sq, streaks) {
  if (tab === "overview" || tab === "streaks") {
    const monthly = streaks?.monthly || [];
    const canvasId = tab === "overview" ? "chart-monthly" : "chart-streak-monthly";
    const el = $(canvasId);
    if (el && monthly.length) {
      if (state.charts[canvasId]) state.charts[canvasId].destroy();
      state.charts[canvasId] = new Chart(el, {
        type: "bar",
        data: {
          labels: monthly.map(m => m.month),
          datasets: [{
            label: "Goals",
            data: monthly.map(m => m.goals),
            backgroundColor: "#f59e0b",
            borderRadius: 4,
          }],
        },
        options: chartOpts("Goals per Month"),
      });
    }
  }

  if (tab === "shot-quality" && sq) {
    // Home/Away bar
    const splitEl = $("chart-split");
    if (splitEl) {
      if (state.charts["chart-split"]) state.charts["chart-split"].destroy();
      state.charts["chart-split"] = new Chart(splitEl, {
        type: "bar",
        data: {
          labels: ["Home", "Away"],
          datasets: [{
            label: "Goals",
            data: [sq.homeGoals, sq.awayGoals],
            backgroundColor: ["#22c55e", "#3b82f6"],
            borderRadius: 4,
          }, {
            label: "Games",
            data: [sq.homeGames, sq.awayGames],
            backgroundColor: ["#166534", "#1e40af"],
            borderRadius: 4,
          }],
        },
        options: chartOpts("Home vs Away"),
      });
    }

    // Shot dist
    const shotEl = $("chart-shots");
    if (shotEl && sq.shotDist) {
      if (state.charts["chart-shots"]) state.charts["chart-shots"].destroy();
      const d = sq.shotDist;
      state.charts["chart-shots"] = new Chart(shotEl, {
        type: "doughnut",
        data: {
          labels: ["0 shots", "1 shot", "2 shots", "3+ shots"],
          datasets: [{
            data: [d["0"], d["1"], d["2"], d["3+"]],
            backgroundColor: ["#334155", "#1d4ed8", "#0891b2", "#f59e0b"],
            borderWidth: 0,
          }],
        },
        options: doughnutOpts(),
      });
    }

    // Goal dist
    const goalEl = $("chart-goals");
    if (goalEl && sq.goalDist) {
      if (state.charts["chart-goals"]) state.charts["chart-goals"].destroy();
      const d = sq.goalDist;
      state.charts["chart-goals"] = new Chart(goalEl, {
        type: "doughnut",
        data: {
          labels: ["0 goals", "1 goal", "2 goals", "3+ goals"],
          datasets: [{
            data: [d["0"], d["1"], d["2"], d["3+"]],
            backgroundColor: ["#334155", "#22c55e", "#f59e0b", "#ef4444"],
            borderWidth: 0,
          }],
        },
        options: doughnutOpts(),
      });
    }
  }
}

function chartOpts(title) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: { display: false },
    },
    scales: {
      x: { ticks: { color: "#64748b", font: { size: 10 } }, grid: { color: "#1e293b" } },
      y: { ticks: { color: "#64748b", font: { size: 10 } }, grid: { color: "#1e293b" }, beginAtZero: true },
    },
  };
}

function doughnutOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: "right", labels: { color: "#94a3b8", font: { size: 11 }, boxWidth: 12 } },
    },
  };
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
showView("odds");
