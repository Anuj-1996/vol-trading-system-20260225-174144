from __future__ import annotations
from typing import Any, Dict, Optional
from .agent_base import AgentContext, BaseAgent
from .gemini_client import GeminiClient

class DealerPositioningAgent(BaseAgent):
    """
    Options volatility analyst specializing in dealer positioning and volatility trading.
    Dedicated agent for the Dealer Positioning page.
    """

    def __init__(self, gemini_client: GeminiClient) -> None:
        super().__init__(gemini_client)

    @property
    def name(self) -> str:
        return "dealer_positioning"

    @property
    def role(self) -> str:
        return "Dealer Positioning Specialist"

    @property
    def system_prompt(self) -> str:
        return """
You are an options volatility analyst. Analyze dealer positioning metrics and give a trading decision.

Rules:
Maximum 250 words.
Short sentences only.
No explanations of what metrics mean.
No storytelling, no disclaimers.
Direct trading language only.

Analysis order: determine market regime, identify support/resistance from gamma walls, evaluate dealer flows from vanna and charm, check volatility state from VRP.

Output exactly in this structure:

MARKET REGIME:
1-2 short sentences.

CHART SIGNALS:
2-3 short sentences for each:
gamma observation.
vanna observation.
charm observation.
dealer flow observation.
gamma walls observation.

TRADE DECISION:
BUY OPTIONS or SELL OPTIONS.

STRATEGY:
strategy name, example strikes near walls, two-three line reasoning.
""".strip()

    def build_context_prompt(self, context: AgentContext) -> str:
        mo = context.market_overview or {}
        metrics = mo.get("metrics", {}) if isinstance(mo.get("metrics"), dict) else {}
        
        # Extract variables
        spot = mo.get("spot", "Unknown")
        gex = metrics.get("total_gex", "Unknown")
        vex = metrics.get("total_vex", "Unknown")
        cex = metrics.get("total_cex", "Unknown")
        regime = metrics.get("gamma_regime", "Unknown")
        vrp = metrics.get("vrp", 0)
        
        walls = mo.get("walls", [])
        walls_str = ", ".join([f"{w.get('type')} @ {w.get('strike')}" for w in walls[:3]]) if walls else "None"
        
        prompt = f"""
Input data:
Spot: {spot}
GEX: {gex}
VEX: {vex}
CEX: {cex}
Gamma Regime: {regime}
Gamma Walls: {walls_str}
VRP: {vrp:.2f}%

Chart summaries include: gamma exposure curve, vanna exposure, charm exposure, gamma vs spot, dealer hedge flow, gamma surface, volatility suppression map, charm flow, gamma density.
""".strip()
        return prompt
