"""
Prediction persistence and accuracy tracking.

Predictions are saved to .predictions/{date}.json each time /api/predict
is called.  /api/results/{date} loads those predictions and cross-references
them with the NHL boxscore data for the same date to compute accuracy.

Accuracy metrics returned
──────────────────────────
hit_rate          fraction of all predictions that actually scored
top5/10/20        hit rate restricted to the highest-ranked N players
calibration       list of {bucket, predicted_count, hit_count, hit_rate,
                   mid_prob} — groups players into 10-pp probability buckets
simulated_roi     if bookOdds were saved: units won/lost betting 1 unit on
                  every predicted player at their best book line
per_tier          breakdown by model confidence tier
"""

import json
import os
from datetime import datetime
from typing import Dict, List, Optional

_PRED_DIR = os.path.join(os.path.dirname(__file__), ".predictions")


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------

def _path(date: str) -> str:
    os.makedirs(_PRED_DIR, exist_ok=True)
    return os.path.join(_PRED_DIR, f"{date}.json")


def save_predictions(date: str, players: List[dict], full_roster: bool = False):
    """
    Persist a ranked player list for *date*.
    Only the fields needed for accuracy analysis are stored (no gamelogs).
    """
    keep_fields = {
        "playerId", "name", "team", "position", "headshot",
        "tonightGame", "probability", "impliedPct",
        "americanOdds", "decimalOdds", "fractionalOdds",
        "bookOdds", "bookImplied", "bookName",
        "seasonGoals", "seasonGPG", "recentGoals10", "recentGPG",
        "ixGpg", "CF%", "xGF%",
        "tier", "keyFactors", "lineInfo", "value",
    }
    slim = []
    for i, p in enumerate(players):
        row = {k: v for k, v in p.items() if k in keep_fields}
        row["rank"] = i + 1
        slim.append(row)

    record = {
        "date":       date,
        "saved_at":   datetime.utcnow().isoformat() + "Z",
        "full_roster": full_roster,
        "players":    slim,
    }
    with open(_path(date), "w") as f:
        json.dump(record, f)


def load_predictions(date: str) -> Optional[dict]:
    """Return the saved prediction record for *date*, or None."""
    p = _path(date)
    if not os.path.exists(p):
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None


def list_saved_dates() -> List[str]:
    """Return all dates (YYYY-MM-DD) that have saved predictions, newest first."""
    os.makedirs(_PRED_DIR, exist_ok=True)
    dates = []
    for fn in os.listdir(_PRED_DIR):
        if fn.endswith(".json") and len(fn) == 15:   # YYYY-MM-DD.json
            dates.append(fn[:-5])
    return sorted(dates, reverse=True)


# ---------------------------------------------------------------------------
# Accuracy calculation
# ---------------------------------------------------------------------------

def compute_accuracy(
    predictions: List[dict],
    actual_scorer_ids: set,
) -> dict:
    """
    Cross-reference predicted players with the set of player IDs who scored.
    Returns a dict of accuracy metrics.
    """
    if not predictions:
        return {}

    n      = len(predictions)
    scored = {p["playerId"] for p in predictions if p["playerId"] in actual_scorer_ids}
    hits   = len(scored)

    # Top-N hit rates
    def topn_hits(n_top):
        top = predictions[:n_top]
        h   = sum(1 for p in top if p["playerId"] in actual_scorer_ids)
        return {"hits": h, "total": len(top), "hitRate": round(h / len(top), 3) if top else 0}

    # Calibration buckets (0-10%, 10-20%, ..., 50%+)
    buckets: Dict[str, dict] = {}
    for p in predictions:
        prob = p.get("probability", 0)
        if prob >= 0.50:
            label = "50%+"
            mid   = 0.55
        else:
            lo    = int(prob * 100 // 10) * 10
            hi    = lo + 10
            label = f"{lo}-{hi}%"
            mid   = (lo + hi) / 200.0   # midpoint as fraction
        if label not in buckets:
            buckets[label] = {"bucket": label, "midProb": mid, "total": 0, "hits": 0}
        buckets[label]["total"] += 1
        if p["playerId"] in actual_scorer_ids:
            buckets[label]["hits"] += 1

    calib = []
    for b in buckets.values():
        b["hitRate"] = round(b["hits"] / b["total"], 3) if b["total"] else 0
        calib.append(b)
    calib.sort(key=lambda x: x["midProb"])

    # Simulated ROI — 1-unit flat bet on every prediction at best book odds
    roi_data = None
    if any(p.get("bookOdds") and p["bookOdds"] != "—" for p in predictions):
        units_bet  = 0
        units_won  = 0.0
        bets_made  = 0
        bet_wins   = 0
        for p in predictions:
            raw_odds = p.get("bookOdds", "—")
            if not raw_odds or raw_odds == "—":
                continue
            try:
                odds = int(str(raw_odds).replace("+", ""))
            except ValueError:
                continue
            units_bet += 1
            bets_made += 1
            if p["playerId"] in actual_scorer_ids:
                payout = (odds / 100) if odds > 0 else (100 / abs(odds))
                units_won += payout
                bet_wins += 1
            else:
                units_won -= 1

        if bets_made:
            roi_data = {
                "betsMade":   bets_made,
                "betWins":    bet_wins,
                "unitsBet":   units_bet,
                "unitsNet":   round(units_won, 2),
                "roi":        round(units_won / units_bet * 100, 1),
                "winRate":    round(bet_wins / bets_made, 3),
            }

    # Per-tier breakdown
    tier_map: Dict[str, dict] = {}
    for p in predictions:
        t = p.get("tier", "unknown")
        if t not in tier_map:
            tier_map[t] = {"tier": t, "total": 0, "hits": 0}
        tier_map[t]["total"] += 1
        if p["playerId"] in actual_scorer_ids:
            tier_map[t]["hits"] += 1
    tiers = []
    for t in tier_map.values():
        t["hitRate"] = round(t["hits"] / t["total"], 3) if t["total"] else 0
        tiers.append(t)
    tier_order = ["elite", "strong", "moderate", "low", "longshot", "unknown"]
    tiers.sort(key=lambda x: tier_order.index(x["tier"]) if x["tier"] in tier_order else 99)

    return {
        "totalPredicted": n,
        "totalHits":      hits,
        "hitRate":        round(hits / n, 3) if n else 0,
        "top5":           topn_hits(5),
        "top10":          topn_hits(10),
        "top20":          topn_hits(20),
        "calibration":    calib,
        "simulatedROI":   roi_data,
        "perTier":        tiers,
    }
