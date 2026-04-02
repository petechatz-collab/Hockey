"""
NHL Goal Scorer Tracker — FastAPI backend.

Run:
    uvicorn main:app --reload --port 8000

Data sources:
  • NHL Stats API  (api-web.nhle.com/v1)  — schedule, rosters, gamelogs, standings, goalie stats
  • MoneyPuck      (moneypuck.com)        — xG, Corsi, Fenwick, situational rates
  • The Odds API   (the-odds-api.com)     — sportsbook player props (set ODDS_API_KEY env var)

Line estimation:
    When MoneyPuck ice-time data is available, forwards are ranked within their
    position (L/C/R) by average TOI per game to produce approximate line numbers
    (1–4).  Defensemen are paired by TOI into pairs 1–3.  This is an approximation
    — actual line assignments may differ from morning skate.
"""

import asyncio
import os
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from moneypuck_client import MoneyPuckClient
from nhl_api import NHLClient
from odds import OddsCalculator
from results_store import compute_accuracy, list_saved_dates, load_predictions, save_predictions
from sportsbook_client import SportsbookClient

app = FastAPI(title="NHL Goal Scorer Tracker", version="3.0.0")

client  = NHLClient()
mp      = MoneyPuckClient()
calc    = OddsCalculator()
sbook   = SportsbookClient()

# ------------------------------------------------------------------
# Static files / SPA
# ------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", include_in_schema=False)
async def root():
    return FileResponse("static/index.html")


# ------------------------------------------------------------------
# Shared helpers
# ------------------------------------------------------------------

def _player_name(p: dict) -> str:
    fn = p.get("firstName", {})
    ln = p.get("lastName", {})
    if isinstance(fn, dict):
        fn = fn.get("default", "")
    if isinstance(ln, dict):
        ln = ln.get("default", "")
    return f"{fn} {ln}".strip()


def _get_pid(player: dict) -> Optional[int]:
    """Defensively extract player ID — handles 'id' or 'playerId' field."""
    pid = player.get("id") or player.get("playerId") or player.get("player_id")
    try:
        return int(pid) if pid else None
    except (TypeError, ValueError):
        return None


def _build_team_game_map(schedule: list) -> dict:
    tm: dict = {}
    for game in schedule:
        tm[game["homeTeam"]] = {**game, "homeAway": "H", "opponent": game["awayTeam"]}
        tm[game["awayTeam"]] = {**game, "homeAway": "A", "opponent": game["homeTeam"]}
    return tm


async def _fetch_context(date: Optional[str]):
    """
    Concurrently fetch MoneyPuck stats, defense ranks, and goalie save pcts.
    Returns (mp_stats_dict, defense_ranks, goalie_pcts) — all graceful on failure.
    """
    async def safe_mp():
        try:
            all_s, ev_s, pp_s = await mp.get_all_situations()
            return {"all": all_s, "ev": ev_s, "pp": pp_s}
        except Exception:
            return {}

    async def safe_defense():
        try:
            return await client.get_defense_ranks()
        except Exception:
            return {}

    async def safe_goalies():
        try:
            return await client.get_goalie_save_pcts()
        except Exception:
            return {}

    return await asyncio.gather(safe_mp(), safe_defense(), safe_goalies())


# ------------------------------------------------------------------
# Line estimation from MoneyPuck ice-time
# ------------------------------------------------------------------

