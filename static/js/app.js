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
  if (name === "results")                       loadResultsTab();
  if (name === "parlays")                       loadParlays();
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
  if (!odds || odds === "N/A" || odds === "—") return `<span class="text-muted">—</span>`;
  const cls = String(odds).startsWith("+") ? "odds-pos" : "odds-neg";
  return `<span class="${cls}">${odds}</span>`;
}

function valueBadge(val) {
  if (!val) return `<span style="color:var(--text-muted);font-size:11px">—</span>`;
  const colors = { A: "#4ade80", B: "#34d399", C: "#fbbf24", D: "#94a3b8", F: "#f87171" };
  const clr = colors[val.grade] || "#94a3b8";
  const sign = val.edgePct >= 0 ? "+" : "";
  return `<span style="color:${clr};font-weight:700;font-size:12px" title="${val.label} (model ${sign}${val.edgePct}% vs book)">${val.label}</span>`;
}

function lineBadge(lineInfo) {
  if (!lineInfo) return "";
  const colors = { 1: "var(--green)", 2: "var(--accent)", 3: "var(--text-muted)", 4: "var(--text-muted)" };
  const clr = colors[lineInfo.lineNum] || "var(--text-muted)";
  return `<span style="color:${clr};font-size:10px;font-weight:600;margin-left:4px">${lineInfo.lineLabel}</span>`;
}

