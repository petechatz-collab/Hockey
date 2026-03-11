"""
Sportsbook odds client — NHL anytime goal scorer props via The Odds API.

Setup:
    Set the ODDS_API_KEY environment variable with your free key from
    https://the-odds-api.com  (free tier: 500 requests/month — sufficient
    with caching for daily personal use).

Behavior:
    • Without ODDS_API_KEY set: all methods return empty dicts gracefully.
    • Props are cached to disk for 30 minutes to minimise API usage.
    • Player name matching is fuzzy (accent-stripped, case-insensitive,
      last-name + first-initial fallback).
"""

import asyncio
import hashlib
import json
import os
import time
import unicodedata
from datetime import datetime
from typing import Dict, List, Optional

import httpx

_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")
_BASE      = "https://api.the-odds-api.com/v4"
_SPORT     = "icehockey_nhl"
_MARKET    = "player_anytime_goal_scorer"
_REGIONS   = "us"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _norm(name: str) -> str:
    """Accent-strip, lowercase, collapse whitespace."""
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(c for c in nfkd if not unicodedata.combining(c))
    return " ".join(ascii_name.lower().split())


def _parse_date(dt_str: str):
    """Parse ISO-8601 datetime string to date, return None on failure."""
    if not dt_str:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(dt_str[:19], fmt).date()
        except Exception:
            pass
    try:
        return datetime.fromisoformat(dt_str.replace("Z", "+00:00")).date()
    except Exception:
        return None


def _american_str(odds) -> str:
    if odds is None:
        return "—"
    return f"+{int(odds)}" if odds > 0 else str(int(odds))


def _implied_prob(odds: float) -> float:
    """Convert American odds to implied probability (no vig removed)."""
    if odds > 0:
        return 100 / (100 + odds)
    return abs(odds) / (abs(odds) + 100)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class SportsbookClient:

    def __init__(self):
        os.makedirs(_CACHE_DIR, exist_ok=True)
        self.api_key = os.getenv("ODDS_API_KEY", "").strip()

    # --- cache helpers ---

    def _cache_path(self, key: str) -> str:
        h = hashlib.md5(key.encode()).hexdigest()
        return os.path.join(_CACHE_DIR, f"sb_{h}.json")

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

    def _save(self, key: str, data):
        p = self._cache_path(key)
        try:
            with open(p, "w") as f:
                json.dump({"ts": time.time(), "data": data}, f)
        except Exception:
            pass

    # --- API calls ---

    async def get_events(self) -> List[Dict]:
        """Upcoming NHL events. Cached 30 min."""
        if not self.api_key:
            return []
        cached = self._load("sb_events", ttl=1800)
        if cached is not None:
            return cached
        try:
            async with httpx.AsyncClient(timeout=15.0) as http:
                r = await http.get(
                    f"{_BASE}/sports/{_SPORT}/events",
                    params={"apiKey": self.api_key},
                )
                r.raise_for_status()
                events = r.json()
        except Exception:
            return []
        self._save("sb_events", events)
        return events

    async def get_player_props(self, date: str = None) -> Dict[str, Dict]:
        """
        Fetch anytime goal scorer props for all NHL games on *date*.
        Returns {normalized_player_name: {bestOdds, bestBook, impliedProb,
                                          bestOddsStr, books}}
        """
        if not self.api_key:
            return {}

        cache_key = f"sb_props_{date or 'today'}"
        cached = self._load(cache_key, ttl=1800)
        if cached is not None:
            return cached

        events = await self.get_events()
        if not events:
            return {}

        try:
            target = (
                datetime.strptime(date, "%Y-%m-%d").date()
                if date
                else datetime.utcnow().date()
            )
        except Exception:
            target = datetime.utcnow().date()

        today_events = [
            e for e in events
            if _parse_date(e.get("commence_time", "")) == target
        ]

        player_odds: Dict[str, Dict] = {}

        async def _fetch_event(event: Dict):
            eid = event.get("id", "")
            try:
                async with httpx.AsyncClient(timeout=15.0) as http:
                    r = await http.get(
                        f"{_BASE}/sports/{_SPORT}/events/{eid}/odds",
                        params={
                            "apiKey":      self.api_key,
                            "regions":     _REGIONS,
                            "markets":     _MARKET,
                            "oddsFormat":  "american",
                        },
                    )
                    r.raise_for_status()
                    data = r.json()
            except Exception:
                return

            for book in data.get("bookmakers", []):
                bname = book.get("title", "")
                for mkt in book.get("markets", []):
                    if mkt.get("key") != _MARKET:
                        continue
                    for outcome in mkt.get("outcomes", []):
                        raw_name = (
                            outcome.get("description")
                            or outcome.get("name")
                            or ""
                        ).strip()
                        price = outcome.get("price")
                        if not raw_name or price is None:
                            continue

                        key = _norm(raw_name)
                        if key not in player_odds:
                            player_odds[key] = {
                                "displayName": raw_name,
                                "books":       {},
                                "bestOdds":    None,
                                "bestBook":    None,
                            }

                        player_odds[key]["books"][bname] = price
                        curr = player_odds[key]["bestOdds"]
                        if curr is None or price > curr:
                            player_odds[key]["bestOdds"] = price
                            player_odds[key]["bestBook"] = bname

        await asyncio.gather(*[_fetch_event(e) for e in today_events])

        # Post-process: compute derived fields
        for info in player_odds.values():
            odds = info["bestOdds"]
            info["impliedProb"] = round(_implied_prob(odds), 4) if odds is not None else None
            info["bestOddsStr"] = _american_str(odds)

        self._save(cache_key, player_odds)
        return player_odds

    # --- name matching ---

    def match_player(self, name: str, props: Dict[str, Dict]) -> Optional[Dict]:
        """
        Look up a player by name in the props dict.
        Falls back to last-name + first-initial matching.
        """
        if not props or not name:
            return None
        key = _norm(name)
        if key in props:
            return props[key]

        # last-name + first initial fallback
        parts = key.split()
        if len(parts) >= 2:
            last  = parts[-1]
            first_init = parts[0][0]
            for k, v in props.items():
                kp = k.split()
                if len(kp) >= 2 and kp[-1] == last and kp[0][0] == first_init:
                    return v
        return None