def _estimate_lines(
    team_players: List[dict],
    mp_all_map: Dict[int, dict],
) -> Dict[int, Dict]:
    """
    Given a list of player dicts (with playerId, position) and a MoneyPuck
    all-situation stats map, return {playerId: {lineNum, lineLabel}}.

    Forwards are bucketed by position (L/C/R) and ranked by icetimePG.
    Defensemen are ranked overall by icetimePG.
    """
    result: Dict[int, Dict] = {}

    fwd_by_pos: Dict[str, List] = {"L": [], "C": [], "R": []}
    dmen: List = []

    for p in team_players:
        pid  = p.get("playerId") or p.get("id")
        pos  = (p.get("position") or p.get("positionCode") or "").upper()
        toi  = (mp_all_map.get(pid) or {}).get("icetimePG", 0)
        entry = {"pid": pid, "toi": toi}

        if pos in fwd_by_pos:
            fwd_by_pos[pos].append(entry)
        elif pos == "D":
            dmen.append(entry)

    # Rank forwards within each slot by TOI descending → line 1, 2, 3, 4
    for pos_list in fwd_by_pos.values():
        pos_list.sort(key=lambda x: x["toi"], reverse=True)
        for rank, entry in enumerate(pos_list, start=1):
            line_num = min(rank, 4)
            suffix = {1: "st", 2: "nd", 3: "rd"}.get(line_num, "th")
            result[entry["pid"]] = {
                "lineNum":   line_num,
                "lineLabel": f"{line_num}{suffix} Line",
            }

    # Rank defensemen by TOI → pair 1, 2, 3
    dmen.sort(key=lambda x: x["toi"], reverse=True)
    for rank, entry in enumerate(dmen, start=1):
        pair_num = min((rank + 1) // 2, 3)   # two per pair
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(pair_num, "th")
        result[entry["pid"]] = {
            "lineNum":   pair_num,
            "lineLabel": f"{pair_num}{suffix} Pair",
        }

    return result


# ------------------------------------------------------------------
# Sportsbook value calculation
# ------------------------------------------------------------------

def _calc_value(model_prob: float, book_implied: Optional[float]) -> Optional[Dict]:
    """
    Compare model probability to sportsbook implied probability.
    Returns a value dict or None if book odds unavailable.
    """
    if book_implied is None or book_implied <= 0:
        return None
    edge = round(model_prob - book_implied, 4)
    edge_pct = round(edge * 100, 1)

    if edge >= 0.08:
        label, grade = "Strong Value", "A"
    elif edge >= 0.04:
        label, grade = "Value", "B"
    elif edge >= 0.01:
        label, grade = "Slight Value", "C"
    elif edge >= -0.02:
        label, grade = "Fair", "D"
    else:
        label, grade = "Fade", "F"

    return {
        "edge":     edge,
        "edgePct":  edge_pct,
        "label":    label,
        "grade":    grade,
    }


# ------------------------------------------------------------------
# Common player enrichment (shared between /api/odds and /api/predict)
# ------------------------------------------------------------------

async def _enrich_players(
    players_raw: List[dict],
    team_game: dict,
    mp_stats: dict,
    defense_ranks: dict,
    goalie_pcts: dict,
    sb_props: dict,
    game_date: Optional[str],
    concurrency: int = 30,
) -> List[dict]:
    """
    For each raw player dict: fetch gamelog, compute odds, attach sportsbook props.
    Uses a semaphore to bound concurrent NHL API calls.
    """
    mp_all_map = (mp_stats or {}).get("all", {})
    semaphore  = asyncio.Semaphore(concurrency)

    async def enrich(player: dict) -> Optional[dict]:
        pid = _get_pid(player)
        if not pid:
            return None

        async with semaphore:
            try:
                gamelog = await client.get_player_gamelog(pid)
            except Exception:
                gamelog = []

        team      = player.get("teamAbbrev", "")
        game_info = team_game.get(team)

        # Build display name
        if "name" in player and player["name"]:
            name = player["name"]
        else:
            fn = player.get("firstName", "")
            ln = player.get("lastName", "")
            if isinstance(fn, dict):
                fn = fn.get("default", "")
            if isinstance(ln, dict):
                ln = ln.get("default", "")
            name = f"{fn} {ln}".strip() or _player_name(player)

        return {
            "playerId":         pid,
            "name":             name,
            "team":             team,
            "position":         player.get("positionCode") or player.get("position", ""),
            "headshot":         player.get("headshot", ""),
            "seasonGoals":      player.get("goals", 0),
            "gamesPlayed":      player.get("gamesPlayed", 0),
            "gamelog":          gamelog,
            "tonightGame":      game_info,
            "isPlayingTonight": game_info is not None,
        }

    results = await asyncio.gather(*[enrich(p) for p in players_raw])
    enriched = [r for r in results if r]

    # Rank by the Poisson model
    ranked = calc.rank_players(
        enriched,
        mp_stats      = mp_stats,
        defense_ranks = defense_ranks,
        goalie_pcts   = goalie_pcts,
        game_date     = game_date,
    )

    # Estimate line numbers for all enriched players (grouped by team)
    team_buckets: Dict[str, List] = {}
    for r in ranked:
        t = r.get("team", "")
        team_buckets.setdefault(t, []).append(r)

    line_map: Dict[int, Dict] = {}
    for t, tplayers in team_buckets.items():
        line_map.update(_estimate_lines(tplayers, mp_all_map))

    # Attach tier, line info, and sportsbook value to every ranked player
    for r in ranked:
        r["tier"] = OddsCalculator.tier(r["probability"])

        pid = r.get("playerId")
        r["lineInfo"] = line_map.get(pid)

        # Sportsbook odds + value
        sb = sbook.match_player(r.get("name", ""), sb_props)
        if sb:
            r["bookOdds"]     = sb.get("bestOddsStr")
            r["bookImplied"]  = sb.get("impliedProb")
            r["bookName"]     = sb.get("bestBook")
            r["bookOddsAll"]  = sb.get("books", {})
            r["value"]        = _calc_value(r["probability"], sb.get("impliedProb"))
        else:
            r["bookOdds"]     = None
            r["bookImplied"]  = None
            r["bookName"]     = None
            r["bookOddsAll"]  = {}
            r["value"]        = None

    return ranked


# ------------------------------------------------------------------
# /api/schedule
# ------------------------------------------------------------------

@app.get("/api/schedule")
async def get_schedule(date: str = Query(None)):
    """NHL games for a given date (YYYY-MM-DD). Defaults to today."""
    resolved_date = date or datetime.now().strftime("%Y-%m-%d")
    games = await client.get_schedule(resolved_date)
    return {"date": resolved_date, "games": games}


# ------------------------------------------------------------------
# /api/odds  — ranked anytime goal scorer odds
# ------------------------------------------------------------------

@app.get("/api/odds")
async def get_odds(
    limit:       int  = Query(60, ge=1, le=100),
    date:        str  = Query(None),
    full_roster: bool = Query(False),
):
    """
    Goal scorers ranked by anytime-goal probability.
    full_roster=true fetches every skater on tonight's teams.
    Includes sportsbook odds and value ratings when ODDS_API_KEY is set.
    """
    schedule, context, sb_props = await asyncio.gather(
        client.get_schedule(date),
        _fetch_context(date),
        sbook.get_player_props(date),
    )
    mp_stats, defense_ranks, goalie_pcts = context
    team_game = _build_team_game_map(schedule)

    if full_roster and schedule:
        playing_teams = list(
            set(g["homeTeam"] for g in schedule) |
            set(g["awayTeam"] for g in schedule)
        )

        async def safe_roster(team: str):
            try:
                return team, await client.get_team_roster(team)
            except Exception:
                return team, {}

        roster_results = await asyncio.gather(*[safe_roster(t) for t in playing_teams])
        roster_map     = {team: data for team, data in roster_results}

        mp_all_map_odds = (mp_stats or {}).get("all", {})
        _MIN_TOI_ODDS   = 5.5

        players_raw: List[dict] = []
        for team, roster in roster_map.items():
            for group in ("forwards", "defensemen"):
                for p in roster.get(group, []):
                    pid = p.get("id") or p.get("playerId")
                    if pid and mp_all_map_odds:
                        toi = (mp_all_map_odds.get(pid) or {}).get("icetimePG", 99)
                        if toi < _MIN_TOI_ODDS:
                            continue
                    players_raw.append({**p, "teamAbbrev": team})
    else:
        leaders     = await client.get_goal_leaders(limit=limit)
        players_raw = leaders

    ranked = await _enrich_players(
        players_raw, team_game, mp_stats, defense_ranks, goalie_pcts,
        sb_props, date,
    )

    return {
        "season":       client.current_season(),
        "date":         date or datetime.now().strftime("%Y-%m-%d"),
        "fullRoster":   full_roster,
        "hasSbOdds":    bool(sbook.api_key),
        "games":        schedule,
        "players":      ranked,
    }


# ------------------------------------------------------------------
# /api/predict  — game-grouped predictions for a given date
# ------------------------------------------------------------------

@app.get("/api/predict")
async def get_predict(
    date:        str  = Query(None),
    limit:       int  = Query(100, ge=1, le=200),
    full_roster: bool = Query(False),
):
    """
    Tonight's games with predicted goal scorers, advanced stats, book odds,
    value ratings, and estimated line numbers.
    full_roster=true includes every skater on playing teams.
    """
    schedule, context, sb_props = await asyncio.gather(
        client.get_schedule(date),
        _fetch_context(date),
        sbook.get_player_props(date),
    )
    mp_stats, defense_ranks, goalie_pcts = context

    if not schedule:
        return {
            "date":       date or datetime.now().strftime("%Y-%m-%d"),
            "hasSbOdds":  bool(sbook.api_key),
            "games":      [],
        }

    team_game = _build_team_game_map(schedule)

    # Always fetch full rosters for all playing teams so every skater is ranked.
    # To keep API calls manageable, we use MoneyPuck ice-time data to skip very
    # low-usage players (<6 min avg) who have essentially no scoring chance.
    playing_teams = list(
        set(g["homeTeam"] for g in schedule) |
        set(g["awayTeam"] for g in schedule)
    )

    async def safe_roster(team: str):
        try:
            return team, await client.get_team_roster(team)
        except Exception:
            return team, {}

    roster_results = await asyncio.gather(*[safe_roster(t) for t in playing_teams])
    roster_map     = {team: data for team, data in roster_results}

    mp_all_map = (mp_stats or {}).get("all", {})
    _MIN_ICETIME = 5.5  # minutes per game — skip true 4th-line grinders

    players_raw: List[dict] = []
    for team, roster in roster_map.items():
        for group in ("forwards", "defensemen"):
            for p in roster.get(group, []):
                pid = p.get("id") or p.get("playerId")
                # Skip players with very low ice time (likely healthy scratches or
                # 13th-forward types) to keep API load reasonable
                if pid and mp_all_map:
                    toi = (mp_all_map.get(pid) or {}).get("icetimePG", 99)
                    if toi < _MIN_ICETIME:
                        continue
                players_raw.append({**p, "teamAbbrev": team})

    # If not using full_roster mode AND the goal-leaders list was requested,
    # fall back to goal-leaders (faster for default quick view)
    if not full_roster and not players_raw:
        leaders     = await client.get_goal_leaders(limit=limit)
        players_raw = [p for p in leaders if p.get("teamAbbrev", "") in team_game]

    ranked = await _enrich_players(
        players_raw, team_game, mp_stats, defense_ranks, goalie_pcts,
        sb_props, date, concurrency=40,
    )

    # Group by matchup
    game_map: dict = {}
    for game in schedule:
        key = f"{game['awayTeam']}:{game['homeTeam']}"
        game_map[key] = {**game, "players": []}

    for r in ranked:
        g   = r.get("tonightGame") or {}
        key = f"{g.get('awayTeam', '')}:{g.get('homeTeam', '')}"
        if key in game_map:
            game_map[key]["players"].append(r)

    # Attach defense/goalie context per game
    for game in game_map.values():
        for side in ("homeTeam", "awayTeam"):
            t = game.get(side, "")
            game[f"{side}DefenseRank"] = (defense_ranks or {}).get(t, {}).get("defenseRank")
            g_info = (goalie_pcts or {}).get("byTeam", {}).get(t, {})
            game[f"{side}GoalieSvPct"] = g_info.get("svPct")

    result_date = date or datetime.now().strftime("%Y-%m-%d")

    # Auto-save predictions to disk for later accuracy tracking
    all_ranked: List[dict] = []
    for game in game_map.values():
        all_ranked.extend(game.get("players", []))
    if all_ranked:
        try:
            save_predictions(result_date, all_ranked, full_roster=full_roster)
        except Exception:
            pass

    return {
        "date":       result_date,
        "fullRoster": full_roster,
        "hasSbOdds":  bool(sbook.api_key),
        "games":      list(game_map.values()),
    }


# ------------------------------------------------------------------
# /api/sportsbook  — raw book odds for tonight's players
# ------------------------------------------------------------------

@app.get("/api/sportsbook")
async def get_sportsbook(date: str = Query(None)):
    """
    Raw sportsbook player props from The Odds API.
    Returns {} and hasSbOdds=false when ODDS_API_KEY is not configured.
    """
    props = await sbook.get_player_props(date)
    return {
        "date":      date or datetime.now().strftime("%Y-%m-%d"),
        "hasSbOdds": bool(sbook.api_key),
        "players":   props,
    }


# ------------------------------------------------------------------
# /api/results  — prediction accuracy history
# ------------------------------------------------------------------

@app.get("/api/results/dates")
async def get_results_dates():
    """List all dates that have saved predictions, newest first."""
    return {"dates": list_saved_dates()}


@app.get("/api/results/{date}")
async def get_results(date: str):
    """
    For a given date, return saved predictions cross-referenced with actual
    NHL goal scorers.  Includes accuracy metrics and calibration data.
    """
    # Load saved predictions
    saved = load_predictions(date)

    # Fetch actual goal scorers from NHL boxscores
    try:
        results_raw = await client.get_date_goal_scorers(date)
    except Exception:
        results_raw = {"scorers": {}, "gamesComplete": False, "gamesTotal": 0, "gamesFinished": 0}

    scorers     = results_raw.get("scorers", {})
    scorer_ids  = set(scorers.keys())

    if not saved:
        # No predictions saved for this date — return just the actual scorers
        return {
            "date":           date,
            "hasPredictions": False,
            "gamesComplete":  results_raw.get("gamesComplete", False),
            "gamesTotal":     results_raw.get("gamesTotal", 0),
            "gamesFinished":  results_raw.get("gamesFinished", 0),
            "actualScorers":  list(scorers.values()),
            "predictions":    [],
            "accuracy":       {},
        }

    predictions = saved.get("players", [])

    # Annotate each prediction with whether they scored
    annotated = []
    for p in predictions:
        pid = p.get("playerId")
        scored_info = scorers.get(pid)
        annotated.append({
            **p,
            "scored":       scored_info is not None,
            "actualGoals":  scored_info.get("goals", 0) if scored_info else 0,
            "actualAssists":scored_info.get("assists", 0) if scored_info else 0,
        })

    # Players who scored but weren't in the prediction list
    predicted_ids = {p.get("playerId") for p in predictions}
    missed = [
        s for pid, s in scorers.items()
        if pid not in predicted_ids
    ]
    missed.sort(key=lambda x: x.get("goals", 0), reverse=True)

    accuracy = compute_accuracy(predictions, scorer_ids)

    return {
        "date":           date,
        "hasPredictions": True,
        "savedAt":        saved.get("saved_at"),
        "fullRoster":     saved.get("full_roster", False),
        "gamesComplete":  results_raw.get("gamesComplete", False),
        "gamesTotal":     results_raw.get("gamesTotal", 0),
        "gamesFinished":  results_raw.get("gamesFinished", 0),
        "predictions":    annotated,
        "missedScorers":  missed,
        "actualScorers":  list(scorers.values()),
        "accuracy":       accuracy,
    }


# ------------------------------------------------------------------
# /api/roster/{team}  — full team roster
# ------------------------------------------------------------------

@app.get("/api/roster/{team}")
async def get_roster(team: str):
    """Full current roster for a team (forwards, defensemen, goalies)."""
    try:
        data = await client.get_team_roster(team.upper())
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"team": team.upper(), **data}


