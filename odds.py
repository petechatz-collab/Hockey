"""
NHL Goal Scorer Odds & Prediction Calculator.

Base model — Poisson probability:
  P(score >= 1) = 1 - e^(-λ)

Enhanced λ blends four base components then applies three multiplicative
matchup adjustments and a streak momentum additive term:

  Base λ  = season_gpg × 0.25
           + recent_gpg × 0.35   (last 10 games)
           + consistency × 0.10  (% games with a goal)
           + shot_quality × 0.15 (shots_pg × shooting_pct)
           = 0.85 total base weight

  × opponent_factor   — goals/game vs tonight's specific team (clamped 0.70–1.50)
  × home_away_factor  — home vs away goal split          (clamped 0.80–1.30)
  + streak_adj        — active streak bonus / slump penalty

Outputs: probability, fair American / decimal / fractional odds, model factors.
"""

import math
from typing import Dict, List, Optional, Tuple


class OddsCalculator:

    # ------------------------------------------------------------------ #
    # Enhanced prediction model                                           #
    # ------------------------------------------------------------------ #

    def expected_goals_enhanced(
        self,
        gamelog: List[Dict],
        opponent: Optional[str] = None,
        home_away: Optional[str] = None,  # "H" or "A"
    ) -> Tuple[float, Dict]:
        """
        Compute λ (expected goals) with matchup context.
        Returns (λ, factors_dict) where factors_dict explains the model breakdown.
        """
        n = len(gamelog)
        if n == 0:
            return 0.0, {}

        total_goals = sum(g.get("goals", 0) for g in gamelog)
        total_shots = sum(g.get("shots", 0) for g in gamelog)

        season_gpg = total_goals / n

        # --- Recent form (last 10 games) ---
        recent = sorted(gamelog, key=lambda g: g.get("gameDate", ""), reverse=True)[:10]
        recent_goals = sum(g.get("goals", 0) for g in recent)
        recent_gpg = recent_goals / len(recent) if recent else season_gpg

        # --- Consistency (% games with ≥1 goal) ---
        scoring_games = sum(1 for g in gamelog if g.get("goals", 0) > 0)
        consistency = scoring_games / n

        # --- Shot quality (shots_per_game × shooting_pct) ---
        sh_pct = total_goals / total_shots if total_shots else 0
        shots_pg = total_shots / n
        shot_quality = shots_pg * sh_pct

        lam_base = (
            season_gpg  * 0.25
            + recent_gpg  * 0.35
            + consistency * 0.10
            + shot_quality * 0.15
        )

        factors: Dict = {
            "seasonGPG":    round(season_gpg, 3),
            "recentGPG":    round(recent_gpg, 3),
            "consistency":  round(consistency, 3),
            "shotQuality":  round(shot_quality, 3),
            "shotsPerGame": round(shots_pg, 2),
            "shootingPct":  round(sh_pct * 100, 1),
            "baseLambda":   round(lam_base, 4),
        }

        key_factors: List[str] = []

        # ----------------------------------------------------------------
        # Matchup multiplier — vs tonight's opponent
        # ----------------------------------------------------------------
        opp_factor = 1.0
        if opponent:
            opp_games = [g for g in gamelog if g.get("opponentAbbrev") == opponent]
            if len(opp_games) >= 2:
                opp_gpg = sum(g.get("goals", 0) for g in opp_games) / len(opp_games)
                if season_gpg > 0:
                    raw = opp_gpg / season_gpg
                    opp_factor = max(0.70, min(1.50, raw))
                factors["vsOpponentGPG"]   = round(opp_gpg, 3)
                factors["vsOpponentGames"] = len(opp_games)
                if opp_factor >= 1.20:
                    key_factors.append(f"💪 Scores vs {opponent}")
                elif opp_factor <= 0.80:
                    key_factors.append(f"🚫 Struggles vs {opponent}")
            else:
                factors["vsOpponentGames"] = len(opp_games)  # 0 or 1
        factors["opponentFactor"] = round(opp_factor, 3)

        # ----------------------------------------------------------------
        # Home / Away split multiplier
        # ----------------------------------------------------------------
        ha_factor = 1.0
        if home_away in ("H", "A"):
            flag = "H" if home_away == "H" else "R"
            ha_games = [g for g in gamelog if g.get("homeRoadFlag") == flag]
            if ha_games and season_gpg > 0:
                ha_gpg = sum(g.get("goals", 0) for g in ha_games) / len(ha_games)
                raw_ha = ha_gpg / season_gpg
                ha_factor = max(0.80, min(1.30, raw_ha))
                factors["homeAwayGPG"] = round(ha_gpg, 3)
                if ha_factor >= 1.15:
                    label = "🏠 Home boost" if home_away == "H" else "✈️ Road warrior"
                    key_factors.append(label)
                elif ha_factor <= 0.85:
                    label = "📉 Weak at home" if home_away == "H" else "📉 Struggles away"
                    key_factors.append(label)
        factors["homeAwayFactor"] = round(ha_factor, 3)

        # ----------------------------------------------------------------
        # Streak momentum (additive)
        # ----------------------------------------------------------------
        sorted_gl = sorted(gamelog, key=lambda g: g.get("gameDate", ""))
        active_streak = 0
        for g in reversed(sorted_gl):
            if g.get("goals", 0) > 0:
                active_streak += 1
            else:
                break

        streak_adj = 0.0
        if active_streak >= 3:
            streak_adj = min(active_streak * 0.03, 0.15)
            key_factors.append(f"🔥 {active_streak}-game streak")
        elif active_streak == 0:
            scoreless_run = 0
            for g in reversed(sorted_gl):
                if g.get("goals", 0) == 0:
                    scoreless_run += 1
                else:
                    break
            if scoreless_run >= 5:
                streak_adj = -min(scoreless_run * 0.02, 0.10)
                key_factors.append(f"❄️ {scoreless_run}-game slump")

        factors["activeStreak"] = active_streak
        factors["streakAdj"]    = round(streak_adj, 4)

        # ----------------------------------------------------------------
        # Combine
        # ----------------------------------------------------------------
        lam = lam_base * opp_factor * ha_factor + streak_adj
        lam = max(lam, 0.0)

        factors["lambda"]     = round(lam, 4)
        factors["keyFactors"] = key_factors

        return lam, factors

    def poisson_prob(self, lam: float) -> float:
        """P(X >= 1) for a Poisson random variable with mean λ."""
        if lam <= 0:
            return 0.0
        return 1.0 - math.exp(-lam)

    # ------------------------------------------------------------------ #
    # Odds formatting                                                      #
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
        decimal = 1 / prob - 1
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
    # Rank players                                                         #
    # ------------------------------------------------------------------ #

    def rank_players(self, players: List[Dict]) -> List[Dict]:
        """
        Rank players by enhanced prediction model probability.
        Each player dict may include 'tonightGame' with opponent/homeAway context.
        """
        results = []
        for p in players:
            gamelog = p.get("gamelog", [])

            # Extract tonight's matchup context if available
            game = p.get("tonightGame") or {}
            opponent  = game.get("opponent")
            home_away = game.get("homeAway")

            lam, factors = self.expected_goals_enhanced(gamelog, opponent, home_away)
            prob = round(self.poisson_prob(lam), 4)

            n = len(gamelog)
            total_goals = sum(g.get("goals", 0) for g in gamelog)
            recent = sorted(gamelog, key=lambda g: g.get("gameDate", ""), reverse=True)[:10]
            recent_goals = sum(g.get("goals", 0) for g in recent)

            results.append({
                **{k: v for k, v in p.items() if k != "gamelog"},
                "probability":     prob,
                "impliedPct":      round(prob * 100, 1),
                "expectedGoals":   round(lam, 3),
                "americanOdds":    self.to_american(prob),
                "decimalOdds":     self.to_decimal(prob),
                "fractionalOdds":  self.to_fractional(prob),
                "seasonGPG":       round(total_goals / n, 3) if n else 0,
                "recentGoals10":   recent_goals,
                "recentGPG":       round(recent_goals / len(recent), 3) if recent else 0,
                "gamesPlayed":     n,
                "seasonGoals":     total_goals,
                "modelFactors":    factors,
                "keyFactors":      factors.get("keyFactors", []),
            })

        return sorted(results, key=lambda x: x["probability"], reverse=True)

    # ------------------------------------------------------------------ #
    # Confidence tier                                                      #
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
