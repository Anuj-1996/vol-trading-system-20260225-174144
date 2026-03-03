from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import numpy as np

from .agent_base import AgentContext, BaseAgent
from .gemini_client import GeminiClient


class RiskAnalystAgent(BaseAgent):
    """
    Performs portfolio-level risk assessment, tail risk analysis,
    stress testing interpretation, and concentration warnings.
    """

    def __init__(self, gemini_client: GeminiClient) -> None:
        super().__init__(gemini_client)

    @property
    def name(self) -> str:
        return "risk_analyst"

    @property
    def role(self) -> str:
        return "Risk Analyst"

    @property
    def system_prompt(self) -> str:
        return """You are the Risk Analyst Agent for an institutional-grade NIFTY options volatility trading system.

ROLE: Head of risk at a volatility trading desk. Your job is to find what can go wrong and quantify it.

CAPABILITIES:
- Interpret VaR (95/99), Expected Shortfall, and max loss at strategy and portfolio level
- Analyze PnL distribution shape (skewness, kurtosis, fat tails)
- Assess fragility scores and model sensitivity
- Evaluate Greek portfolio exposures (net delta, gamma, vega, theta)
- Run mental stress scenarios: spot +/-5%, vol +/-30%, time decay, gap risk
- Identify concentration risk across strategies (correlated payoffs)
- Assess margin utilization and capital efficiency
- Flag regime-dependent risk (strategies that blow up in regime transitions)

OUTPUT FORMAT:
Structure your analysis as:

**RISK VERDICT**: [GREEN/YELLOW/RED] - [One-line summary]
**TAIL RISK ASSESSMENT**: [VaR, ES, max loss analysis with context]
**GREEK EXPOSURES**: [Net portfolio Greeks and what they mean for P&L sensitivity]
**STRESS SCENARIOS**:
  - Spot crash -5%: [Impact estimate]
  - Vol spike +30%: [Impact estimate]
  - Vol crush -20%: [Impact estimate]
  - Time decay 7 days: [Impact estimate]
**CONCENTRATION RISK**: [Are top strategies correlated? Directional bias?]
**FRAGILITY WARNING**: [Any strategies with fragility > 0.6?]
**CAPITAL AT RISK**: [Total margin deployed vs capital limit, utilization %]

RULES:
- Always compute approximate stress scenario P&L from the Greek data.
- Use delta * spot_move + 0.5 * gamma * spot_move^2 for spot shocks.
- Use vega * vol_change for vol shocks.
- If VaR99 exceeds 50% of margin, flag as high-risk.
- If Expected Shortfall is more than 2x VaR99, flag fat tail risk.
- Quote ALL numbers precisely from the data.
- If kurtosis > 4, explicitly warn about tail risk beyond normal distribution assumptions.
- Use concise, institutional-grade language. Be direct about dangers."""

    def build_context_prompt(self, context: AgentContext) -> str:
        sections = ["--- RISK DATA FOR ANALYSIS ---"]

        if context.market_overview:
            sections.append(f"SPOT: {context.market_overview.get('spot', 'N/A')}")

        if context.risk_data:
            sections.append(f"RISK METRICS:\n{self._format_dict(context.risk_data)}")

        if context.top_strategies:
            # Build portfolio-level aggregations
            strategies = context.top_strategies[:10]
            portfolio_greeks = {
                "total_delta": sum(s.get("delta_exposure", 0) for s in strategies),
                "total_gamma": sum(s.get("gamma_exposure", 0) for s in strategies),
                "total_vega": sum(s.get("vega_exposure", 0) for s in strategies),
                "total_theta": sum(s.get("theta_exposure", 0) for s in strategies),
                "total_margin": sum(s.get("margin_required", 0) for s in strategies),
                "total_ev": sum(s.get("expected_value", 0) for s in strategies),
                "worst_var99": min((s.get("var_99", 0) for s in strategies), default=0),
                "worst_es": min((s.get("expected_shortfall", 0) for s in strategies), default=0),
                "avg_fragility": np.mean([s.get("fragility_score", 0) for s in strategies]) if strategies else 0,
                "max_fragility": max((s.get("fragility_score", 0) for s in strategies), default=0),
                "strategies_count": len(strategies),
            }
            sections.append(f"PORTFOLIO GREEKS AGGREGATE:\n{json.dumps(portfolio_greeks, default=str)}")
            sections.append(f"INDIVIDUAL STRATEGIES:\n{self._format_strategies(strategies, top_n=10)}")

        if context.regime:
            sections.append(f"REGIME:\n{self._format_dict(context.regime)}")

        return "\n\n".join(sections)