# ------------------------------------------------------------------
# /api/advanced-stats/{player_id}
# ------------------------------------------------------------------

@app.get("/api/advanced-stats/{player_id}")
async def get_advanced_stats(player_id: int):
    """MoneyPuck xG, Corsi, Fenwick + NHL situation splits for one player."""
    mp_data, sit_data = await asyncio.gather(
        mp.get_player_all(player_id),
        client.get_player_situation_stats(player_id),
    )
    return {
        "playerId":        player_id,
        "moneypuck":       mp_data,
        "situationSplits": sit_data,
    }


# ------------------------------------------------------------------
# /api/defense-ranks
# ------------------------------------------------------------------

@app.get("/api/defense-ranks")
async def get_defense_ranks():
    """Team defense rankings based on goals allowed per game."""
    try:
        data = await client.get_defense_ranks()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    ranked = sorted(data.items(), key=lambda x: x[1]["defenseRank"])
    return {"teams": [{"team": t, **v} for t, v in ranked]}


# ------------------------------------------------------------------
# /api/scorers
# ------------------------------------------------------------------

@app.get("/api/scorers")
async def get_scorers(limit: int = Query(50, ge=1, le=100)):
    """Top goal scorers for the current season."""
    leaders = await client.get_goal_leaders(limit=limit)
    result = []
    for p in leaders:
        result.append({
            "playerId":   _get_pid(p),
            "name":       _player_name(p),
            "team":       p.get("teamAbbrev", ""),
            "teamName":   p.get("teamName", {}).get("default", ""),
            "position":   p.get("position", ""),
            "headshot":   p.get("headshot", ""),
            "number":     p.get("sweaterNumber"),
            "goals":      p.get("goals", 0),
            "gamesPlayed":p.get("gamesPlayed", 0),
        })
    return {"season": client.current_season(), "players": result}


