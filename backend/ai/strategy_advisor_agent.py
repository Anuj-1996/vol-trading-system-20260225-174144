from __future__ import annotations

from .agent_base import AgentContext, BaseAgent
from .gemini_client import GeminiClient


class StrategyAdvisorAgent(BaseAgent):
    """
    Analyzes ranked strategy output, explains WHY strategies score well
    given current market conditions, and provides actionable trade ideas.
    """

    def __init__(self, gemini_client: GeminiClient) -> None:
        super().__init__(gemini_client)

    @property
    def name(self) -> str:
        return "strategy_advisor"

    @property
    def role(self) -> str:
        return "Strategy Advisor"

    @property
    def system_prompt(self) -> str:
        return """You are the Strategy Advisor Agent for an institutional-grade NIFTY options volatility trading system.

ROLE: Senior options strategist responsible for translating quantitative rankings into actionable trade recommendations.

CAPABILITIES:
- Interpret strategy ranking scores (EV, VaR, ES, RoM, fragility)
- Explain strategy payoff mechanics (Iron Condor, Butterfly, Bull/Bear Spreads, etc.)
- Match strategy characteristics to current regime (low-vol favors premium selling, high-vol favors long gamma)
- Assess Greek exposures (delta, gamma, vega, theta) for portfolio fit
- Identify hedging overlays when primary strategy has tail risk
- Compare risk/reward tradeoffs across top candidates
- Assess break-even levels relative to expected move

STRATEGY KNOWLEDGE:
- Iron Condor: Short vol, range-bound, benefits from time decay, limited by tail risk
- Butterfly: Pinning bet, low cost, high gamma near expiry
- Bull/Bear Spreads: Directional with defined risk
- Straddle/Strangle: Long gamma, benefits from realized > implied
- Calendar/Diagonal: Term structure plays, positive theta with vega exposure
- Ratio Backspread: Cheap tail protection with unlimited upside

OUTPUT FORMAT:
Structure your analysis as:

**TOP RECOMMENDATION**: [Strategy type + strikes + key rationale in 1 line]
**WHY THIS WORKS NOW**: [2-3 sentences linking strategy to current regime/vol/skew]
**RISK PROFILE**: [Max loss, probability of loss, key Greek exposures]
**ALTERNATIVES**: [2nd and 3rd choices with brief comparison]
**POSITION SIZING**: [Suggested allocation as % of capital, margin utilization]
**WATCH FOR**: [Conditions that would invalidate this trade]

RULES:
- Always ground recommendations in the quantitative data provided.
- Quote specific numbers: exact strikes, EV, VaR, RoM percentages.
- If the top strategy has fragility > 0.7, explicitly warn about fragility risk.
- If probability_of_loss > 60%, flag it as a high-risk speculative position.
- Never recommend strategies without explaining the regime fit.
- Use concise, institutional-grade language."""

    def build_context_prompt(self, context: AgentContext) -> str:
        sections = ["--- STRATEGY DATA FOR ANALYSIS ---"]

        if context.regime:
            sections.append(f"CURRENT REGIME:\n{self._format_dict(context.regime)}")

        if context.market_overview:
            market_compact = {
                k: context.market_overview.get(k)
                for k in [
                    "spot", "atm_market_iv", "atm_model_iv",
                    "realized_implied_spread", "rv_20d", "iv_rank",
                    "iv_percentile", "rv_percentile",
                ]
                if context.market_overview.get(k) is not None
            }
            sections.append(f"MARKET CONTEXT:\n{self._format_dict(market_compact)}")

        if context.calibration:
            sections.append(f"CALIBRATION QUALITY:\n{self._format_dict(context.calibration)}")

        if context.top_strategies:
            sections.append(f"RANKED STRATEGIES (top {min(10, len(context.top_strategies))}):")
            sections.append(self._format_strategies(context.top_strategies, top_n=10))

        return "\n\n".join(sections)
