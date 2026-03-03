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
        return """You are a NIFTY options volatility surface analyst (Heston model + Carr-Madan FFT).
Analyze: IV surface shape (smile/smirk), IV rank/percentile, RV vs IV spread, term structure (contango/backwardation), skew, model residuals.
Key rules: IV Rank<25%=long-gamma opportunity, >75%=sell premium. IV-RV spread>+5%=vol selling edge, <-3%=gamma buying. Backwardation=near-term event risk.
Output: VOL SURFACE TOPOLOGY, IV RANK & PERCENTILE, REALIZED vs IMPLIED, TERM STRUCTURE, SKEW & WINGS, MODEL vs MARKET, KEY VOLATILITY SIGNAL.
Be precise with numbers. Concise answers only."""

    def build_context_prompt(self, context: AgentContext) -> str:
        lines = []
        mo = context.market_overview or {}
        for k in ["spot", "atm_market_iv", "atm_model_iv", "rv_10d", "rv_20d", "rv_60d",
                   "realized_implied_spread", "iv_rank", "iv_percentile", "vvix_equivalent"]:
            if k in mo:
                lines.append(f"{k}={mo[k]}")
        if context.surface:
            s = context.surface
            if "strike_grid" in s:
                g = s["strike_grid"]
                lines.append(f"strikes: {len(g)} range=[{g[0]:.0f}..{g[-1]:.0f}]" if g else "strikes: empty")
            if "maturity_grid" in s:
                lines.append(f"maturities={[round(t,4) for t in s['maturity_grid']]}")
            if "expiry_labels" in s:
                lines.append(f"expiries={s['expiry_labels']}")
            if "market_iv_matrix" in s:
                arr = np.array(s["market_iv_matrix"], dtype=float)
                lines.append(f"market_iv: shape={list(arr.shape)} range=[{arr.min():.4f},{arr.max():.4f}] mean={arr.mean():.4f}")
                # ATM term structure
                if "strike_grid" in s and arr.ndim == 2:
                    mid = arr.shape[1] // 2
                    atm_ivs = arr[:, mid]
                    labels = s.get("expiry_labels", [f"T{i}" for i in range(len(atm_ivs))])
                    ts = " ".join(f"{labels[i]}:{atm_ivs[i]:.4f}" for i in range(min(len(labels), len(atm_ivs))))
                    slope = "contango" if len(atm_ivs) >= 2 and atm_ivs[-1] > atm_ivs[0] else "backwardation"
                    lines.append(f"term_structure({slope}): {ts}")
            if "model_iv_matrix" in s:
                arr2 = np.array(s["model_iv_matrix"], dtype=float)
                lines.append(f"model_iv: range=[{arr2.min():.4f},{arr2.max():.4f}] mean={arr2.mean():.4f}")
            if "residual_iv_matrix" in s:
                res = np.array(s["residual_iv_matrix"], dtype=float)
                lines.append(f"residual: RMSE={np.sqrt(np.mean(res**2)):.6f} bias={np.mean(res):.6f}")
            if "max_pain_by_expiry" in s:
                labels = s.get("expiry_labels", [])
                mp = s["max_pain_by_expiry"]
                pairs = [f"{labels[i]}:{mp[i]}" for i in range(min(len(labels), len(mp)))]
                lines.append(f"max_pain: {' '.join(pairs)}")
        rg = context.regime or {}
        if rg:
            lines.append(f"regime={rg.get('regime','?')} conf={rg.get('confidence','')}")
        if context.calibration:
            cal = context.calibration
            p = cal.get("parameters", {})
            lines.append(f"heston: kappa={p.get('kappa','')} theta={p.get('theta','')} xi={p.get('xi','')} rho={p.get('rho','')} v0={p.get('v0','')}")
            lines.append(f"RMSE={cal.get('weighted_rmse','')} converged={cal.get('converged','')}")
        return "\n".join(lines)