function cfBar(cfPct) {
  const pct  = Math.round(cfPct);
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
  const players   = filteredPlayers(state.oddsData?.players || [], state.sortKey, state.sortDir);
  const hasSbOdds = state.oddsData?.hasSbOdds;

  if (!players.length) {
    $("odds-container").innerHTML = empty("No players match the current filter.");
    return;
  }

  const rows = players.map((p, i) => {
    const g = p.tonightGame;
    let gameCell = `<span style="color:var(--text-muted);font-size:11px">—</span>`;
    if (g) {
      const ha   = g.homeAway === "H" ? "vs" : "@";
      const time = formatTime(g.startTimeUTC);
      gameCell = `<div style="display:flex;flex-direction:column;gap:2px">
        <span style="font-weight:600;color:var(--accent)">${ha} ${g.opponent}</span>
        ${time ? `<span style="font-size:10px;color:var(--text-muted)">${time}</span>` : ""}
      </div>`;
    }

    // Value columns (only shown when sportsbook key is configured)
    const bookOddsCell = hasSbOdds
      ? `<td title="${p.bookName || ""}">${oddsHtml(p.bookOdds)}</td>`
      : "";
    const bookProbCell = hasSbOdds
      ? `<td>${p.bookImplied != null ? `<span style="color:var(--text-muted)">${Math.round(p.bookImplied * 100)}%</span>` : "—"}</td>`
      : "";
    const valueCell = hasSbOdds
      ? `<td>${valueBadge(p.value)}</td>`
      : "";

    return `
    <tr data-pid="${p.playerId}">
      <td style="color:var(--text-muted);font-weight:700">${i + 1}</td>
      <td>
        <div class="player-cell">
          ${avatarHtml(p.headshot, p.name)}
          <div>
            <div class="name">${p.name}${lineBadge(p.lineInfo)}</div>
            <div class="meta">${p.team} · ${p.position}</div>
            ${p.keyFactors?.length ? `<div class="factor-row">${factorBadges(p.keyFactors)}</div>` : ""}
          </div>
        </div>
      </td>
      <td>${gameCell}</td>
      <td>${probBar(p.probability)}</td>
      <td>${oddsHtml(p.americanOdds)}</td>
      ${bookOddsCell}
      ${bookProbCell}
      ${valueCell}
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

  // Dynamic headers based on whether sportsbook odds are available
  const bookHeaders = hasSbOdds ? `
    <th data-sort="bookOdds" title="Best sportsbook odds for anytime goal">Book Odds</th>
    <th data-sort="bookImplied" title="Implied probability from best available odds">Book %</th>
    <th data-sort="value.edge" title="Model probability minus book implied probability — positive = value">Value</th>
  ` : "";

  $("odds-container").innerHTML = `
    ${!hasSbOdds ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;padding:8px;background:var(--bg-secondary);border-radius:6px;border:1px solid var(--border)">
      💡 Set <code>ODDS_API_KEY</code> env var (<a href="https://the-odds-api.com" target="_blank" style="color:var(--accent)">the-odds-api.com</a> — free tier) to unlock Book Odds &amp; Value columns.
    </div>` : ""}
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th data-sort="name">Player</th>
            <th data-sort="isPlayingTonight">Tonight's Game</th>
            <th data-sort="probability">Model %</th>
            <th data-sort="americanOdds">Fair Odds</th>
            ${bookHeaders}
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
  // Default full_roster to true — we always want comprehensive coverage
  const fullRoster  = rosterEl ? rosterEl.checked : true;

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

function expandGame(away, home, btn) {
  const grid = document.querySelector(`.predict-cards-${away}-${home}`);
  if (!grid) return;
  try {
    const players = JSON.parse(btn.getAttribute("data-all") || "[]");
    const extraCards = players.map((p, i) => {
      const pct = Math.round((p.probability || 0) * 100);
      return `
        <div class="predict-card">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:14px;font-weight:700;color:var(--text-muted);width:20px;text-align:center">${10 + i + 1}</div>
            <div style="flex:1;min-width:0">
              <div class="name" style="font-size:13px">${p.name}${lineBadge(p.lineInfo)}</div>
              <div class="meta">${p.team} · ${p.position} · ${p.seasonGoals || 0}G</div>
              ${p.keyFactors?.length ? `<div class="factor-row">${factorBadges(p.keyFactors)}</div>` : ""}
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:17px;font-weight:800;color:${probColor(p.probability || 0)}">${pct}%</div>
              <div style="font-size:12px;color:var(--text-muted)">${p.americanOdds || ""}</div>
              <div style="margin-top:3px">${tierBadge(p.tier)}</div>
            </div>
          </div>
        </div>`;
    }).join("");
    grid.insertAdjacentHTML("beforeend", extraCards);
    btn.parentElement.remove();
  } catch (_) {
    btn.textContent = "Failed to expand";
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

  const hasSbOdds = data.hasSbOdds;

  const html = games.map(game => {
    const time     = formatTime(game.startTimeUTC);
    // Always show top 10 per game by default; user can expand to see the rest
    const top10    = game.players.slice(0, 10);
    const top      = top10;

    const homeDR = game.homeTeamDefenseRank;
    const awayDR = game.awayTeamDefenseRank;
    const homeSV = game.homeTeamGoalieSvPct;
    const awaySV = game.awayTeamGoalieSvPct;

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

      // Sportsbook vs model comparison panel
      let sbPanel = "";
      if (hasSbOdds && p.bookOdds) {
        const val = p.value;
        const valColors = { A: "#4ade80", B: "#34d399", C: "#fbbf24", D: "#94a3b8", F: "#f87171" };
        const valClr = val ? (valColors[val.grade] || "#94a3b8") : "#94a3b8";
        const sign   = val && val.edgePct >= 0 ? "+" : "";
        sbPanel = `
          <div style="background:var(--bg-secondary);border-radius:6px;padding:8px;margin-top:6px;border:1px solid var(--border)">
            <div style="font-size:10px;color:var(--text-muted);margin-bottom:6px;font-weight:600">📊 BOOK vs MODEL</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center">
              <div>
                <div style="font-size:15px;font-weight:800;color:var(--gold)">${oddsHtml(p.bookOdds)}</div>
                <div style="font-size:10px;color:var(--text-muted)">Book (${p.bookName || "—"})</div>
                <div style="font-size:11px;color:var(--text-muted)">${p.bookImplied != null ? Math.round(p.bookImplied*100)+"%" : "—"} implied</div>
              </div>
              <div>
                <div style="font-size:15px;font-weight:800;color:var(--accent)">${oddsHtml(p.americanOdds)}</div>
                <div style="font-size:10px;color:var(--text-muted)">Our Model</div>
                <div style="font-size:11px;color:var(--text-muted)">${pct}% fair odds</div>
              </div>
              <div>
                <div style="font-size:15px;font-weight:800;color:${valClr}">${val ? val.label : "—"}</div>
                <div style="font-size:10px;color:var(--text-muted)">Value</div>
                <div style="font-size:11px;color:${valClr}">${val ? sign+val.edgePct+"%" : ""}</div>
              </div>
            </div>
          </div>`;
      }

      return `
      <div class="predict-card" data-pid="${p.playerId}">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="font-size:16px;font-weight:800;color:var(--text-muted);width:20px;text-align:center">${i + 1}</div>
          ${avatarHtml(p.headshot, p.name)}
          <div style="flex:1;min-width:0">
            <div class="name" style="font-size:14px">${p.name}${lineBadge(p.lineInfo)}</div>
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
        ${sbPanel}
        <div class="model-breakdown">
          ${mf.source === "moneypuck" ?
            `<div class="model-row" style="color:var(--accent);font-size:10px;margin-bottom:2px"><span>🔬 MoneyPuck xG v4</span><span></span></div>`
            : `<div class="model-row" style="color:var(--text-muted);font-size:10px;margin-bottom:2px"><span>📊 Gamelog Model v4</span><span></span></div>`
          }
          ${xgDetail}${hdDetail}
          ${mf.icetimePG != null ? `<div class="model-row"><span>Avg TOI/G</span><span>${mf.icetimePG?.toFixed(1) ?? "—"} min</span></div>` : ""}
          ${mf.ppIxGpg != null ? `<div class="model-row"><span>PP ixG/G</span><span style="color:var(--gold)">${mf.ppIxGpg}</span></div>` : ""}
          <div class="model-row"><span>Season GPG</span><span>${mf.seasonGPG}</span></div>
          <div class="model-row"><span>Recent GPG (exp-wtd)</span><span>${mf.recentGPG}</span></div>
          ${mf.shootingPct != null ? `<div class="model-row"><span>Sh% (capped 18%)</span><span>${mf.shootingPctCapped ?? mf.shootingPct}%</span></div>` : ""}
          ${corsiDetail}${oppDetail}${haDetail}${goalieDetail}${defDetail}${streakDetail}
          ${mf.eloFactor != null ? `<div class="model-row"><span>Team Elo (${mf.teamElo ?? "—"} vs ${mf.oppElo ?? "—"})</span><span style="color:${mf.eloFactor >= 1.05 ? "var(--green)" : mf.eloFactor <= 0.95 ? "var(--red)" : "var(--text-muted)"}">${mf.eloFactor}×</span></div>` : ""}
          ${mf.lineFactor != null ? `<div class="model-row"><span>Line Position</span><span style="color:${mf.lineFactor >= 1.2 ? "var(--green)" : mf.lineFactor <= 0.8 ? "var(--red)" : "var(--text-muted)"}">${mf.lineFactor}×</span></div>` : ""}
          ${situationBars(mf)}
          <div class="model-row" style="border-top:1px solid var(--border);padding-top:6px;margin-top:4px;font-weight:700">
            <span>λ (Exp Goals)</span><span style="color:var(--gold)">${mf.lambda}</span>
          </div>
        </div>
      </div>`;
    }).join("");

    // Longshot pick card
    let longshotCard = "";
    if (game.longshot) {
      const ls = game.longshot;
      const lsPct = Math.round((ls.probability || 0) * 100);
      longshotCard = `
        <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
          <div style="font-size:11px;font-weight:700;color:var(--gold);letter-spacing:0.05em;margin-bottom:8px">🎲 LONGSHOT PICK</div>
          <div class="predict-card" data-pid="${ls.playerId}" style="border:1px solid rgba(245,158,11,0.3);background:rgba(245,158,11,0.04)">
            <div style="display:flex;align-items:center;gap:10px">
              ${avatarHtml(ls.headshot, ls.name)}
              <div style="flex:1;min-width:0">
                <div class="name" style="font-size:13px">${ls.name}${lineBadge(ls.lineInfo)}</div>
                <div class="meta">${ls.team} · ${ls.position} · ${ls.seasonGoals || 0}G</div>
                ${ls.keyFactors?.length ? `<div class="factor-row">${factorBadges(ls.keyFactors)}</div>` : ""}
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:18px;font-weight:800;color:var(--gold)">${lsPct}%</div>
                <div style="font-size:12px;color:var(--text-muted)">${oddsHtml(ls.americanOdds)}</div>
                <div style="margin-top:3px">${tierBadge(ls.tier)}</div>
              </div>
            </div>
            <div style="margin-top:6px">${probBar(ls.probability)}</div>
          </div>
        </div>`;
    }

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
      <div class="predict-cards-${game.awayTeam}-${game.homeTeam}" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">
        ${cards}
      </div>
      ${game.players.length > 10 ? `
      <div style="text-align:center;margin-top:10px">
        <button class="btn" style="font-size:12px;padding:5px 16px"
          onclick="expandGame('${game.awayTeam}','${game.homeTeam}',this)"
          data-all='${JSON.stringify(game.players.slice(10).map(p => ({
            name:p.name, team:p.team, position:p.position, probability:p.probability,
            tier:p.tier, seasonGoals:p.seasonGoals, americanOdds:p.americanOdds,
            lineInfo:p.lineInfo, keyFactors:p.keyFactors
          })))}'>
          ▼ Show ${game.players.length - 10} more players
        </button>
      </div>` : ""}
      ${longshotCard}
    </div>`;
  }).join("");

  $("predict-container").innerHTML = html;

  // Show/hide sportsbook setup note
  const sbNote = $("predict-sb-note");
  if (sbNote) sbNote.style.display = hasSbOdds ? "none" : "";


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
    // Support nested sort keys like "value.edge"
    let av, bv;
    if (sortKey.includes(".")) {
      const [parent, child] = sortKey.split(".");
      av = a[parent]?.[child];
      bv = b[parent]?.[child];
    } else {
      av = a[sortKey];
      bv = b[sortKey];
    }
    // Null/undefined sorts last
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
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
// Results tab
// ---------------------------------------------------------------

