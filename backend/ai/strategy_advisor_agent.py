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
        return """You are a NIFTY options strategy advisor.
Analyze ranked strategies and recommend the best trade for current conditions.
Strategies: Iron Condor (range-bound), Butterfly (pinning), Bull/Bear Spreads (directional), Straddle/Strangle (long gamma), Calendar (term structure), Ratio Backspread (tail protection).
Low-vol regime favors premium selling. High-vol favors long gamma. Match strategy to regime.
Output: TOP RECOMMENDATION (type+strikes+rationale), WHY THIS WORKS NOW, RISK PROFILE (max loss, P(loss), Greeks), ALTERNATIVES, WATCH FOR (invalidation conditions).
Quote exact numbers from the data. Be concise."""

    def build_context_prompt(self, context: AgentContext) -> str:
        sections = ["--- STRATEGY DATA FOR ANALYSIS ---"]

        if context.regime:
            sections.append(f"CURRENT REGIME: {context.regime.get('label', 'unknown')} (confidence: {context.regime.get('confidence', 'N/A')})")

        if context.market_overview:
            spot = context.market_overview.get('spot', 'N/A')
            iv = context.market_overview.get('atm_market_iv', 'N/A')
            rv = context.market_overview.get('rv_20d', 'N/A')
            iv_rank = context.market_overview.get('iv_rank', 'N/A')
            spread = context.market_overview.get('realized_implied_spread', 'N/A')
            sections.append(
                f"MARKET: NIFTY spot={spot}, ATM IV={iv}, RV20d={rv}, "
                f"IV Rank={iv_rank}, IV-RV spread={spread}"
            )

        if context.top_strategies:
            sections.append(f"TOP {min(5, len(context.top_strategies))} RANKED STRATEGIES:")
            for i, s in enumerate(context.top_strategies[:5]):
                sections.append(
                    f"{i+1}. {s.get('strategy_type','?')} | "
                    f"legs={s.get('legs_label','?')} | "
                    f"score={s.get('overall_score','?')} | "
                    f"EV={s.get('expected_value','?')} | "
                    f"P(Loss)={s.get('probability_of_loss','?')} | "
                    f"MaxLoss={s.get('max_loss','?')} | "
                    f"RoM={s.get('return_on_margin','?')} | "
                    f"VaR99={s.get('var_99','?')} | "
                    f"delta={s.get('delta_exposure','?')} | "
                    f"vega={s.get('vega_exposure','?')} | "
                    f"theta={s.get('theta_exposure','?')} | "
                    f"fragility={s.get('fragility_score','?')} | "
                    f"liquidity_warning={s.get('liquidity_warning', False)}"
                )

        return "\n".join(sections)
