from __future__ import annotations

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
        return """You are a NIFTY options pre-trade analyst.
Evaluate proposed trades before execution. Use Greeks for scenarios: dP = delta*dS + 0.5*gamma*dS^2 + vega*dIV + theta*dT.
Output: PRE-TRADE VERDICT (APPROVE/CAUTION/REJECT), SCENARIO TABLE (spot +/-3%, vol +/-20%, 7d decay), EDGE ANALYSIS, HIDDEN RISKS, OPTIMAL HOLDING PERIOD.
Be quantitative. Use exact spot value for calculations."""

    def build_context_prompt(self, context: AgentContext) -> str:
        lines = []
        mo = context.market_overview or {}
        for k in ["spot", "atm_market_iv", "rv_20d"]:
            if k in mo:
                lines.append(f"{k}={mo[k]}")
        rg = context.regime or {}
        if rg:
            lines.append(f"regime={rg.get('regime','?')} conf={rg.get('confidence','')}")
        if context.top_strategies:
            strategies = context.top_strategies[:3]
            lines.append(f"Top {len(strategies)} strategies for pre-trade check:")
            for s in strategies:
                pnl = s.get("pnl_distribution", [])
                pnl_info = ""
                if pnl and isinstance(pnl, list):
                    import numpy as np
                    arr = np.array(pnl[:500], dtype=float)
                    pnl_info = f" pnl_mean={np.mean(arr):.0f} pnl_std={np.std(arr):.0f} p5={np.percentile(arr,5):.0f} p95={np.percentile(arr,95):.0f}"
                lines.append(
                    f"  {s.get('strategy_type','?')} K={s.get('strikes','')} "
                    f"EV={s.get('expected_value',0):.0f} delta={s.get('delta_exposure',0):.1f} "
                    f"gamma={s.get('gamma_exposure',0):.4f} vega={s.get('vega_exposure',0):.1f} "
                    f"theta={s.get('theta_exposure',0):.1f} margin={s.get('margin_required',0):.0f}"
                    f"{pnl_info}"
                )
        if context.calibration:
            lines.append(f"model: RMSE={context.calibration.get('weighted_rmse','?')} converged={context.calibration.get('converged','?')}")
        return "\n".join(lines)
