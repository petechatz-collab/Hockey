"""
NHL Goal Scorer Tracker — FastAPI backend.

Run:
    uvicorn main:app --reload --port 8000

Data sources:
  • NHL Stats API  (api-web.nhle.com/v1)  — schedule, rosters, gamelogs, standings, goalie stats
  • MoneyPuck      (moneypuck.com)        — xG, Corsi, Fenwick, situational rates
"""

import asyncio
from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from moneypuck_client import MoneyPuckClient
from nhl_api import NHLClient
from odds import OddsCalculator

app = FastAPI(title="NHL Goal Scorer Tracker", version="2.0.0")

client  = NHLClient()
mp      = MoneyPuckClient()
calc    = OddsCalculator()

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
    limit: int = Query(50, ge=1, le=100),
    date: str = Query(None),
    full_roster: bool = Query(False),
):
    """
    Top goal scorers ranked by anytime-goal probability.
    full_roster=true fetches every skater on tonight's teams instead of just
    the season goal-scoring leaders.
    Enriched with MoneyPuck xG/Corsi, goalie quality, and defense rank.
    """
    schedule, (mp_stats, defense_ranks, goalie_pcts) = await asyncio.gather(
        client.get_schedule(date),
        _fetch_context(date),
    )

    team_game = _build_team_game_map(schedule)

    if full_roster and schedule:
        # Fetch complete rosters for every playing team
        playing_teams = list(set(g["homeTeam"] for g in schedule) |
                             set(g["awayTeam"] for g in schedule))

        async def safe_roster(team: str):
            try:
                return team, await client.get_team_roster(team)
            except Exception:
                return team, {}

        roster_results = await asyncio.gather(*[safe_roster(t) for t in playing_teams])
        roster_map = {team: data for team, data in roster_results}

        players_raw: List[dict] = []
        for team, roster in roster_map.items():
            for group in ("forwards", "defensemen"):
                for p in roster.get(group, []):
                    players_raw.append({**p, "teamAbbrev": team})
    else:
        # Default: season goal-scoring leaders
        leaders = await client.get_goal_leaders(limit=limit)
        players_raw = leaders

    async def enrich(player: dict) -> Optional[dict]:
        pid = player.get("id")
        if not pid:
            return None
        try:
            gamelog = await client.get_player_gamelog(pid)
        except Exception:
            gamelog = []
        team = player.get("teamAbbrev", "")
        game_info = team_game.get(team)
        # Build name — roster players use nested firstName/lastName dicts
        if "name" in player:
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
            "playerId":        pid,
            "name":            name,
            "team":            team,
            "position":        player.get("positionCode") or player.get("position", ""),
            "headshot":        player.get("headshot", ""),
            "seasonGoals":     player.get("goals", 0),
            "gamesPlayed":     player.get("gamesPlayed", 0),
            "gamelog":         gamelog,
            "tonightGame":     game_info,
            "isPlayingTonight":game_info is not None,
        }

    # Batch-enrich 20 at a time to avoid hammering the API
    enriched: List[dict] = []
    batch_size = 20
    for i in range(0, len(players_raw), batch_size):
        batch = players_raw[i : i + batch_size]
        results = await asyncio.gather(*[enrich(p) for p in batch])
        enriched.extend(r for r in results if r)

    ranked = calc.rank_players(
        enriched,
        mp_stats=mp_stats,
        defense_ranks=defense_ranks,
        goalie_pcts=goalie_pcts,
        game_date=date,
    )
    for r in ranked:
        r["tier"] = OddsCalculator.tier(r["probability"])

    return {
        "season":     client.current_season(),
        "date":       date or datetime.now().strftime("%Y-%m-%d"),
        "fullRoster": full_roster,
        "games":      schedule,
        "players":    ranked,
    }


# ------------------------------------------------------------------
# /api/predict  — game-grouped predictions for a given date
# ------------------------------------------------------------------

