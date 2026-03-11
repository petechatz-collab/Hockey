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
  loadingDetail: false,
  charts: {},
};

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

  if (name === "odds" && !state.oddsData)     loadOdds();
  if (name === "scorers" && !state.scorersData) loadScorers();
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
// Odds view
// ---------------------------------------------------------------
async function loadOdds() {
  $("odds-container").innerHTML = loading("Fetching goal scorer odds…");
  try {
    const res = await fetch("/api/odds?limit=80");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.oddsData = await res.json();
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

  const rows = players.map((p, i) => `
    <tr data-pid="${p.playerId}">
      <td style="color:var(--text-muted);font-weight:700">${i + 1}</td>
      <td>
        <div class="player-cell">
          ${avatarHtml(p.headshot, p.name)}
          <div>
            <div class="name">${p.name}</div>
            <div class="meta">${p.team} · ${p.position}</div>
          </div>
        </div>
      </td>
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
    </tr>`).join("");

  $("odds-container").innerHTML = `
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th data-sort="name">Player</th>
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

wireFilters("odds");
wireFilters("scorers");

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

    // Fetch all detail tabs concurrently
    const [vsTeams, streaks, shotQuality] = await Promise.all([
      fetch(`/api/player/${playerId}/vs-teams`).then(r => r.json()),
      fetch(`/api/player/${playerId}/streaks`).then(r => r.json()),
      fetch(`/api/player/${playerId}/shot-quality`).then(r => r.json()),
    ]);

    renderDetailPanel(playerId, basic, info, gamelog, vsTeams, streaks, shotQuality);
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

function renderDetailPanel(pid, basic, info, gamelogData, vsTeamsData, streaks, shotQuality) {
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
