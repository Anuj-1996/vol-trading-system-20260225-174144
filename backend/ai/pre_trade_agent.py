from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import numpy as np

from .agent_base import AgentContext, BaseAgent
from .gemini_client import GeminiClient


class PreTradeAgent(BaseAgent):
    """
    Performs pre-trade checks, scenario analysis, and generates
    what-if analysis for proposed positions before execution.
    """

    def __init__(self, gemini_client: GeminiClient) -> None:
        super().__init__(gemini_client)

    @property
    def name(self) -> str:
        return "pre_trade"

    @property
    def role(self) -> str:
        return "Pre-Trade Analyst"

    @property
    def system_prompt(self) -> str:
        return """You are the Pre-Trade Analysis Agent for an institutional-grade NIFTY options volatility trading system.

ROLE: Pre-trade risk and scenario analyst. You evaluate proposed trades BEFORE execution to identify hidden risks and opportunities.

CAPABILITIES:
- Scenario matrix analysis: compute P&L across spot moves x vol moves x time decay
- Evaluate margin-to-risk efficiency
- Assess edge decay: how quickly does the trade's edge disappear (theta bleed vs gamma benefit)?
- Compare implied vs realized convexity
- Evaluate skew exposure: is the trade long or short skew? What happens if skew shifts?
- Assess correlation between multiple positions
- Model early exercise risk for American-style considerations
- Evaluate liquidity risk at exit (will you be able to close at reasonable spread?)

OUTPUT FORMAT:
Structure your analysis as:

**PRE-TRADE VERDICT**: [APPROVE/CAUTION/REJECT] - [One-line reason]

**SCENARIO MATRIX** (estimated P&L):
| Scenario          | P&L Impact  | Probability |
|-------------------|-------------|-------------|
| Base case         | +XXX        | ~XX%        |
| Spot -3%          | -XXX        | ~XX%        |
| Spot +3%          | +/-XXX      | ~XX%        |
| Vol spike +20%    | +/-XXX      | ~XX%        |
| Vol crush -15%    | +/-XXX      | ~XX%        |
| 7-day time decay  | +/-XXX      | certain     |

**EDGE ANALYSIS**: [Where is the edge? How durable is it?]
**HIDDEN RISKS**: [Risks not captured by the primary metrics]
**OPTIMAL HOLDING PERIOD**: [When to take profit / cut loss]
**HEDGING OVERLAY**: [Suggested hedging to improve the risk profile]

RULES:
- Compute scenario P&L using Greeks: dP = delta*dS + 0.5*gamma*dS^2 + vega*dIV + theta*dT
- For spot moves, use the actual spot value to compute absolute changes.
- A move of 3% on NIFTY at 22000 = 660 points, scale accordingly.
- Flag if the trade has negative expected value but positive theta (common trap).
- Flag if the trade requires holding through an event (expiry, budget, RBI policy).
- Be quantitative and specific. No vague warnings."""

    def build_context_prompt(self, context: AgentContext) -> str:
        sections = ["--- PRE-TRADE ANALYSIS DATA ---"]

        if context.market_overview:
            sections.append(
                f"MARKET: spot={context.market_overview.get('spot')}, "
                f"atm_iv={context.market_overview.get('atm_market_iv')}, "
                f"rv20={context.market_overview.get('rv_20d')}"
            )

        if context.regime:
            sections.append(f"REGIME: {self._format_dict(context.regime)}")

        if context.top_strategies:
            # Focus on top 3 for detailed pre-trade analysis
            strategies = context.top_strategies[:3]
            detailed = []
            for strat in strategies:
                entry = {k: v for k, v in strat.items() if k != "pnl_distribution"}
                if "pnl_distribution" in strat and isinstance(strat["pnl_distribution"], list):
                    dist = strat["pnl_distribution"]
                    if dist:
                        arr = np.array(dist[:1000], dtype=float)
                        entry["pnl_stats"] = {
                            "mean": round(float(np.mean(arr)), 2),
                            "std": round(float(np.std(arr)), 2),
                            "skew": round(float(
                                np.mean(((arr - np.mean(arr)) / max(np.std(arr), 1e-8)) ** 3)
                            ), 4),
                            "kurtosis": round(float(
                                np.mean(((arr - np.mean(arr)) / max(np.std(arr), 1e-8)) ** 4)
                            ), 4),
                            "percentiles": {
                                "p1": round(float(np.percentile(arr, 1)), 2),
                                "p5": round(float(np.percentile(arr, 5)), 2),
                                "p25": round(float(np.percentile(arr, 25)), 2),
                                "p50": round(float(np.percentile(arr, 50)), 2),
                                "p75": round(float(np.percentile(arr, 75)), 2),
                                "p95": round(float(np.percentile(arr, 95)), 2),
                                "p99": round(float(np.percentile(arr, 99)), 2),
                            },
                        }
                detailed.append(entry)
            sections.append(f"STRATEGIES FOR PRE-TRADE CHECK:\n{json.dumps(detailed, default=str)}")

        if context.calibration:
            sections.append(f"MODEL QUALITY: RMSE={context.calibration.get('weighted_rmse')}, converged={context.calibration.get('converged')}")

        return "\n\n".join(sections)
