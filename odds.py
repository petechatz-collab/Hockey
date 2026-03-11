"""
Anytime Goal Scorer Odds Calculator.

Uses a Poisson-based probability model:
  P(score >= 1) = 1 - e^(-λ)

Where λ (expected goals) is a weighted blend of:
  - Season goals-per-game          (35 %)
  - Recent-form goals-per-game     (40 %)  last 10 games
  - Consistency rate               (15 %)  % of games with a goal
  - Shot-volume proxy              (10 %)  shots_pg × career_sh%

American, decimal, and implied-probability outputs are provided.
"""

import math
from typing import Dict, List


class OddsCalculator:

    # ------------------------------------------------------------------ #
    # Core probability model                                               #
    # ------------------------------------------------------------------ #

    def expected_goals(self, gamelog: List[Dict]) -> float:
        """Compute λ (expected goals in next game)."""
        n = len(gamelog)
        if n == 0:
            return 0.0

        total_goals = sum(g.get("goals", 0) for g in gamelog)
        total_shots = sum(g.get("shots", 0) for g in gamelog)

        season_gpg = total_goals / n

        # Recent form — last 10 games
        recent = sorted(gamelog, key=lambda g: g.get("gameDate", ""), reverse=True)[:10]
        recent_n = len(recent)
        recent_goals = sum(g.get("goals", 0) for g in recent)
        recent_gpg = recent_goals / recent_n if recent_n else season_gpg

        # Consistency (% games with ≥1 goal)
        scoring_games = sum(1 for g in gamelog if g.get("goals", 0) > 0)
        consistency = scoring_games / n

        # Shot-volume proxy
        sh_pct = total_goals / total_shots if total_shots else 0
        shots_pg = total_shots / n
        shot_proxy = shots_pg * sh_pct  # ≈ expected goals from shots alone

        lam = (
            season_gpg * 0.35
            + recent_gpg * 0.40
            + consistency * 0.15
            + shot_proxy * 0.10
        )
        return max(lam, 0.0)

    def poisson_prob(self, lam: float) -> float:
        """P(X >= 1) for a Poisson random variable with mean λ."""
        if lam <= 0:
            return 0.0
        return 1.0 - math.exp(-lam)

    def calculate_probability(self, gamelog: List[Dict]) -> float:
        lam = self.expected_goals(gamelog)
        return round(self.poisson_prob(lam), 4)

    # ------------------------------------------------------------------ #
    # Odds formatting                                                       #
    # ------------------------------------------------------------------ #

    def to_american(self, prob: float) -> str:
        if prob <= 0 or prob >= 1:
            return "N/A"
        if prob < 0.5:
            return f"+{int(round((1 / prob - 1) * 100))}"
        return str(int(round(-(prob / (1 - prob)) * 100)))

    def to_decimal(self, prob: float) -> float:
        if prob <= 0:
            return 0.0
        return round(1 / prob, 2)

    def to_fractional(self, prob: float) -> str:
        if prob <= 0 or prob >= 1:
            return "N/A"
        # Approximate with simple fractions
        decimal = 1 / prob - 1
        # Find best fraction with denominator ≤ 20
        best_num, best_den, best_err = 1, 1, float("inf")
        for den in range(1, 21):
            num = round(decimal * den)
            if num <= 0:
                continue
            err = abs(decimal - num / den)
            if err < best_err:
                best_err, best_num, best_den = err, num, den
        return f"{best_num}/{best_den}"

    # ------------------------------------------------------------------ #
    # Rank a list of players                                               #
    # ------------------------------------------------------------------ #

    def rank_players(self, players: List[Dict]) -> List[Dict]:
        """
        Given a list of dicts with at least {'playerId', 'gamelog'} keys,
        return them sorted by probability descending with odds fields added.
        """
        results = []
        for p in players:
            gamelog = p.get("gamelog", [])
            prob = self.calculate_probability(gamelog)
            lam = self.expected_goals(gamelog)

            n = len(gamelog)
            total_goals = sum(g.get("goals", 0) for g in gamelog)
            recent = sorted(gamelog, key=lambda g: g.get("gameDate", ""), reverse=True)[:10]
            recent_goals = sum(g.get("goals", 0) for g in recent)

            results.append(
                {
                    **{k: v for k, v in p.items() if k != "gamelog"},
                    "probability": prob,
                    "impliedPct": round(prob * 100, 1),
                    "expectedGoals": round(lam, 3),
                    "americanOdds": self.to_american(prob),
                    "decimalOdds": self.to_decimal(prob),
                    "fractionalOdds": self.to_fractional(prob),
                    "seasonGPG": round(total_goals / n, 3) if n else 0,
                    "recentGoals10": recent_goals,
                    "recentGPG": round(recent_goals / len(recent), 3) if recent else 0,
                    "gamesPlayed": n,
                    "seasonGoals": total_goals,
                }
            )

        return sorted(results, key=lambda x: x["probability"], reverse=True)

    # ------------------------------------------------------------------ #
    # Confidence tier                                                       #
    # ------------------------------------------------------------------ #

    @staticmethod
    def tier(prob: float) -> str:
        if prob >= 0.55:
            return "elite"
        if prob >= 0.40:
            return "strong"
        if prob >= 0.28:
            return "moderate"
        if prob >= 0.18:
            return "low"
        return "longshot"
