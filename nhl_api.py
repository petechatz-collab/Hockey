"""
NHL API Client — fetches data from the public NHL stats API (api-web.nhle.com/v1).
Results are cached to disk so repeated calls don't hammer the API.
"""

import asyncio
import hashlib
import json
import os
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx

BASE_URL = "https://api-web.nhle.com/v1"
CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")
CACHE_TTL = 3600  # 1 hour for most endpoints
LONG_TTL = 86400  # 24 hours for relatively static data (player info, season totals)


class NHLClient:
    def __init__(self):
        os.makedirs(CACHE_DIR, exist_ok=True)

    # ------------------------------------------------------------------
    # Cache helpers
    # ------------------------------------------------------------------

    def _cache_path(self, key: str) -> str:
        digest = hashlib.md5(key.encode()).hexdigest()
        return os.path.join(CACHE_DIR, f"{digest}.json")

    def _get_cache(self, key: str, ttl: int = CACHE_TTL) -> Optional[Any]:
        path = self._cache_path(key)
        if os.path.exists(path):
            try:
                with open(path) as f:
                    entry = json.load(f)
                if time.time() - entry["ts"] < ttl:
                    return entry["data"]
            except Exception:
                pass
        return None

    def _set_cache(self, key: str, data: Any):
        path = self._cache_path(key)
        try:
            with open(path, "w") as f:
                json.dump({"ts": time.time(), "data": data}, f)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # HTTP fetch
    # ------------------------------------------------------------------

    async def _get(self, endpoint: str, params: Dict = None, ttl: int = CACHE_TTL) -> Any:
        url = f"{BASE_URL}{endpoint}"
        qs = "&".join(f"{k}={v}" for k, v in (params or {}).items())
        cache_key = f"{url}?{qs}" if qs else url

        cached = self._get_cache(cache_key, ttl)
        if cached is not None:
            return cached

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        self._set_cache(cache_key, data)
        return data

    # ------------------------------------------------------------------
    # Season helpers
    # ------------------------------------------------------------------

    def current_season(self) -> str:
        """Return NHL season ID like '20252026'."""
        now = datetime.now()
        y, m = now.year, now.month
        return f"{y}{y + 1}" if m >= 10 else f"{y - 1}{y}"

    # ------------------------------------------------------------------
    # Public API methods
    # ------------------------------------------------------------------

    async def get_goal_leaders(self, limit: int = 100) -> List[Dict]:
        """Top goal scorers for the current regular season."""
        season = self.current_season()
        data = await self._get(
            f"/skater-stats-leaders/{season}/2",
            params={"categories": "goals", "limit": str(limit)},
            ttl=CACHE_TTL,
        )
        return data.get("goals", [])

    async def get_player_info(self, player_id: int) -> Dict:
        """Player landing page — includes bio and career stats."""
        data = await self._get(f"/player/{player_id}/landing", ttl=LONG_TTL)
        return data

    async def get_player_gamelog(self, player_id: int) -> List[Dict]:
        """Per-game log for the current regular season."""
        season = self.current_season()
        data = await self._get(
            f"/player/{player_id}/game-log/{season}/2",
            ttl=CACHE_TTL,
        )
        return data.get("gameLog", [])

    async def get_game_boxscore(self, game_id: int) -> Dict:
        """Game boxscore — contains goalie stats per team."""
        data = await self._get(f"/gamecenter/{game_id}/boxscore", ttl=LONG_TTL)
        return data

    async def get_game_playbyplay(self, game_id: int) -> Dict:
        """Full play-by-play for a game (used for shot quality)."""
        data = await self._get(f"/gamecenter/{game_id}/play-by-play", ttl=LONG_TTL)
        return data

    # ------------------------------------------------------------------
    # Derived / aggregated data
    # ------------------------------------------------------------------

    async def get_vs_teams(self, player_id: int) -> List[Dict]:
        """Aggregate player stats broken down by opponent team."""
        gamelog = await self.get_player_gamelog(player_id)
        totals: Dict[str, Dict] = {}

        for game in gamelog:
            opp = game.get("opponentAbbrev", "UNK")
            if opp not in totals:
                totals[opp] = {
                    "team": opp,
                    "games": 0,
                    "goals": 0,
                    "assists": 0,
                    "points": 0,
                    "shots": 0,
                    "pim": 0,
                    "ppGoals": 0,
                }
            t = totals[opp]
            t["games"] += 1
            t["goals"] += game.get("goals", 0)
            t["assists"] += game.get("assists", 0)
            t["points"] += game.get("goals", 0) + game.get("assists", 0)
            t["shots"] += game.get("shots", 0)
            t["pim"] += game.get("pim", 0)
            t["ppGoals"] += game.get("powerPlayGoals", 0)

        for t in totals.values():
            t["goalsPerGame"] = round(t["goals"] / t["games"], 2) if t["games"] else 0
            t["shootingPct"] = round(t["goals"] / t["shots"] * 100, 1) if t["shots"] else 0

        return sorted(totals.values(), key=lambda x: x["goals"], reverse=True)

    async def get_vs_goalies(self, player_id: int) -> List[Dict]:
        """
        For every game the player scored in, look up the opposing
        starting goalie from the boxscore and aggregate.
        """
        gamelog = await self.get_player_gamelog(player_id)
        scoring_games = [g for g in gamelog if g.get("goals", 0) > 0]

        goalie_totals: Dict[str, Dict] = {}

        async def process_game(game: Dict):
            game_id = game.get("gameId")
            goals = game.get("goals", 0)
            opp = game.get("opponentAbbrev", "UNK")
            home_road = game.get("homeRoadFlag", "H")

            try:
                box = await self.get_game_boxscore(game_id)
            except Exception:
                return

            # Determine which side is the opponent
            home_team = box.get("homeTeam", {}).get("abbrev", "")
            away_team = box.get("awayTeam", {}).get("abbrev", "")

            # The opponent goalie is on the other side
            if home_road == "H":
                opp_side = "awayTeam"
            else:
                opp_side = "homeTeam"

            players = box.get("playerByGameStats", {}).get(opp_side, {}).get("goalies", [])
            if not players:
                # Fallback: just use opponent abbrev as key
                goalie_key = opp
                goalie_name = opp
                goalie_id = None
            else:
                # Pick the goalie who faced the most shots (primary goalie)
                primary = max(players, key=lambda g: g.get("shotsAgainst", 0))
                fn = primary.get("name", {}).get("default", "Unknown")
                goalie_key = fn
                goalie_name = fn
                goalie_id = primary.get("playerId")

            if goalie_key not in goalie_totals:
                goalie_totals[goalie_key] = {
                    "goalie": goalie_name,
                    "goalieId": goalie_id,
                    "team": opp,
                    "games": 0,
                    "goals": 0,
                    "shots": 0,
                }
            goalie_totals[goalie_key]["games"] += 1
            goalie_totals[goalie_key]["goals"] += goals
            goalie_totals[goalie_key]["shots"] += game.get("shots", 0)

        # Fetch boxscores concurrently (batches of 10)
        batch_size = 10
        for i in range(0, len(scoring_games), batch_size):
            batch = scoring_games[i : i + batch_size]
            await asyncio.gather(*[process_game(g) for g in batch])

        for g in goalie_totals.values():
            g["shootingPct"] = round(g["goals"] / g["shots"] * 100, 1) if g["shots"] else 0

        return sorted(goalie_totals.values(), key=lambda x: x["goals"], reverse=True)

    async def get_streaks(self, player_id: int) -> Dict:
        """Compute goal streaks and scoreless slumps from game log."""
        gamelog = await self.get_player_gamelog(player_id)
        games = sorted(gamelog, key=lambda x: x.get("gameDate", ""))

        streaks: List[Dict] = []
        current_run: List[Dict] = []
        current_streak = 0

        for game in games:
            goals = game.get("goals", 0)
            if goals > 0:
                current_streak += 1
                current_run.append(game)
            else:
                if current_streak > 0:
                    streaks.append(
                        {
                            "length": current_streak,
                            "start": current_run[0]["gameDate"],
                            "end": current_run[-1]["gameDate"],
                            "goals": sum(g["goals"] for g in current_run),
                            "active": False,
                        }
                    )
                current_streak = 0
                current_run = []

        if current_streak > 0:
            streaks.append(
                {
                    "length": current_streak,
                    "start": current_run[0]["gameDate"],
                    "end": current_run[-1]["gameDate"],
                    "goals": sum(g["goals"] for g in current_run),
                    "active": True,
                }
            )

        # Active streak = trailing consecutive scoring games
        active_streak = 0
        for game in reversed(games):
            if game.get("goals", 0) > 0:
                active_streak += 1
            else:
                break

        # Longest scoreless drought
        max_slump, cur_slump = 0, 0
        for game in games:
            if game.get("goals", 0) == 0:
                cur_slump += 1
                max_slump = max(max_slump, cur_slump)
            else:
                cur_slump = 0

        # Monthly breakdown
        monthly: Dict[str, Dict] = {}
        for game in games:
            ym = game.get("gameDate", "")[:7]
            if ym not in monthly:
                monthly[ym] = {"month": ym, "goals": 0, "games": 0}
            monthly[ym]["goals"] += game.get("goals", 0)
            monthly[ym]["games"] += 1

        return {
            "active_streak": active_streak,
            "longest_streak": max(s["length"] for s in streaks) if streaks else 0,
            "streaks": sorted(streaks, key=lambda x: x["length"], reverse=True)[:10],
            "longest_slump": max_slump,
            "monthly": sorted(monthly.values(), key=lambda x: x["month"]),
        }

    async def get_shot_quality(self, player_id: int) -> Dict:
        """Shot quality metrics derived from the player game log."""
        gamelog = await self.get_player_gamelog(player_id)
        if not gamelog:
            return {}

        games = len(gamelog)
        total_goals = sum(g.get("goals", 0) for g in gamelog)
        total_shots = sum(g.get("shots", 0) for g in gamelog)
        total_pp_goals = sum(g.get("powerPlayGoals", 0) for g in gamelog)
        total_gwg = sum(g.get("gameWinningGoals", 0) for g in gamelog)

        recent = sorted(gamelog, key=lambda x: x.get("gameDate", ""), reverse=True)[:10]
        recent_goals = sum(g.get("goals", 0) for g in recent)
        recent_shots = sum(g.get("shots", 0) for g in recent)

        home = [g for g in gamelog if g.get("homeRoadFlag") == "H"]
        away = [g for g in gamelog if g.get("homeRoadFlag") == "R"]

        # Shot buckets per game
        shot_dist = {
            "0": 0, "1": 0, "2": 0, "3+": 0
        }
        for g in gamelog:
            s = g.get("shots", 0)
            if s == 0:
                shot_dist["0"] += 1
            elif s == 1:
                shot_dist["1"] += 1
            elif s == 2:
                shot_dist["2"] += 1
            else:
                shot_dist["3+"] += 1

        goal_dist = {
            "0": sum(1 for g in gamelog if g.get("goals", 0) == 0),
            "1": sum(1 for g in gamelog if g.get("goals", 0) == 1),
            "2": sum(1 for g in gamelog if g.get("goals", 0) == 2),
            "3+": sum(1 for g in gamelog if g.get("goals", 0) >= 3),
        }

        return {
            "games": games,
            "goals": total_goals,
            "shots": total_shots,
            "goalsPerGame": round(total_goals / games, 3) if games else 0,
            "shotsPerGame": round(total_shots / games, 2) if games else 0,
            "shootingPct": round(total_goals / total_shots * 100, 1) if total_shots else 0,
            "ppGoals": total_pp_goals,
            "ppGoalPct": round(total_pp_goals / total_goals * 100, 1) if total_goals else 0,
            "gameWinningGoals": total_gwg,
            "multiGoalGames": sum(1 for g in gamelog if g.get("goals", 0) >= 2),
            "hatTricks": sum(1 for g in gamelog if g.get("goals", 0) >= 3),
            "recentGoals10": recent_goals,
            "recentShots10": recent_shots,
            "recentShootingPct": round(recent_goals / recent_shots * 100, 1) if recent_shots else 0,
            "recentGPG": round(recent_goals / len(recent), 3) if recent else 0,
            "homeGoals": sum(g.get("goals", 0) for g in home),
            "homeGames": len(home),
            "homeGPG": round(sum(g.get("goals", 0) for g in home) / len(home), 3) if home else 0,
            "awayGoals": sum(g.get("goals", 0) for g in away),
            "awayGames": len(away),
            "awayGPG": round(sum(g.get("goals", 0) for g in away) / len(away), 3) if away else 0,
            "shotDist": shot_dist,
            "goalDist": goal_dist,
        }