# ------------------------------------------------------------------
# /api/player/{id}
# ------------------------------------------------------------------

@app.get("/api/player/{player_id}")
async def get_player(player_id: int):
    """Full player info from the NHL landing page."""
    try:
        info = await client.get_player_info(player_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))

    season_stats = {}
    for season in info.get("seasonTotals", []):
        if season.get("gameTypeId") == 2 and season.get("leagueAbbrev") == "NHL":
            season_stats = season

    return {
        "playerId":       player_id,
        "name":           f"{info.get('firstName', {}).get('default', '')} {info.get('lastName', {}).get('default', '')}".strip(),
        "team":           info.get("currentTeamAbbrev", ""),
        "position":       info.get("position", ""),
        "headshot":       info.get("headshot", ""),
        "birthDate":      info.get("birthDate", ""),
        "birthCity":      info.get("birthCity", {}).get("default", ""),
        "nationality":    info.get("birthStateProvince", {}).get("default", "") or info.get("birthCountry", ""),
        "heightInInches": info.get("heightInInches"),
        "weightInPounds": info.get("weightInPounds"),
        "shootsCatches":  info.get("shootsCatches", ""),
        "draftDetails":   info.get("draftDetails", {}),
        "seasonStats":    season_stats,
        "careerTotals":   info.get("careerTotals", {}).get("regularSeason", {}),
    }


