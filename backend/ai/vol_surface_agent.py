from __future__ import annotations

import numpy as np

from .agent_base import AgentContext, BaseAgent
from .gemini_client import GeminiClient


class VolSurfaceAgent(BaseAgent):
    """
    Deep volatility specialist: IV surface topology, realized vs implied dynamics,
    historical vol regimes, IV rank/percentile interpretation, skew analytics,
    term structure signals, and 3-D vol surface guidance.
    """

    def __init__(self, gemini_client: GeminiClient) -> None:
        super().__init__(gemini_client)

    @property
    def name(self) -> str:
        return "vol_surface"

    @property
    def role(self) -> str:
        return "Volatility Surface Analyst"

    @property
    def system_prompt(self) -> str:
        return """You are the Volatility Surface Agent for an institutional-grade NIFTY options stochastic volatility trading system built on the Heston model with Carr-Madan FFT pricing.

ROLE: Senior volatility quant / vol surface specialist at a derivatives desk.  You are the go-to expert for EVERYTHING related to volatility — implied, realized, historical, forward, local, and stochastic.

DOMAIN KNOWLEDGE:
- **Implied Volatility Surface (IVS)**: 3-D surface of IV across strikes (moneyness) and maturities.  You can read shape, curvature, smile/smirk asymmetry, wing behavior, and interpolation artifacts.
- **IV Rank & IV Percentile**: IV Rank = (current IV − 52-wk low) / (52-wk high − 52-wk low).  IV Percentile = % of days in the past year with IV lower than current.  You explain the trading implications of each.
- **Realized Volatility (RV)**: Close-to-close, Parkinson, Yang-Zhang estimators across 10-d, 20-d, 60-d windows.  You interpret RV trends and momentum.
- **Historical Volatility (HV)**: Longer-lookback (90-d, 252-d) baseline for structural vol levels.
- **IV–RV Spread**: The volatility risk premium.  Positive spread = vol selling edge.  Negative = gamma buying opportunity.  You quantify the edge.
- **Vol-of-Vol (VoV / VVIX equivalent)**: Measures instability of the IV surface itself.  High VoV = whipsaw risk for short-gamma books.
- **Term Structure**: Contango (normal — far month > near month IV) vs backwardation (inverted — near > far).  You explain roll dynamics, calendar spread signals, and event-driven kinks.
- **Skew Analytics**: Put-call skew slope, 25-delta risk reversal, butterfly (convexity), wing richness.  You detect unusual skew patterns and their flow implications.
- **Smile Dynamics**: Sticky-strike vs sticky-delta vs sticky-local-vol regimes.  You identify which regime is active and the hedging implications.
- **Surface Arbitrage**: Detect calendar spread arbitrage, butterfly arbitrage, negative probability density warnings from the surface.
- **Heston Model Surface**: You compare the model-implied surface vs market surface — residual surface analysis, where the model over/under-prices, and what that means for trading.

OUTPUT FORMAT — adapt flexibly, but default structure:

**VOL SURFACE TOPOLOGY**
- Shape: [smile / smirk / flat / W-shape]
- ATM IV level, moneyness range covered, number of expiries
- Notable features (kinks, discontinuities, illiquid wings)

**IV RANK & PERCENTILE**
- Current IV Rank: [X%] — interpretation
- Current IV Percentile: [Y%] — interpretation
- Where we are in the vol cycle (compressed / expanding / mean-reverting)

**REALIZED vs IMPLIED**
- RV 10d / 20d / 60d — trend direction
- IV–RV spread — sign, magnitude, persistence
- Volatility risk premium (VRP) — edge assessment

**TERM STRUCTURE**
- Shape: [contango / backwardation / humped / kinked]
- Near-month vs far-month IV differential
- Event-driven distortions (expiry pinning, result season)
- Calendar spread signals

**SKEW & WINGS**
- Put-call skew slope (25Δ proxy)
- Wing richness (OTM puts vs OTM calls relative pricing)
- Unusual flow-driven skew shifts
- Butterfly value (convexity)

**MODEL vs MARKET RESIDUALS**
- Where Heston over-prices / under-prices
- Residual surface hotspots (expiry × strike zones)
- Wing fit quality
- RMSE by maturity bucket

**3-D SURFACE GUIDANCE** (when user asks about plots)
- How to read the 3-D vol surface plot (X=strike/moneyness, Y=maturity, Z=IV)
- What the color gradient / contour lines show
- How to spot tradeable dislocations visually
- Comparison: market surface vs model surface vs residual surface

**KEY VOLATILITY SIGNAL**: [Single most actionable vol insight]

RULES:
- Be precise: quote exact IV levels, spreads, ranks with numbers from the data.
- When IV Rank < 25%, explicitly flag: "Compressed vol — potential long-gamma / long-vega opportunity."
- When IV Rank > 75%, flag: "Elevated vol — potential short-gamma / premium-selling opportunity."
- When IV–RV spread > +5%, flag: "Rich implied volatility — vol selling edge present."
- When IV–RV spread < -3%, flag: "Cheap implied — gamma buying / protective strategies favored."
- When term structure is inverted, flag: "Backwardation — near-term event risk, avoid naked short gamma near-month."
- When skew slope is abnormally steep (>2× normal), flag: "Extreme put skew — tail hedging demand elevated."
- If data is missing, state it explicitly — never fabricate numbers.
- Use concise, institutional-grade language.  No filler or disclaimers."""

    def build_context_prompt(self, context: AgentContext) -> str:
        sections = ["--- VOLATILITY DATA FOR DEEP ANALYSIS ---"]

        # ── Market overview (IV rank, RV, VRP, etc.) ──
        if context.market_overview:
            mo = context.market_overview
            vol_snapshot = {}
            vol_keys = [
                "spot", "atm_market_iv", "atm_model_iv",
                "realized_implied_spread",
                "rv_10d", "rv_20d", "rv_60d", "rv_percentile",
                "iv_rank", "iv_percentile", "vvix_equivalent",
            ]
            for k in vol_keys:
                if k in mo:
                    vol_snapshot[k] = mo[k]
            sections.append(f"MARKET VOLATILITY SNAPSHOT:\n{self._format_dict(vol_snapshot)}")

        # ── Full surface data ──
        if context.surface:
            s = context.surface
            # Strike grid summary
            if "strike_grid" in s:
                grid = s["strike_grid"]
                sections.append(
                    f"STRIKE GRID: {len(grid)} strikes, range [{grid[0]:.0f} … {grid[-1]:.0f}]"
                    if isinstance(grid, list) and grid else
                    f"STRIKE GRID: {self._format_dict({'strike_grid': grid})}"
                )
            # Maturity grid
            if "maturity_grid" in s:
                mg = s["maturity_grid"]
                sections.append(
                    f"MATURITY GRID (year fractions): {[round(t, 4) for t in mg]}"
                    if isinstance(mg, list) else
                    f"MATURITY GRID: {mg}"
                )
            # Expiry labels
            if "expiry_labels" in s:
                sections.append(f"EXPIRY LABELS: {s['expiry_labels']}")

            # Market IV matrix — derive surface statistics
            if "market_iv_matrix" in s:
                self._add_surface_stats(sections, s["market_iv_matrix"], "MARKET IV SURFACE")
            # Model IV matrix
            if "model_iv_matrix" in s:
                self._add_surface_stats(sections, s["model_iv_matrix"], "MODEL IV SURFACE (Heston)")
            # Residual surface
            if "residual_iv_matrix" in s:
                self._add_surface_stats(sections, s["residual_iv_matrix"], "RESIDUAL SURFACE (Model − Market)")

            # OI and max pain
            if "max_pain_by_expiry" in s:
                sections.append(f"MAX PAIN BY EXPIRY: {self._format_dict(dict(zip(s.get('expiry_labels', []), s['max_pain_by_expiry'])))}")

            # Term structure: ATM IV per expiry
            if "market_iv_matrix" in s and "strike_grid" in s:
                self._add_term_structure(sections, s)

            # Skew per expiry
            if "market_iv_matrix" in s and "strike_grid" in s:
                self._add_skew_analysis(sections, s)

        # ── Regime (vol regime score, skew regime score) ──
        if context.regime:
            sections.append(f"REGIME CLASSIFICATION:\n{self._format_dict(context.regime)}")

        # ── Calibration (Heston params → model surface quality) ──
        if context.calibration:
            cal_subset = {}
            for k in ["parameters", "weighted_rmse", "converged", "iterations"]:
                if k in context.calibration:
                    cal_subset[k] = context.calibration[k]
            sections.append(f"HESTON CALIBRATION:\n{self._format_dict(cal_subset)}")

        return "\n\n".join(sections)

    # ── helpers ──────────────────────────────────────────────────

    @staticmethod
    def _add_surface_stats(sections: list, matrix_data, label: str) -> None:
        """Compute summary statistics from an IV matrix."""
        try:
            arr = np.array(matrix_data, dtype=float)
            valid = arr[np.isfinite(arr)]
            if valid.size == 0:
                sections.append(f"{label}: empty or all-NaN")
                return
            stats = {
                "shape": f"{arr.shape[0]} expiries × {arr.shape[1]} strikes",
                "min": round(float(valid.min()), 6),
                "max": round(float(valid.max()), 6),
                "mean": round(float(valid.mean()), 6),
                "std": round(float(valid.std()), 6),
                "median": round(float(np.median(valid)), 6),
            }
            # Per-expiry ATM-ish stats (middle column)
            mid = arr.shape[1] // 2
            atm_slice = arr[:, max(0, mid - 2): mid + 3]
            if atm_slice.size:
                stats["atm_band_mean"] = round(float(atm_slice.mean()), 6)
                stats["atm_band_std"] = round(float(atm_slice.std()), 6)
            # Wing stats
            wing_width = max(1, arr.shape[1] // 6)
            left_wing = arr[:, :wing_width]
            right_wing = arr[:, -wing_width:]
            if left_wing.size:
                stats["put_wing_mean"] = round(float(left_wing.mean()), 6)
            if right_wing.size:
                stats["call_wing_mean"] = round(float(right_wing.mean()), 6)

            sections.append(f"{label}:\n  " + "\n  ".join(f"{k}: {v}" for k, v in stats.items()))
        except Exception:
            sections.append(f"{label}: [unable to parse matrix]")

    @staticmethod
    def _add_term_structure(sections: list, surface: dict) -> None:
        """Extract ATM IV per expiry to show term structure."""
        try:
            grid = surface["strike_grid"]
            matrix = np.array(surface["market_iv_matrix"], dtype=float)
            labels = surface.get("expiry_labels", [f"T{i}" for i in range(matrix.shape[0])])
            # Find ATM index (middle of grid as proxy)
            mid = len(grid) // 2
            atm_ivs = matrix[:, mid]
            term = {str(labels[i]): round(float(atm_ivs[i]), 6) for i in range(min(len(labels), len(atm_ivs)))}
            # Contango / backwardation
            if len(atm_ivs) >= 2:
                slope = "CONTANGO (normal)" if atm_ivs[-1] > atm_ivs[0] else "BACKWARDATION (inverted)"
                near_far_diff = round(float(atm_ivs[-1] - atm_ivs[0]), 6)
            else:
                slope = "single expiry"
                near_far_diff = 0.0
            sections.append(
                f"TERM STRUCTURE (ATM IV per expiry):\n"
                f"  {term}\n"
                f"  Shape: {slope}\n"
                f"  Near–Far IV diff: {near_far_diff}"
            )
        except Exception:
            pass

    @staticmethod
    def _add_skew_analysis(sections: list, surface: dict) -> None:
        """Compute per-expiry skew metrics."""
        try:
            grid = np.array(surface["strike_grid"], dtype=float)
            matrix = np.array(surface["market_iv_matrix"], dtype=float)
            labels = surface.get("expiry_labels", [f"T{i}" for i in range(matrix.shape[0])])
            mid = len(grid) // 2
            wing = max(1, len(grid) // 8)
            put_idx = max(0, mid - wing)
            call_idx = min(len(grid) - 1, mid + wing)
            skew_rows = []
            for i in range(min(len(labels), matrix.shape[0])):
                put_iv = float(matrix[i, put_idx])
                call_iv = float(matrix[i, call_idx])
                atm_iv = float(matrix[i, mid])
                skew = round(put_iv - call_iv, 6)
                butterfly = round((put_iv + call_iv) / 2 - atm_iv, 6)
                skew_rows.append(
                    f"  {labels[i]}: put_wing={round(put_iv,4)} call_wing={round(call_iv,4)} "
                    f"ATM={round(atm_iv,4)} skew={skew} butterfly={butterfly}"
                )
            sections.append("SKEW ANALYSIS (per expiry):\n" + "\n".join(skew_rows))
        except Exception:
            pass