@app.get("/api/predict")
async def get_predict(
    date:         str = Query(None),
    limit:        int = Query(100, ge=1, le=200),
    full_roster:  bool = Query(False),
):
    """
    Return tonight's games with their top predicted goal scorers.
    full_roster=true fetches every player on playing teams (not just leaders).
    Enhanced with MoneyPuck xG, goalie quality, and defense rank.
    """
    schedule, (mp_stats, defense_ranks, goalie_pcts) = await asyncio.gather(
        client.get_schedule(date),
        _fetch_context(date),
    )

    if not schedule:
        return {"date": date or datetime.now().strftime("%Y-%m-%d"), "games": []}

    team_game = _build_team_game_map(schedule)

    if full_roster:
        # Fetch complete rosters for every playing team
        playing_teams = list(set(g["homeTeam"] for g in schedule) |
                             set(g["awayTeam"] for g in schedule))

        async def safe_roster(team: str):
            try:
                return team, await client.get_team_roster(team)
            except Exception:
                return team, {}

        roster_results = await asyncio.gather(*[safe_roster(t) for t in playing_teams])
        roster_map = {team: data for team, data in roster_results}

        # Collect all skaters (forwards + defensemen)
        players_raw: List[dict] = []
        for team, roster in roster_map.items():
            for group in ("forwards", "defensemen"):
                for p in roster.get(group, []):
                    players_raw.append({**p, "teamAbbrev": team})

    else:
        # Use top goal-scorer leaders filtered to playing teams
        leaders = await client.get_goal_leaders(limit=limit)
        players_raw = [p for p in leaders if p.get("teamAbbrev", "") in team_game]

    # Batch-fetch gamelogs (20 concurrent to avoid rate limits)
    async def enrich_player(player: dict) -> Optional[dict]:
        pid = player.get("id") or player.get("id")
        if not pid:
            return None
        try:
            gamelog = await client.get_player_gamelog(pid)
        except Exception:
            gamelog = []
        team = player.get("teamAbbrev", "")
        # Build name for roster players (nested or flat fields)
        if "name" not in player:
            fn = player.get("firstName", "")
            ln = player.get("lastName", "")
            if isinstance(fn, dict):
                fn = fn.get("default", "")
            if isinstance(ln, dict):
                ln = ln.get("default", "")
            name = f"{fn} {ln}".strip()
        else:
            name = player["name"]
        return {
            "playerId":        pid,
            "name":            name,
            "team":            team,
            "position":        player.get("positionCode") or player.get("position", ""),
            "headshot":        player.get("headshot", ""),
            "seasonGoals":     player.get("goals", 0),
            "gamesPlayed":     player.get("gamesPlayed", 0),
            "gamelog":         gamelog,
            "tonightGame":     team_game.get(team),
            "isPlayingTonight":True,
        }

    # Batch 20 at a time
    batch_size = 20
    enriched: List[dict] = []
    for i in range(0, len(players_raw), batch_size):
        batch = players_raw[i : i + batch_size]
        results = await asyncio.gather(*[enrich_player(p) for p in batch])
        enriched.extend(r for r in results if r)

    ranked = calc.rank_players(
        enriched,
        mp_stats=mp_stats,
        defense_ranks=defense_ranks,
        goalie_pcts=goalie_pcts,
        game_date=date,
    )
    for r in ranked:
        r["tier"] = OddsCalculator.tier(r["probability"])

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

    # Attach defense/goalie context to each game for display
    for game in game_map.values():
        for team_side in ("homeTeam", "awayTeam"):
            t = game.get(team_side, "")
            game[f"{team_side}DefenseRank"] = (defense_ranks or {}).get(t, {}).get("defenseRank")
            g_info = (goalie_pcts or {}).get("byTeam", {}).get(t, {})
            game[f"{team_side}GoalieSvPct"] = g_info.get("svPct")

    return {
        "date":       date or datetime.now().strftime("%Y-%m-%d"),
        "fullRoster": full_roster,
        "games":      list(game_map.values()),
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
# /api/advanced-stats/{player_id}  — xG, Corsi, Fenwick, situation splits
# ------------------------------------------------------------------

@app.get("/api/advanced-stats/{player_id}")
async def get_advanced_stats(player_id: int):
    """
    MoneyPuck advanced stats (xG, Corsi, Fenwick) + NHL situation splits
    for a single player.
    """
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
# /api/defense-ranks  — team defense rankings
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
# /api/scorers  — raw goal leaders list
# ------------------------------------------------------------------

@app.get("/api/scorers")
async def get_scorers(limit: int = Query(50, ge=1, le=100)):
    """Top goal scorers for the current season."""
    leaders = await client.get_goal_leaders(limit=limit)
    result = []
    for p in leaders:
        result.append({
            "playerId":   p.get("id"),
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
# /api/player/{id}  — player detail
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
    import os
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
