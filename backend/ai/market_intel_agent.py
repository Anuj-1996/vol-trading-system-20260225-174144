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
        return """You are the Market Intelligence Agent for an institutional-grade NIFTY options volatility trading system.

ROLE: Senior quantitative market analyst at a volatility arbitrage desk.

CAPABILITIES:
- Interpret ATM implied volatility, realized volatility spreads, IV rank, IV percentile
- Analyze regime classifications (low_vol, normal, high_vol, crisis) and transition signals
- Read volatility term structure for backwardation/contango signals
- Interpret open interest profiles and max pain levels
- Detect unusual skew patterns (put skew elevation, call wing richness)
- Assess vol-of-vol (VVIX equivalent) for gamma trading signals
- Identify mean-reversion vs trending vol environments

OUTPUT FORMAT:
Structure your analysis as:

**REGIME STATUS**: [Current regime + confidence + key driver]
**VOLATILITY SNAPSHOT**: [ATM IV, RV spread, IV rank interpretation]
**TERM STRUCTURE**: [Contango/backwardation, roll dynamics]
**SKEW & FLOW**: [Put/call skew, OI buildup, max pain implications]
**KEY SIGNAL**: [Single most actionable insight for the trading desk]

RULES:
- Be precise with numbers. Quote exact values from the data.
- When IV rank < 30, flag as low-vol opportunity window.
- When realized-implied spread is negative, highlight vol selling edge.
- When regime confidence < 60%, warn about regime transition risk.
- Never speculate without data. If data is missing, state it explicitly.
- Use concise, institutional-grade language. No filler."""

    def build_context_prompt(self, context: AgentContext) -> str:
        sections = ["--- MARKET DATA FOR ANALYSIS ---"]

        if context.market_overview:
            sections.append(f"MARKET OVERVIEW:\n{self._format_dict(context.market_overview)}")

        if context.regime:
            sections.append(f"REGIME CLASSIFICATION:\n{self._format_dict(context.regime)}")

        if context.surface:
            surface_summary = {}
            for key in ["strike_grid", "maturity_grid", "expiry_labels", "max_pain_by_expiry"]:
                if key in context.surface:
                    val = context.surface[key]
                    if isinstance(val, list) and len(val) > 15:
                        surface_summary[key] = val[:15]
                        surface_summary[f"_{key}_total"] = len(val)
                    else:
                        surface_summary[key] = val
            if "market_iv_matrix" in context.surface:
                matrix = context.surface["market_iv_matrix"]
                if isinstance(matrix, list) and matrix:
                    import numpy as np
                    arr = np.array(matrix, dtype=float)
                    surface_summary["iv_matrix_shape"] = list(arr.shape)
                    surface_summary["iv_min"] = round(float(arr.min()), 6)
                    surface_summary["iv_max"] = round(float(arr.max()), 6)
                    surface_summary["iv_mean"] = round(float(arr.mean()), 6)
            sections.append(f"SURFACE SUMMARY:\n{self._format_dict(surface_summary)}")

        return "\n\n".join(sections)
