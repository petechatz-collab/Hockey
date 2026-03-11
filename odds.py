"""
NHL Goal Scorer Odds & Advanced Prediction Model.

─────────────────────────────────────────────────────────────────────────
MODEL OVERVIEW  (v3 — Enhanced)
─────────────────────────────────────────────────────────────────────────

P(score ≥ 1) = 1 − e^(−λ)   [Poisson]

λ (expected goals) is built in three layers:

  LAYER 1 — Base rate  (weighted blend of stable scoring metrics)
  ──────────────────────────────────────────────────────────────
  If MoneyPuck xG data available:
    ixGpg      × 0.35   individual expected goals per game (xG model)
    recent_gpg × 0.25   actual goals — last 10 games (hot-hand)
    ev_ixGpg   × 0.15   even-strength xG per game (quality shots)
    consistency× 0.10   fraction of games the player scored
    hd_rate    × 0.15   high-danger scoring rate per game
                ─────
                1.00

  Fallback (no MoneyPuck data):
    season_gpg × 0.25
    recent_gpg × 0.35
    consistency× 0.10
    shot_proxy × 0.15   shots/g × shooting %
    pp_rate    × 0.15   PP goals/game
                ─────
                1.00

  LAYER 2 — Multiplicative matchup adjustments
  ──────────────────────────────────────────────
  × opponent_factor   [0.70, 1.50]  — goals/game vs tonight's specific team
  × home_away_factor  [0.80, 1.30]  — home vs away goal split
  × corsi_factor      [0.93, 1.08]  — xGF% possession quality from MoneyPuck

  LAYER 3 — Additive context adjustments
  ─────────────────────────────────────
  + streak_adj    [−0.10, +0.15]  — active streak bonus / slump penalty
  + fatigue_adj   [−0.08,  0.00]  — back-to-back / 3-in-4 fatigue
  + goalie_adj    [−0.04, +0.04]  — opponent goalie save % vs league avg
  + defense_adj   [−0.03, +0.03]  — opponent team defense rank

─────────────────────────────────────────────────────────────────────────
Outputs: probability, American / decimal / fractional fair odds, tiers,
         full model breakdown, key-factor emoji labels.
─────────────────────────────────────────────────────────────────────────
"""

import math
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

# League-average goalie save% used for the goalie quality adjustment
_LEAGUE_AVG_SV = 0.910


