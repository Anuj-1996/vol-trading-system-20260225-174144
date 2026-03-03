from __future__ import annotations

from .agent_base import AgentContext, BaseAgent
from .gemini_client import GeminiClient


class MarketIntelAgent(BaseAgent):
    """
    Analyzes market microstructure, regime conditions, volatility dynamics,
    and generates institutional-grade market commentary.
    """

    def __init__(self, gemini_client: GeminiClient) -> None:
        super().__init__(gemini_client)

    @property
    def name(self) -> str:
        return "market_intel"

    @property
    def role(self) -> str:
        return "Market Intelligence Analyst"

    @property
    def system_prompt(self) -> str:
        return """You are a NIFTY options market intelligence analyst.
Analyze: regime (low_vol/normal/high_vol/crisis), ATM IV, RV spread, IV rank, term structure, skew, max pain.
Output: REGIME STATUS, VOLATILITY SNAPSHOT, TERM STRUCTURE, SKEW & FLOW, KEY SIGNAL.
Be precise with numbers. Concise answers only."""

    def build_context_prompt(self, context: AgentContext) -> str:
        lines = []
        mo = context.market_overview or {}
        for k in ["spot", "atm_market_iv", "atm_model_iv", "rv_20d", "iv_rank",
                  "iv_percentile", "realized_implied_spread"]:
            if k in mo:
                lines.append(f"{k}={mo[k]}")
        rg = context.regime or {}
        for k in ["regime", "confidence", "vol_regime_score", "trend"]:
            if k in rg:
                lines.append(f"{k}={rg[k]}")
        if context.surface:
            s = context.surface
            if "expiry_labels" in s:
                lines.append(f"expiries={s['expiry_labels']}")
            if "max_pain_by_expiry" in s:
                labels = s.get("expiry_labels", [])
                mp = s["max_pain_by_expiry"]
                pairs = [f"{labels[i]}:{mp[i]}" for i in range(min(len(labels), len(mp)))]
                lines.append(f"max_pain={','.join(pairs)}")
            if "market_iv_matrix" in s:
                import numpy as np
                arr = np.array(s["market_iv_matrix"], dtype=float)
                lines.append(f"iv_range=[{arr.min():.4f},{arr.max():.4f}] mean={arr.mean():.4f}")
        return "\n".join(lines)