async function loadResultsTab() {
  const rc = $("results-container");
  rc.innerHTML = loading("Loading results…");

  // Fetch saved prediction dates
  let savedDates = [];
  try {
    const res = await fetch("/api/results/dates");
    if (res.ok) {
      const j = await res.json();
      savedDates = j.dates || [];
    }
  } catch (_) {}

  // Populate history dropdown
  const sel = $("results-filter-history");
  if (sel) {
    while (sel.options.length > 1) sel.remove(1);
    for (const d of savedDates) {
      const opt = document.createElement("option");
      opt.value = d; opt.textContent = d;
      sel.appendChild(opt);
    }
  }

  // Pick which date to show: respect manual date input, else most recent saved, else today
  const dateEl = $("results-filter-date");
  let date = (dateEl && dateEl.value) || "";
  if (!date) date = savedDates.length ? savedDates[0] : todayStr();
  if (dateEl && !dateEl.value) dateEl.value = date;
  if (sel && savedDates.includes(date)) sel.value = date;

  await loadResults(date);
}

async function loadResults(date) {
  const rc = $("results-container");
  rc.innerHTML = loading("Loading results for " + date + "…");
  try {
    const res = await fetch(`/api/results/${date}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    renderResults(data);
  } catch (e) {
    rc.innerHTML = `
      <div class="card" style="text-align:center;padding:32px">
        <div style="font-size:24px;margin-bottom:8px">⚠️</div>
        <div style="color:var(--red);font-weight:600">Could not load results</div>
        <div style="color:var(--text-muted);font-size:12px;margin-top:4px">${e.message}</div>
        <button class="btn" style="margin-top:16px" onclick="loadResults('${date}')">Retry</button>
      </div>`;
  }
}

function renderResults(data) {
  const rc = $("results-container");
  const statusEl = $("results-status");

  // Update status bar
  if (statusEl) {
    statusEl.textContent = data.gamesTotal
      ? `${data.gamesFinished}/${data.gamesTotal} games finished`
      : (data.hasPredictions ? "No game data available for this date" : "");
  }

  // ── No data at all ──────────────────────────────────────────────
  if (!data.hasPredictions && (!data.actualScorers || !data.actualScorers.length)) {
    rc.innerHTML = `
      <div class="card" style="text-align:center;padding:40px 24px">
        <div style="font-size:40px;margin-bottom:12px">📋</div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary);margin-bottom:8px">No data for ${data.date || ""}</div>
        <div style="color:var(--text-muted);font-size:13px;max-width:400px;margin:0 auto 20px">
          Predictions are saved automatically when you visit the Predictions tab on a game day.
        </div>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
          <button class="btn" onclick="showView('predict')">🔮 Go to Predictions</button>
          <button class="btn" onclick="loadResults('${todayStr()}')">📅 Try Today</button>
        </div>
      </div>`;
    return;
  }

  // ── Accuracy summary (only when predictions exist) ───────────────
  let summaryHtml = "";
  const acc = data.accuracy || {};
  if (data.hasPredictions && data.predictions && data.predictions.length) {
    const hitRate = Math.round((acc.hitRate || 0) * 100);
    const hitClr  = hitRate >= 40 ? "var(--green)" : hitRate >= 25 ? "var(--gold)" : "var(--text-muted)";
    const t5  = acc.top5  || {};
    const t10 = acc.top10 || {};

    const roiStr = acc.simulatedROI
      ? `<span style="font-size:13px;color:${acc.simulatedROI.unitsNet >= 0 ? "var(--green)" : "var(--red)"}">
           ${acc.simulatedROI.unitsNet >= 0 ? "+" : ""}${acc.simulatedROI.unitsNet}u ROI
         </span>` : "";

    summaryHtml = `
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;align-items:center">
        <div class="card" style="flex:0 0 auto;padding:12px 20px;display:flex;align-items:center;gap:12px">
          <div>
            <div style="font-size:11px;color:var(--text-muted)">Hit Rate</div>
            <div style="font-size:28px;font-weight:800;color:${hitClr};line-height:1">${hitRate}%</div>
            <div style="font-size:11px;color:var(--text-muted)">${acc.totalHits || 0}/${acc.totalPredicted || 0} scored</div>
          </div>
          <div style="border-left:1px solid var(--border);padding-left:12px">
            <div style="font-size:11px;color:var(--text-muted)">Top 5</div>
            <div style="font-size:20px;font-weight:700;color:var(--accent)">${t5.hits || 0}/${t5.total || 0}</div>
          </div>
          <div style="border-left:1px solid var(--border);padding-left:12px">
            <div style="font-size:11px;color:var(--text-muted)">Top 10</div>
            <div style="font-size:20px;font-weight:700;color:var(--accent)">${t10.hits || 0}/${t10.total || 0}</div>
          </div>
          ${roiStr ? `<div style="border-left:1px solid var(--border);padding-left:12px">${roiStr}</div>` : ""}
        </div>
        <div style="font-size:12px;color:var(--text-muted)">
          ${!data.gamesComplete ? "⏳ Games still in progress — results will update" : "✅ All games finished"}
          ${data.savedAt ? `<br>Saved ${new Date(data.savedAt).toLocaleString()}` : ""}
        </div>
      </div>`;
  }

  // ── Main two-panel grid ────────────────────────────────────────────
  // Left: predictions; Right: actual scorers
  let leftHtml = "";
  let rightHtml = "";

  if (data.hasPredictions && data.predictions && data.predictions.length) {
    const rows = data.predictions.map(p => {
      const hit = p.scored;
      return `<tr style="${hit ? "background:rgba(34,197,94,0.07)" : ""}">
        <td style="color:var(--text-muted);font-size:12px">${p.rank}</td>
        <td style="font-size:15px;text-align:center">${hit ? "✅" : "❌"}</td>
        <td>
          <span style="font-weight:600;color:${hit ? "var(--green)" : ""}">${p.name || "—"}</span>
          ${p.actualGoals > 0 ? `<span style="color:var(--green);font-size:11px;margin-left:4px">${p.actualGoals}G</span>` : ""}
          <br><span style="font-size:11px;color:var(--text-muted)">${p.team || ""}</span>
        </td>
        <td style="text-align:right;font-weight:700;color:${probColor(p.probability || 0)}">${Math.round((p.probability || 0)*100)}%</td>
        <td>${tierBadge(p.tier)}</td>
      </tr>`;
    }).join("");

    leftHtml = `
      <div class="card" style="min-width:0">
        <div style="font-size:13px;font-weight:700;margin-bottom:10px">
          🔮 Predictions
          ${!data.gamesComplete ? '<span style="color:var(--gold);font-size:11px;margin-left:6px">⏳</span>' : ""}
        </div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>#</th><th></th><th>Player</th><th style="text-align:right">%</th><th>Tier</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  } else {
    leftHtml = `
      <div class="card" style="min-width:0;display:flex;align-items:center;justify-content:center;padding:32px;flex-direction:column;gap:8px;color:var(--text-muted)">
        <div style="font-size:32px">📋</div>
        <div>No predictions saved for this date</div>
        <button class="btn" style="margin-top:8px" onclick="showView('predict')">Go to Predictions</button>
      </div>`;
  }

  const actualScorers = data.actualScorers || [];
  if (actualScorers.length) {
    const predictedIds = new Set((data.predictions || []).map(p => p.playerId));
    const rows = actualScorers.map(s => {
      const hit = predictedIds.has(s.playerId);
      return `<tr style="${hit ? "background:rgba(34,197,94,0.07)" : ""}">
        <td style="font-weight:600;color:${hit ? "var(--green)" : ""}">${s.name || "—"}${hit ? " <span style='font-size:10px'>✓</span>" : ""}</td>
        <td style="color:var(--text-muted);font-size:12px">${s.team || ""}</td>
        <td style="color:var(--text-muted);font-size:12px">${s.opponent || ""}</td>
        <td style="color:var(--green);font-weight:700">${s.goals}G${s.assists ? `<span style="color:var(--accent);font-weight:400"> ${s.assists}A</span>` : ""}</td>
      </tr>`;
    }).join("");

    rightHtml = `
      <div class="card" style="min-width:0">
        <div style="font-size:13px;font-weight:700;margin-bottom:10px">🥅 Actual Goal Scorers</div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>Player</th><th>Team</th><th>Opp</th><th>Stats</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  } else {
    rightHtml = `
      <div class="card" style="min-width:0;display:flex;align-items:center;justify-content:center;padding:32px;flex-direction:column;gap:8px;color:var(--text-muted)">
        <div style="font-size:32px">🏒</div>
        <div>${data.gamesComplete ? "No goals recorded for this date" : data.gamesTotal ? "Games in progress…" : "No NHL games on this date"}</div>
      </div>`;
  }

  rc.innerHTML = summaryHtml + `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" class="results-grid">
      ${leftHtml}
      ${rightHtml}
    </div>`;

  // Draw calibration chart if available
  if (acc.calibration && acc.calibration.length) {
    const canvas = document.getElementById("calib-chart");
    if (!canvas) return;
    if (typeof Chart === "undefined") return;
    const labels  = acc.calibration.map(b => b.bucket);
    const actuals = acc.calibration.map(b => Math.round(b.hitRate * 100));
    const expects = acc.calibration.map(b => Math.round(b.midProb * 100));
    const prev = state.charts["calib"];
    if (prev) prev.destroy();
    state.charts["calib"] = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Actual hit %", data: actuals, backgroundColor: "rgba(96,165,250,0.7)", borderRadius: 4 },
          { label: "Expected %", data: expects, type: "line", borderColor: "#fbbf24", borderWidth: 2, pointRadius: 3, fill: false },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: "#94a3b8", font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: "#94a3b8" }, grid: { color: "#1e293b" } },
          y: { ticks: { color: "#94a3b8", callback: v => v + "%" }, grid: { color: "#1e293b" }, min: 0, max: 100 },
        },
      },
    });
  }
}

// ---------------------------------------------------------------
// Hero accuracy banner (loaded on startup)
// ---------------------------------------------------------------
async function loadHeroAccuracy() {
  const banner = $("hero-accuracy");
  if (!banner) return;
  try {
    const datesRes = await fetch("/api/results/dates");
    if (!datesRes.ok) return;
    const { dates } = await datesRes.json();
    if (!dates || !dates.length) return;

    // Use the most recent date that has a completed-game result
    const date = dates[0];
    const res  = await fetch(`/api/results/${date}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.hasPredictions || !data.accuracy || !data.accuracy.totalPredicted) return;

    const acc  = data.accuracy;
    const rate = Math.round(acc.hitRate * 100);
    const clr  = rate >= 40 ? "var(--green)" : rate >= 25 ? "var(--gold)" : "var(--text-muted)";
    const t5   = acc.top5  || {};
    const t10  = acc.top10 || {};

    const roiPart = acc.simulatedROI
      ? `<span style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-size:12px;color:${acc.simulatedROI.unitsNet >= 0 ? "var(--green)" : "var(--red)"}">
          Sim ROI ${acc.simulatedROI.unitsNet >= 0 ? "+" : ""}${acc.simulatedROI.unitsNet}u
         </span>`
      : "";

    banner.innerHTML = `
      <span style="font-size:11px;color:var(--text-muted)">Last night (${date}):</span>
      <span style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-size:12px">
        Hit rate <strong style="color:${clr}">${rate}%</strong>
        <span style="color:var(--text-muted);margin-left:4px">(${acc.totalHits}/${acc.totalPredicted})</span>
      </span>
      <span style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-size:12px;color:var(--text-muted)">
        Top 5: <strong style="color:var(--accent)">${t5.hits || 0}/${t5.total || 0}</strong>
      </span>
      <span style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:20px;padding:4px 12px;font-size:12px;color:var(--text-muted)">
        Top 10: <strong style="color:var(--accent)">${t10.hits || 0}/${t10.total || 0}</strong>
      </span>
      ${roiPart}
      <a href="#" onclick="showView('results');return false" style="font-size:12px;color:var(--accent);text-decoration:none">→ Full results</a>`;
    banner.style.display = "flex";
  } catch (_) {}
}