# ------------------------------------------------------------------
# /api/player/{id}/gamelog
# ------------------------------------------------------------------

@app.get("/api/player/{player_id}/gamelog")
async def get_gamelog(player_id: int):
    try:
        gamelog = await client.get_player_gamelog(player_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"playerId": player_id, "games": gamelog}


# ------------------------------------------------------------------
# /api/player/{id}/vs-teams
# ------------------------------------------------------------------

@app.get("/api/player/{player_id}/vs-teams")
async def get_vs_teams(player_id: int):
    try:
        data = await client.get_vs_teams(player_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"playerId": player_id, "vsTeams": data}


# ------------------------------------------------------------------
# /api/player/{id}/vs-goalies
# ------------------------------------------------------------------

@app.get("/api/player/{player_id}/vs-goalies")
async def get_vs_goalies(player_id: int):
    try:
        data = await client.get_vs_goalies(player_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"playerId": player_id, "vsGoalies": data}


# ------------------------------------------------------------------
# /api/player/{id}/streaks
# ------------------------------------------------------------------

@app.get("/api/player/{player_id}/streaks")
async def get_streaks(player_id: int):
    try:
        data = await client.get_streaks(player_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"playerId": player_id, **data}


# ------------------------------------------------------------------
# /api/player/{id}/shot-quality
# ------------------------------------------------------------------

@app.get("/api/player/{player_id}/shot-quality")
async def get_shot_quality(player_id: int):
    try:
        data = await client.get_shot_quality(player_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"playerId": player_id, **data}


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
