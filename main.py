"""
NHL Goal Scorer Tracker — FastAPI backend.

Run:
    uvicorn main:app --reload --port 8000

All data comes from the public NHL stats API (api-web.nhle.com/v1).
"""

import asyncio
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from nhl_api import NHLClient
from odds import OddsCalculator

app = FastAPI(title="NHL Goal Scorer Tracker", version="1.0.0")

client = NHLClient()
calc = OddsCalculator()

# ------------------------------------------------------------------
# Static files / SPA
# ------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", include_in_schema=False)
async def root():
    return FileResponse("static/index.html")


# ------------------------------------------------------------------
# /api/odds  — ranked anytime goal scorer odds (main feature)
# ------------------------------------------------------------------

@app.get("/api/odds")
async def get_odds(limit: int = Query(50, ge=1, le=100)):
    """
    Return top goal scorers ranked by their anytime-goal probability
    for tonight's game.
    """
    leaders = await client.get_goal_leaders(limit=limit)

    # Fetch gamelogs concurrently
    async def enrich(player: dict) -> Optional[dict]:
        pid = player.get("id")
        if not pid:
            return None
        try:
            gamelog = await client.get_player_gamelog(pid)
        except Exception:
            gamelog = []

        return {
            "playerId": pid,
            "name": f"{player.get('firstName', {}).get('default', '')} {player.get('lastName', {}).get('default', '')}".strip(),
            "team": player.get("teamAbbrev", ""),
            "position": player.get("position", ""),
            "headshot": player.get("headshot", ""),
            "seasonGoals": player.get("goals", 0),
            "gamesPlayed": player.get("gamesPlayed", 0),
            "gamelog": gamelog,
        }

    enriched = await asyncio.gather(*[enrich(p) for p in leaders])
    enriched = [e for e in enriched if e]

    ranked = calc.rank_players(enriched)

    # Add tier label
    for r in ranked:
        r["tier"] = OddsCalculator.tier(r["probability"])

    return {"season": client.current_season(), "players": ranked}


# ------------------------------------------------------------------
# /api/scorers  — raw goal leaders list
# ------------------------------------------------------------------

@app.get("/api/scorers")
async def get_scorers(limit: int = Query(50, ge=1, le=100)):
    """Top goal scorers for the current season."""
    leaders = await client.get_goal_leaders(limit=limit)

    result = []
    for p in leaders:
        result.append(
            {
                "playerId": p.get("id"),
                "name": f"{p.get('firstName', {}).get('default', '')} {p.get('lastName', {}).get('default', '')}".strip(),
                "team": p.get("teamAbbrev", ""),
                "teamName": p.get("teamName", {}).get("default", ""),
                "position": p.get("position", ""),
                "headshot": p.get("headshot", ""),
                "number": p.get("sweaterNumber"),
                "goals": p.get("goals", 0),
                "gamesPlayed": p.get("gamesPlayed", 0),
            }
        )
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

    # Flatten to useful subset
    season_stats = {}
    for season in info.get("seasonTotals", []):
        if season.get("gameTypeId") == 2 and season.get("leagueAbbrev") == "NHL":
            season_stats = season  # last entry = most recent season

    return {
        "playerId": player_id,
        "name": f"{info.get('firstName', {}).get('default', '')} {info.get('lastName', {}).get('default', '')}".strip(),
        "team": info.get("currentTeamAbbrev", ""),
        "position": info.get("position", ""),
        "headshot": info.get("headshot", ""),
        "birthDate": info.get("birthDate", ""),
        "birthCity": info.get("birthCity", {}).get("default", ""),
        "nationality": info.get("birthStateProvince", {}).get("default", "")
        or info.get("birthCountry", ""),
        "heightInInches": info.get("heightInInches"),
        "weightInPounds": info.get("weightInPounds"),
        "shootsCatches": info.get("shootsCatches", ""),
        "draftDetails": info.get("draftDetails", {}),
        "seasonStats": season_stats,
        "careerTotals": info.get("careerTotals", {}).get("regularSeason", {}),
    }


# ------------------------------------------------------------------
# /api/player/{id}/gamelog
# ------------------------------------------------------------------

@app.get("/api/player/{player_id}/gamelog")
async def get_gamelog(player_id: int):
    """Per-game stats for the current season."""
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
    """Goals and stats split by opponent team."""
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
    """
    Goals broken down by opposing goalie.
    Note: requires fetching each game's boxscore — may be slow on first call
    but is then cached for 24 h.
    """
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
    """Goal streaks, slumps, and monthly breakdown."""
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
    """Shot quality metrics: volume, efficiency, splits."""
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
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