loadHeroAccuracy();

// Wire Results tab controls
const resultsDateEl    = $("results-filter-date");
const resultsHistoryEl = $("results-filter-history");

if (resultsDateEl) {
  resultsDateEl.addEventListener("change", e => {
    if (resultsHistoryEl) resultsHistoryEl.value = "";
    loadResults(e.target.value);
  });
}
if (resultsHistoryEl) {
  resultsHistoryEl.addEventListener("change", e => {
    const d = e.target.value;
    if (!d) return;
    if (resultsDateEl) resultsDateEl.value = d;
    loadResults(d);
  });
}

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
// Parlays tab
// ---------------------------------------------------------------

// Wire parlays controls
const parlaysDateEl    = $("parlays-filter-date");
const parlaysRefreshBtn = $("parlays-refresh-btn");
if (parlaysDateEl) parlaysDateEl.addEventListener("change", () => loadParlays());
if (parlaysRefreshBtn) parlaysRefreshBtn.addEventListener("click", () => loadParlays(true));

async function loadParlays(regenerate = false) {
  const dateEl = $("parlays-filter-date");
  if (dateEl && !dateEl.value) dateEl.value = todayStr();
  const date = (dateEl && dateEl.value) || todayStr();

  $("parlays-container").innerHTML = loading("Fetching predictions to build parlays…");
  try {
    const res = await fetch(`/api/predict?date=${date}&full_roster=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderParlays(data, regenerate);
  } catch (e) {
    $("parlays-container").innerHTML = `
      <div class="card" style="text-align:center;padding:32px">
        <div style="font-size:24px;margin-bottom:8px">⚠️</div>
        <div style="color:var(--red);font-weight:600">Could not build parlays</div>
        <div style="color:var(--text-muted);font-size:12px;margin-top:4px">${e.message}</div>
        <button class="btn" style="margin-top:16px" onclick="loadParlays()">Retry</button>
      </div>`;
  }
}

function decimalOdds(prob) {
  if (!prob || prob <= 0 || prob >= 1) return null;
  return 1 / prob;
}

function formatParleyOdds(decOdds) {
  if (!decOdds) return "—";
  const american = decOdds >= 2
    ? `+${Math.round((decOdds - 1) * 100)}`
    : `-${Math.round(100 / (decOdds - 1))}`;
  return { decimal: decOdds.toFixed(2), american };
}

function buildParlay(legs) {
  // legs: array of player objects
  const totalDec = legs.reduce((acc, p) => acc * (decimalOdds(p.probability) || 1), 1);
  const totalProb = legs.reduce((acc, p) => acc * (p.probability || 0), 1);
  return { legs, totalDec, totalProb };
}

function renderParlays(data, regenerate = false) {
  const games = (data.games || []).filter(g => g.players && g.players.length > 0);

  if (!games.length) {
    $("parlays-container").innerHTML = `
      <div class="card" style="text-align:center;padding:40px">
        <div style="font-size:32px;margin-bottom:12px">📅</div>
        <div style="font-weight:700;color:var(--text-primary)">No games with predictions found</div>
        <div style="color:var(--text-muted);font-size:13px;margin-top:8px">
          Visit the <a href="#" onclick="showView('predict');return false" style="color:var(--accent)">Predictions tab</a>
          first to generate today's picks, then come back here.
        </div>
      </div>`;
    return;
  }

  // Flatten all players across all games, keyed by game
  // Each game contributes one player per parlay leg (different games = different legs where possible)
  const allPlayers = games.flatMap(g =>
    g.players.map(p => ({ ...p, gameKey: `${g.awayTeam}@${g.homeTeam}` }))
  );
  const longshotPlayers = games
    .filter(g => g.longshot)
    .map(g => ({ ...g.longshot, gameKey: `${g.awayTeam}@${g.homeTeam}` }));

  // Helper: pick N players from different games, sorted by selector fn
  function pickLegs(pool, n, selectorFn, usedKeys = new Set()) {
    // Group by game, pick best from each game
    const byGame = {};
    for (const p of pool) {
      if (usedKeys.has(p.gameKey)) continue;
      const gk = p.gameKey;
      if (!byGame[gk]) byGame[gk] = [];
      byGame[gk].push(p);
    }
    const gameGroups = Object.values(byGame);
    // Sort each group by selector, pick best from each
    const candidates = gameGroups
      .map(grp => grp.sort(selectorFn)[0])
      .sort(selectorFn)
      .slice(0, n);
    return candidates;
  }

  // Shuffle deterministically per regenerate call (based on current ms)
  const seed = regenerate ? Date.now() : 0;
  function seededShuffle(arr, s) {
    const a = [...arr];
    let rng = s || 12345;
    for (let i = a.length - 1; i > 0; i--) {
      rng = (rng * 1664525 + 1013904223) & 0xffffffff;
      const j = Math.abs(rng) % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const shuffled = seededShuffle(allPlayers, seed);

  // Parlay types
  const parlayTypes = [
    {
      name: "🛡️ Safe Pick",
      desc: "Top-ranked player from each game — highest probability legs",
      color: "#22c55e",
      legs: pickLegs(allPlayers, 4, (a, b) => (b.probability || 0) - (a.probability || 0)),
    },
    {
      name: "💎 Value Play",
      desc: "Players where our model edge vs book is greatest",
      color: "#3b82f6",
      legs: pickLegs(
        allPlayers.filter(p => p.value && p.value.edge > 0),
        4,
        (a, b) => (b.value?.edge || 0) - (a.value?.edge || 0)
      ).concat(
        // If fewer than 4 value plays exist, pad with top players
        pickLegs(allPlayers, 4, (a, b) => (b.probability || 0) - (a.probability || 0))
      ).slice(0, 4),
    },
    {
      name: "⚖️ Balanced",
      desc: "Mix of strong and moderate picks from different games",
      color: "#f59e0b",
      legs: (() => {
        // 2 strong (top picks), 2 moderate (rank 3-5)
        const strong = pickLegs(allPlayers, 2, (a, b) => (b.probability || 0) - (a.probability || 0));
        const usedKeys = new Set(strong.map(p => p.gameKey));
        const moderate = pickLegs(
          allPlayers.filter((p, i) => {
            const gPlayers = games.find(g => `${g.awayTeam}@${g.homeTeam}` === p.gameKey)?.players || [];
            return gPlayers.indexOf(p) >= 2 && gPlayers.indexOf(p) <= 4;
          }),
          2,
          (a, b) => (b.probability || 0) - (a.probability || 0),
          usedKeys
        );
        return [...strong, ...moderate].slice(0, 4);
      })(),
    },
    {
      name: "🎲 Wild Card",
      desc: "Two safe picks + two longshots for bigger upside",
      color: "#a855f7",
      legs: (() => {
        const safe = pickLegs(allPlayers, 2, (a, b) => (b.probability || 0) - (a.probability || 0));
        const usedKeys = new Set(safe.map(p => p.gameKey));
        const longs = pickLegs(
          longshotPlayers.length ? longshotPlayers : shuffled.filter(p => p.probability < 0.20),
          2,
          (a, b) => (b.probability || 0) - (a.probability || 0),
          usedKeys
        );
        return [...safe, ...longs].slice(0, 4);
      })(),
    },
    {
      name: "🚀 Longshot Special",
      desc: "All longshot picks — high risk, high reward",
      color: "#ef4444",
      legs: pickLegs(
        longshotPlayers.length >= 4
          ? longshotPlayers
          : shuffled.filter(p => (p.probability || 0) <= 0.20),
        4,
        (a, b) => (b.probability || 0) - (a.probability || 0)
      ),
    },
  ].filter(pt => pt.legs.length >= 2); // only show parlays with at least 2 legs

  const parlayCards = parlayTypes.map(pt => {
    const parlay = buildParlay(pt.legs);
    const totalDec = parlay.totalDec;
    const totalProb = parlay.totalProb;
    const fmtOdds = formatParleyOdds(totalDec);
    const payout100 = totalDec ? ((totalDec * 100) - 100).toFixed(0) : "—";

    const legRows = pt.legs.map((p, i) => {
      const pct = Math.round((p.probability || 0) * 100);
      const dec = decimalOdds(p.probability);
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;${i < pt.legs.length - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
          <div style="font-size:13px;font-weight:700;color:var(--text-muted);width:18px;text-align:center">${i + 1}</div>
          ${avatarHtml(p.headshot, p.name)}
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px">${p.name}</div>
            <div style="font-size:11px;color:var(--text-muted)">${p.team} · ${p.position}${p.gameKey ? ` · ${p.gameKey.replace('@',' @ ')}` : ''}</div>
            ${p.keyFactors?.length ? `<div class="factor-row" style="margin-top:3px">${factorBadges(p.keyFactors.slice(0,2))}</div>` : ""}
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-size:15px;font-weight:800;color:${probColor(p.probability || 0)}">${pct}%</div>
            <div style="font-size:11px;color:var(--text-muted)">${oddsHtml(p.americanOdds)}</div>
          </div>
        </div>`;
    }).join("");

    return `
    <div class="card" style="margin-bottom:20px;border-left:3px solid ${pt.color}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <div>
          <div style="font-size:16px;font-weight:700;color:${pt.color}">${pt.name}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${pt.desc}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:22px;font-weight:800;color:${pt.color}">${fmtOdds?.american || "—"}</div>
          <div style="font-size:12px;color:var(--text-muted)">${totalDec.toFixed(2)}x · ${(totalProb * 100).toFixed(2)}% prob</div>
          <div style="font-size:11px;color:var(--text-muted)">$100 bet → <strong style="color:${pt.color}">$${payout100}</strong> profit</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:4px">
        ${legRows}
      </div>
      <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text-muted);background:var(--bg-secondary);border-radius:6px;padding:6px 10px">
        <span>${pt.legs.length}-Leg Parlay</span>
        <span>Combined prob: <strong style="color:${pt.color}">${(totalProb * 100).toFixed(2)}%</strong></span>
        <span>Decimal: <strong>${totalDec.toFixed(2)}x</strong></span>
      </div>
    </div>`;
  }).join("");

  $("parlays-container").innerHTML = `
    <div style="margin-bottom:16px;padding:10px 14px;background:var(--bg-secondary);border-radius:8px;border:1px solid var(--border);font-size:12px;color:var(--text-muted)">
      💡 Parlays are based on tonight's model predictions. Odds shown are model-derived (not sportsbook).
      Hit <strong style="color:var(--text-primary)">🎲 Regenerate</strong> to shuffle alternate picks.
      Always verify with your sportsbook before placing bets.
    </div>
    ${parlayCards || '<div class="card" style="text-align:center;padding:32px;color:var(--text-muted)">Not enough players with predictions to build parlays. Try loading full rosters in the Predictions tab first.</div>'}`;

  // Wire click-through to player detail
  $("parlays-container").querySelectorAll(".predict-card[data-pid], [data-pid]").forEach(el => {
    if (el.dataset.pid) {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => openDetail(+el.dataset.pid, []));
    }
  });
}

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
showView("odds");