class OddsCalculator:

    # ------------------------------------------------------------------ #
    # Internal helpers                                                     #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _clamp(val: float, lo: float, hi: float) -> float:
        return max(lo, min(hi, val))

    @staticmethod
    def _days_ago(date_str: str) -> int:
        """Days between today and a YYYY-MM-DD date string."""
        try:
            d = datetime.strptime(date_str[:10], "%Y-%m-%d").date()
            return (datetime.now().date() - d).days
        except Exception:
            return 999

    # ------------------------------------------------------------------ #
    # Enhanced prediction model — Layer 1 (base λ)                        #
    # ------------------------------------------------------------------ #

    def _base_lambda(
        self,
        gamelog: List[Dict],
        mp_all: Optional[Dict] = None,
        mp_ev:  Optional[Dict] = None,
    ) -> Tuple[float, Dict]:
        """
        Compute the base λ from scoring rate components.
        Returns (λ_base, component_dict).
        """
        n = len(gamelog)
        if n == 0:
            return 0.0, {}

        total_goals  = sum(g.get("goals", 0) for g in gamelog)
        total_shots  = sum(g.get("shots", 0) for g in gamelog)
        total_pp     = sum(g.get("powerPlayGoals", 0) for g in gamelog)

        season_gpg   = total_goals / n
        pp_rate      = total_pp / n

        recent = sorted(gamelog, key=lambda g: g.get("gameDate", ""), reverse=True)[:10]
        recent_goals = sum(g.get("goals", 0) for g in recent)
        recent_gpg   = recent_goals / len(recent) if recent else season_gpg

        scoring_games= sum(1 for g in gamelog if g.get("goals", 0) > 0)
        consistency  = scoring_games / n

        sh_pct       = total_goals / total_shots if total_shots else 0
        shots_pg     = total_shots / n
        shot_proxy   = shots_pg * sh_pct

        comps = {
            "seasonGPG":  round(season_gpg, 3),
            "recentGPG":  round(recent_gpg, 3),
            "consistency":round(consistency, 3),
            "shotProxy":  round(shot_proxy,  3),
            "ppRate":     round(pp_rate,     3),
            "shotsPerGame":round(shots_pg,   2),
            "shootingPct": round(sh_pct * 100, 1),
        }

        # ── Use MoneyPuck xG data when available ──
        if mp_all and mp_all.get("ixGpg"):
            ixgpg    = mp_all["ixGpg"]
            ev_ixgpg = (mp_ev or {}).get("ixGpg", ixgpg * 0.70)
            gp       = max(mp_all.get("gamesPlayed", 1), 1)
            hd_rate  = mp_all.get("iHDGoals", 0) / gp

            lam = (
                ixgpg    * 0.35
                + recent_gpg * 0.25
                + ev_ixgpg   * 0.15
                + consistency* 0.10
                + hd_rate    * 0.15
            )
            comps.update({
                "ixGpg":    round(ixgpg, 4),
                "evIxGpg":  round(ev_ixgpg, 4),
                "hdRate":   round(hd_rate, 4),
                "source":   "moneypuck",
            })
        else:
            # Fallback: pure gamelog-derived
            lam = (
                season_gpg  * 0.25
                + recent_gpg  * 0.35
                + consistency * 0.10
                + shot_proxy  * 0.15
                + pp_rate     * 0.15
            )
            comps["source"] = "gamelog"

        return max(lam, 0.0), comps

    # ------------------------------------------------------------------ #
    # Layer 2 — Multiplicative matchup factors                            #
    # ------------------------------------------------------------------ #

    def _matchup_factors(
        self,
        gamelog: List[Dict],
        season_gpg: float,
        opponent: Optional[str],
        home_away: Optional[str],
        mp_all: Optional[Dict],
    ) -> Tuple[float, float, float, Dict]:
        """
        Returns (opp_factor, ha_factor, corsi_factor, details_dict).
        """
        details: Dict = {}
        key_factors: List[str] = []

        # ── vs-opponent history ──
        opp_factor = 1.0
        if opponent and season_gpg > 0:
            opp_games = [g for g in gamelog if g.get("opponentAbbrev") == opponent]
            if len(opp_games) >= 2:
                opp_gpg = sum(g.get("goals", 0) for g in opp_games) / len(opp_games)
                raw = opp_gpg / season_gpg
                opp_factor = self._clamp(raw, 0.70, 1.50)
                details["vsOpponentGPG"]   = round(opp_gpg, 3)
                details["vsOpponentGames"] = len(opp_games)
                if opp_factor >= 1.20:
                    key_factors.append(f"💪 Scores vs {opponent}")
                elif opp_factor <= 0.80:
                    key_factors.append(f"🚫 Struggles vs {opponent}")
            else:
                details["vsOpponentGames"] = len(opp_games)
        details["opponentFactor"] = round(opp_factor, 3)

        # ── Home / Away split ──
        ha_factor = 1.0
        if home_away in ("H", "A") and season_gpg > 0:
            flag     = "H" if home_away == "H" else "R"
            ha_games = [g for g in gamelog if g.get("homeRoadFlag") == flag]
            if ha_games:
                ha_gpg = sum(g.get("goals", 0) for g in ha_games) / len(ha_games)
                raw_ha = ha_gpg / season_gpg
                ha_factor = self._clamp(raw_ha, 0.80, 1.30)
                details["homeAwayGPG"] = round(ha_gpg, 3)
                details["homeAwayFlag"]= "home" if home_away == "H" else "away"
                if ha_factor >= 1.15:
                    key_factors.append("🏠 Home boost" if home_away == "H" else "✈️ Road warrior")
                elif ha_factor <= 0.85:
                    key_factors.append("📉 Weak at home" if home_away == "H" else "📉 Struggles away")
        details["homeAwayFactor"] = round(ha_factor, 3)

        # ── Possession / xG quality (MoneyPuck CF% / xGF%) ──
        corsi_factor = 1.0
        if mp_all:
            xgf_pct = mp_all.get("xGF%", 50.0)
            raw_cf  = 1.0 + (xgf_pct - 50.0) / 100.0 * 0.60
            corsi_factor = self._clamp(raw_cf, 0.93, 1.08)
            details["xGF%"]       = xgf_pct
            details["CF%"]        = mp_all.get("CF%", 50.0)
            details["FF%"]        = mp_all.get("FF%", 50.0)
            details["HDCF%"]      = mp_all.get("HDCF%", 50.0)
            details["corsiFactor"]= round(corsi_factor, 3)
            if corsi_factor >= 1.05:
                key_factors.append("📈 Elite possession")
            elif corsi_factor <= 0.96:
                key_factors.append("📉 Low possession")

        return opp_factor, ha_factor, corsi_factor, details, key_factors

    # ------------------------------------------------------------------ #
    # Layer 3 — Additive context adjustments                              #
    # ------------------------------------------------------------------ #

    def _context_adjustments(
        self,
        gamelog: List[Dict],
        goalie_sv_pct: Optional[float],
        defense_rank: Optional[int],
        game_date: Optional[str],
    ) -> Tuple[float, Dict, List[str]]:
        """
        Returns (total_adj, details_dict, key_factors).
        """
        details: Dict = {}
        key_factors: List[str] = []
        total_adj = 0.0

        # ── Streak / slump momentum ──
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
            scoreless = 0
            for g in reversed(sorted_gl):
                if g.get("goals", 0) == 0:
                    scoreless += 1
                else:
                    break
            if scoreless >= 5:
                streak_adj = -min(scoreless * 0.02, 0.10)
                key_factors.append(f"❄️ {scoreless}-game slump")
        details["activeStreak"] = active_streak
        details["streakAdj"]    = round(streak_adj, 4)
        total_adj += streak_adj

        # ── Fatigue ──
        fatigue_adj = 0.0
        if sorted_gl:
            last_game_date  = sorted_gl[-1].get("gameDate", "")
            days_rest       = self._days_ago(last_game_date)
            recent_5_dates  = [g.get("gameDate", "") for g in sorted_gl[-5:]]

            # Back-to-back (game yesterday)
            if days_rest == 1:
                fatigue_adj = -0.05
                key_factors.append("😴 Back-to-back")
            # 3rd game in 4 days
            elif days_rest <= 3 and len(recent_5_dates) >= 3:
                # count games in last 4 days
                today = (datetime.now().date() if not game_date
                         else datetime.strptime(game_date[:10], "%Y-%m-%d").date())
                in_window = sum(
                    1 for d in recent_5_dates
                    if d and (today - datetime.strptime(d[:10], "%Y-%m-%d").date()).days <= 4
                )
                if in_window >= 2:
                    fatigue_adj = -0.03
                    key_factors.append("🏃 High workload")

        details["fatigueAdj"] = round(fatigue_adj, 4)
        total_adj += fatigue_adj

        # ── Goalie quality ──
        goalie_adj = 0.0
        if goalie_sv_pct is not None:
            # + means weaker goalie (easier to score), − means elite goalie
            goalie_adj = self._clamp(
                (_LEAGUE_AVG_SV - goalie_sv_pct) * 0.50, -0.04, 0.04
            )
            details["goalieSvPct"] = round(goalie_sv_pct, 3)
            details["goalieAdj"]   = round(goalie_adj, 4)
            if goalie_sv_pct >= 0.925:
                key_factors.append("🧤 Elite goalie")
            elif goalie_sv_pct <= 0.895:
                key_factors.append("🟢 Vulnerable goalie")
        total_adj += goalie_adj

        # ── Opponent defense rank ──
        defense_adj = 0.0
        if defense_rank is not None:
            # rank 1 = best defense → negative adj; rank 32 = worst → positive adj
            # maps [1, 32] → [−0.03, +0.03]
            defense_adj = self._clamp(
                (defense_rank - 16.5) / 31.0 * 0.06, -0.03, 0.03
            )
            details["defenseRank"] = defense_rank
            details["defenseAdj"]  = round(defense_adj, 4)
            if defense_rank <= 5:
                key_factors.append("🛡️ Stingy defense")
            elif defense_rank >= 28:
                key_factors.append("🎯 Leaky defense")
        total_adj += defense_adj

        return total_adj, details, key_factors

    # ------------------------------------------------------------------ #
    # Public: compute λ + full breakdown                                   #
    # ------------------------------------------------------------------ #

    def expected_goals_enhanced(
        self,
        gamelog: List[Dict],
        opponent:      Optional[str]   = None,
        home_away:     Optional[str]   = None,   # "H" or "A"
        mp_all:        Optional[Dict]  = None,   # MoneyPuck all-sit stats
        mp_ev:         Optional[Dict]  = None,   # MoneyPuck 5on5 stats
        goalie_sv_pct: Optional[float] = None,
        defense_rank:  Optional[int]   = None,
        game_date:     Optional[str]   = None,
    ) -> Tuple[float, Dict]:
        """
        Full three-layer model.
        Returns (λ, factors_dict) where factors_dict contains complete breakdown.
        """
        n = len(gamelog)
        if n == 0:
            return 0.0, {}

        # Layer 1
        lam_base, comps = self._base_lambda(gamelog, mp_all, mp_ev)
        season_gpg      = comps.get("seasonGPG", 0.0)

        # Layer 2
        opp_f, ha_f, cf_f, matchup_details, matchup_keys = self._matchup_factors(
            gamelog, season_gpg, opponent, home_away, mp_all
        )

        # Layer 3
        adj, ctx_details, ctx_keys = self._context_adjustments(
            gamelog, goalie_sv_pct, defense_rank, game_date
        )

        # Combine
        lam = lam_base * opp_f * ha_f * cf_f + adj
        lam = max(lam, 0.0)

        # Situation splits (derived from gamelog)
        total_goals = sum(g.get("goals", 0) for g in gamelog)
        total_pp    = sum(g.get("powerPlayGoals", 0) for g in gamelog)
        ev_goals    = max(total_goals - total_pp, 0)

        # MoneyPuck PP/EV situation rates
        mp_pp_ixgpg = None
        if mp_all and "pp" in (mp_all or {}):
            pp_data = mp_all.get("pp", {})
            mp_pp_ixgpg = pp_data.get("ixGpg")

        factors: Dict = {
            **comps,
            **matchup_details,
            **ctx_details,
            # Situation splits
            "totalGoals":   total_goals,
            "ppGoals":      total_pp,
            "evGoals":      ev_goals,
            "ppGPG":        round(total_pp / n, 4),
            "evGPG":        round(ev_goals / n, 4),
            "ppGoalPct":    round(total_pp / total_goals * 100, 1) if total_goals else 0,
            "evGoalPct":    round(ev_goals / total_goals * 100, 1) if total_goals else 0,
            # MoneyPuck situational xG
            "mpPPixGpg":    round(mp_pp_ixgpg, 4) if mp_pp_ixgpg is not None else None,
            # Final λ breakdown
            "baseLambda":   round(lam_base, 4),
            "oppFactor":    round(opp_f, 3),
            "haFactor":     round(ha_f,  3),
            "corsiFactor":  round(cf_f,  3),
            "contextAdj":   round(adj,   4),
            "lambda":       round(lam,   4),
            # Key factors (combined + de-duped)
            "keyFactors":   list(dict.fromkeys(matchup_keys + ctx_keys)),
        }

        return lam, factors

    # ------------------------------------------------------------------ #
    # Poisson probability                                                  #
    # ------------------------------------------------------------------ #

    def poisson_prob(self, lam: float) -> float:
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
    # Rank a list of players                                               #
    # ------------------------------------------------------------------ #

    def rank_players(
        self,
        players: List[Dict],
        mp_stats: Optional[Dict] = None,         # {all: {pid:...}, ev: {pid:...}, pp: {pid:...}}
        defense_ranks: Optional[Dict] = None,    # {team_abbrev: {defenseRank, gaPerGame}}
        goalie_pcts: Optional[Dict]   = None,    # {byTeam: {team: {svPct,...}}}
        game_date: Optional[str]      = None,
    ) -> List[Dict]:
        """
        Rank players by enhanced probability.
        Accepts optional MoneyPuck, defense, and goalie context for richer model.
        """
        mp_all_map = (mp_stats or {}).get("all", {})
        mp_ev_map  = (mp_stats or {}).get("ev",  {})
        goalie_by_team = (goalie_pcts or {}).get("byTeam", {})

        results = []
        for p in players:
            gamelog = p.get("gamelog", [])
            pid     = p.get("playerId")

            # Matchup context
            game      = p.get("tonightGame") or {}
            opponent  = game.get("opponent")
            home_away = game.get("homeAway")
            opp_team  = opponent or ""

            # MoneyPuck per-player stats
            mp_all = mp_all_map.get(pid) if pid else None
            mp_ev  = mp_ev_map.get(pid)  if pid else None

            # Goalie quality (opponent team's likely starter)
            goalie_sv_pct = None
            if opp_team and goalie_by_team:
                starter = goalie_by_team.get(opp_team, {})
                goalie_sv_pct = starter.get("svPct")

            # Defense rank (opponent team)
            defense_rank = None
            if opp_team and defense_ranks:
                dr = defense_ranks.get(opp_team, {})
                defense_rank = dr.get("defenseRank")

            lam, factors = self.expected_goals_enhanced(
                gamelog,
                opponent=opponent,
                home_away=home_away,
                mp_all=mp_all,
                mp_ev=mp_ev,
                goalie_sv_pct=goalie_sv_pct,
                defense_rank=defense_rank,
                game_date=game_date,
            )
            prob = round(self.poisson_prob(lam), 4)

            n = len(gamelog)
            total_goals  = sum(g.get("goals", 0) for g in gamelog)
            recent = sorted(gamelog, key=lambda g: g.get("gameDate", ""), reverse=True)[:10]
            recent_goals = sum(g.get("goals", 0) for g in recent)

            results.append({
                **{k: v for k, v in p.items() if k != "gamelog"},
                "probability":    prob,
                "impliedPct":     round(prob * 100, 1),
                "expectedGoals":  round(lam, 3),
                "americanOdds":   self.to_american(prob),
                "decimalOdds":    self.to_decimal(prob),
                "fractionalOdds": self.to_fractional(prob),
                "seasonGPG":      round(total_goals / n, 3) if n else 0,
                "recentGoals10":  recent_goals,
                "recentGPG":      round(recent_goals / len(recent), 3) if recent else 0,
                "gamesPlayed":    n,
                "seasonGoals":    total_goals,
                "modelFactors":   factors,
                "keyFactors":     factors.get("keyFactors", []),
                # Situation splits surfaced at top level for easy UI access
                "ppGoals":        factors.get("ppGoals", 0),
                "evGoals":        factors.get("evGoals", 0),
                "ppGPG":          factors.get("ppGPG", 0),
                "evGPG":          factors.get("evGPG", 0),
                # MoneyPuck advanced stats surfaced top-level
                "ixG":            mp_all.get("ixG") if mp_all else None,
                "ixGpg":          mp_all.get("ixGpg") if mp_all else None,
                "CF%":            mp_all.get("CF%") if mp_all else None,
                "FF%":            mp_all.get("FF%") if mp_all else None,
                "xGF%":           mp_all.get("xGF%") if mp_all else None,
                "HDCF%":          mp_all.get("HDCF%") if mp_all else None,
                "iHDGoals":       mp_all.get("iHDGoals") if mp_all else None,
                "iHDSh%":         mp_all.get("iHDSh%") if mp_all else None,
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
