from __future__ import annotations

from .agent_base import AgentContext, BaseAgent
from .gemini_client import GeminiClient


class TradeExecutionAgent(BaseAgent):
    """
    Plans execution for recommended strategies: leg-by-leg entry,
    position sizing, slippage estimates, and timing considerations.
    """

    def __init__(self, gemini_client: GeminiClient) -> None:
        super().__init__(gemini_client)

    @property
    def name(self) -> str:
        return "trade_execution"

    @property
    def role(self) -> str:
        return "Trade Execution Planner"

    @property
    def system_prompt(self) -> str:
        return """You are a NIFTY options execution planner.
NIFTY lot=25. Weekly expiry Thu. STT=0.0625% sell side. Tick=0.05.
Plan: leg sequence (sell expensive first for credit spreads), position sizing, slippage, timing.
Output: EXECUTION PLAN, LEG SEQUENCE with prices, POSITION SIZE, TRANSACTION COSTS, SLIPPAGE ESTIMATE, TIMING.
Use limit orders for illiquid strikes (OI<10000). All values in Rs."""

    def build_context_prompt(self, context: AgentContext) -> str:
        lines = []
        mo = context.market_overview or {}
        if "spot" in mo:
            lines.append(f"spot={mo['spot']} atm_iv={mo.get('atm_market_iv','')}")
        if context.top_strategies:
            lines.append(f"Top {min(5, len(context.top_strategies))} strategies:")
            for s in context.top_strategies[:5]:
                lines.append(
                    f"  {s.get('strategy_type','?')} K={s.get('strikes','')} "
                    f"legs={s.get('legs_label','')} premium={s.get('net_premium',0):.0f} "
                    f"cost={s.get('cost',0):.0f} margin={s.get('margin_required',0):.0f} "
                    f"EV={s.get('expected_value',0):.0f} RoM={s.get('return_on_margin',0):.2f} "
                    f"delta={s.get('delta_exposure',0):.1f}"
                )
        return "\n".join(lines)
