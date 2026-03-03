from __future__ import annotations

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
        return """You are a NIFTY options risk analyst.
Assess: VaR95/99, Expected Shortfall, max loss, Greek exposures (delta/gamma/vega/theta), fragility, concentration risk.
Approximate stress: dP = delta*dS + 0.5*gamma*dS^2 + vega*dIV + theta*dT.
Output: RISK VERDICT (GREEN/YELLOW/RED), TAIL RISK, GREEK EXPOSURES, STRESS SCENARIOS (spot +/-5%, vol +/-30%), FRAGILITY WARNING.
Be quantitative. Quote numbers from the data."""

    def build_context_prompt(self, context: AgentContext) -> str:
        lines = []
        mo = context.market_overview or {}
        if "spot" in mo:
            lines.append(f"spot={mo['spot']}")
        if context.top_strategies:
            strategies = context.top_strategies[:10]
            tot_d = sum(s.get("delta_exposure", 0) for s in strategies)
            tot_g = sum(s.get("gamma_exposure", 0) for s in strategies)
            tot_v = sum(s.get("vega_exposure", 0) for s in strategies)
            tot_t = sum(s.get("theta_exposure", 0) for s in strategies)
            tot_m = sum(s.get("margin_required", 0) for s in strategies)
            worst_var = min((s.get("var_99", 0) for s in strategies), default=0)
            worst_es = min((s.get("expected_shortfall", 0) for s in strategies), default=0)
            max_frag = max((s.get("fragility_score", 0) for s in strategies), default=0)
            lines.append(f"portfolio: delta={tot_d:.1f} gamma={tot_g:.4f} vega={tot_v:.1f} theta={tot_t:.1f}")
            lines.append(f"total_margin={tot_m:.0f} worst_var99={worst_var:.0f} worst_es={worst_es:.0f} max_fragility={max_frag:.2f}")
            lines.append(f"count={len(strategies)} strategies:")
            for s in strategies:
                lines.append(
                    f"  {s.get('strategy_type','?')} K={s.get('strikes','')} "
                    f"EV={s.get('expected_value',0):.0f} VaR99={s.get('var_99',0):.0f} "
                    f"ES={s.get('expected_shortfall',0):.0f} MaxLoss={s.get('max_loss',0):.0f} "
                    f"frag={s.get('fragility_score',0):.2f} margin={s.get('margin_required',0):.0f}"
                )
        rg = context.regime or {}
        if rg:
            lines.append(f"regime={rg.get('regime','?')} conf={rg.get('confidence','')}")
        return "\n".join(lines)
