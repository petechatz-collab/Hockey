"""
MoneyPuck Client — advanced hockey analytics (xG, Corsi, Fenwick).

Data source: moneypuck.com seasonal player summary CSVs (freely available).
Player IDs in MoneyPuck match NHL API player IDs exactly.

Situations:
  "all"      — all situations combined
  "5on5"     — even strength
  "5on4"     — power play
  "4on5"     — penalty kill
  "other"    — empty net + other (EN goals live here)

Key fields returned per player:
  ixG          total individual expected goals (season)
  ixGpg        ixG per game
  ixGp60       ixG per 60 min (pace-adjusted)
  iHDGoals     high-danger goals
  iHDSh%       high-danger shooting %
  CF%          on-ice Corsi for %
  FF%          on-ice Fenwick for %
  xGF%         on-ice expected goals for %
  HDCF%        on-ice high-danger Corsi for %
"""

import asyncio
import csv
import io
import json
import os
import time
from datetime import datetime
from typing import Dict, Optional, Tuple

import httpx

_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")

# Situation constants
SIT_ALL  = "all"
SIT_EV   = "5on5"
SIT_PP   = "5on4"
SIT_PK   = "4on5"
SIT_EN   = "other"


class MoneyPuckClient:

    BASE_CSV = (
        "https://moneypuck.com/moneypuck/playerData/"
        "seasonSummary/{year}/regular/skaters.csv"
    )

    def __init__(self):
        os.makedirs(_CACHE_DIR, exist_ok=True)

    # ------------------------------------------------------------------ #
    # Helpers                                                              #
    # ------------------------------------------------------------------ #

    def _season_year(self) -> int:
        """Return start-year of the current NHL season (e.g. 2025 for 2025-26)."""
        now = datetime.now()
        return now.year if now.month >= 10 else now.year - 1

    def _cache_path(self, key: str) -> str:
        import hashlib
        h = hashlib.md5(key.encode()).hexdigest()
        return os.path.join(_CACHE_DIR, f"mp_{h}.json")

    def _load(self, key: str, ttl: int) -> Optional[dict]:
        p = self._cache_path(key)
        if not os.path.exists(p):
            return None
        try:
            with open(p) as f:
                entry = json.load(f)
            if time.time() - entry.get("ts", 0) < ttl:
                return entry["data"]
        except Exception:
            pass
        return None

    def _save(self, key: str, data: dict):
        p = self._cache_path(key)
        try:
            with open(p, "w") as f:
                json.dump({"ts": time.time(), "data": data}, f)
        except Exception:
            pass

    def _safe_float(self, val, default: float = 0.0) -> float:
        try:
            return float(val) if val not in (None, "", "nan") else default
        except (ValueError, TypeError):
            return default

    def _safe_int(self, val, default: int = 0) -> int:
        try:
            return int(float(val)) if val not in (None, "", "nan") else default
        except (ValueError, TypeError):
            return default

    # ------------------------------------------------------------------ #
    # Core fetch                                                           #
    # ------------------------------------------------------------------ #

    async def get_player_stats(
        self, situation: str = SIT_ALL, ttl: int = 21_600
    ) -> Dict[int, Dict]:
        """
        Fetch MoneyPuck skater CSV and return {playerId: stats_dict}.
        Results are cached for 6 hours by default.
        """
        year = self._season_year()
        cache_key = f"mp_{year}_{situation}"
        cached = self._load(cache_key, ttl)
        if cached is not None:
            return {int(k): v for k, v in cached.items()}

        url = self.BASE_CSV.format(year=year)
        try:
            async with httpx.AsyncClient(
                timeout=45.0,
                headers={"User-Agent": "NHLTrackerApp/1.0"},
            ) as http:
                resp = await http.get(url)
                resp.raise_for_status()
                text = resp.text
        except Exception:
            return {}

        result: Dict[int, Dict] = {}
        reader = csv.DictReader(io.StringIO(text))
        sf = self._safe_float
        si = self._safe_int

        for row in reader:
            if row.get("situation") != situation:
                continue
            try:
                pid = int(row["playerId"])
            except (KeyError, ValueError):
                continue

            gp  = max(si(row.get("gamesPlayed"), 1), 1)
            ice = sf(row.get("icetime"))           # seconds
            ice_h = ice / 3600 if ice > 0 else 1e-6

            i_xg   = sf(row.get("I_F_xGoals"))
            i_goal = sf(row.get("I_F_goals"))
            i_shot = sf(row.get("I_F_shotsOnGoal"))
            i_cf   = sf(row.get("I_F_shotAttempts"))
            i_ff   = sf(row.get("I_F_unblockedShotAttempts"))
            i_hdg  = sf(row.get("I_F_highDangerGoals"))
            i_hds  = sf(row.get("I_F_highDangerShots"))
            i_hdxg = sf(row.get("I_F_highDangerxGoals"))

            oi_xgf = sf(row.get("OnIce_F_xGoals"))
            oi_xga = sf(row.get("OnIce_A_xGoals"))
            cf_pct = sf(row.get("CF_Pct"), 50.0)
            ff_pct = sf(row.get("FF_Pct"), 50.0)
            xgf_pct= sf(row.get("xGF_Pct"), 50.0)
            hdcf_pct=sf(row.get("HDCF_Pct"), 50.0)

            result[pid] = {
                "playerId":     pid,
                "team":         row.get("team", ""),
                "gamesPlayed":  gp,
                # Individual xG
                "ixG":          round(i_xg, 2),
                "ixGpg":        round(i_xg / gp, 4),
                "ixGp60":       round(i_xg / ice_h * 60, 2),
                # Goals & shots
                "iGoals":       si(i_goal),
                "iShots":       si(i_shot),
                # Corsi / Fenwick
                "iCorsi":       si(i_cf),
                "iFenwick":     si(i_ff),
                "iCorsip60":    round(i_cf  / ice_h * 60, 1),
                "iFenwickp60":  round(i_ff  / ice_h * 60, 1),
                # High danger
                "iHDGoals":     si(i_hdg),
                "iHDShots":     si(i_hds),
                "iHDxG":        round(i_hdxg, 2),
                "iHDSh%":       round(i_hdg / i_hds * 100, 1) if i_hds else 0.0,
                # On-ice
                "onIceXGF":     round(oi_xgf, 2),
                "onIceXGA":     round(oi_xga, 2),
                "xGF%":         round(xgf_pct, 1),
                "CF%":          round(cf_pct,  1),
                "FF%":          round(ff_pct,  1),
                "HDCF%":        round(hdcf_pct,1),
                # Ice time
                "icetimePG":    round(ice / 60 / gp, 2),
            }

        self._save(cache_key, {str(k): v for k, v in result.items()})
        return result

    # ------------------------------------------------------------------ #
    # Combined situational fetch                                           #
    # ------------------------------------------------------------------ #

    async def get_all_situations(
        self,
    ) -> Tuple[Dict[int, Dict], Dict[int, Dict], Dict[int, Dict]]:
        """
        Concurrently fetch all / even-strength / power-play stats.
        Returns (all_stats, ev_stats, pp_stats) dicts keyed by playerId.
        """
        return await asyncio.gather(
            self.get_player_stats(SIT_ALL),
            self.get_player_stats(SIT_EV),
            self.get_player_stats(SIT_PP),
        )

    async def get_player_all(self, player_id: int) -> Dict:
        """
        Return a combined dict for one player with all/ev/pp breakdowns.
        Returns {} if the player is not found in MoneyPuck data.
        """
        all_s, ev_s, pp_s = await self.get_all_situations()
        base = all_s.get(player_id)
        if not base:
            return {}
        return {
            **base,
            "ev": ev_s.get(player_id, {}),
            "pp": pp_s.get(player_id, {}),
        }
