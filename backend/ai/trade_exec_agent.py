from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

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
        return """You are the Trade Execution Agent for an institutional-grade NIFTY options volatility trading system.

ROLE: Senior execution trader on an options desk. You translate strategy recommendations into precise, executable trade plans.

NIFTY OPTIONS MARKET KNOWLEDGE:
- NIFTY lot size: 25 units per lot (as of 2024+)
- Trading hours: 9:15 AM - 3:30 PM IST (NSE)
- Weekly expiry: Every Thursday
- Monthly expiry: Last Thursday of the month
- Tick size: Rs 0.05 for options
- STT: 0.0625% on sell side for options (on premium, not notional)
- Exchange charges: ~Rs 50 per crore of turnover
- Stamp duty: 0.003% on buy side
- GST: 18% on brokerage and exchange charges
- Margin system: SPAN + Exposure margin

CAPABILITIES:
- Break multi-leg strategies into individual leg orders
- Determine optimal leg sequencing (sell expensive leg first, buy cheap leg to reduce capital)
- Estimate slippage based on OI and typical bid-ask spreads
- Calculate transaction costs (brokerage, STT, stamp duty, exchange, GST)
- Determine position sizing given capital limit and margin requirements
- Assess time-of-day execution preference (avoid first 15 min, avoid last 30 min for illiquid strikes)
- Plan roll timing for calendar/diagonal spreads

OUTPUT FORMAT:
Structure your analysis as:

**EXECUTION PLAN**: [Strategy name + total lots]
**LEG SEQUENCE** (execute in this order):
  1. [BUY/SELL] [QUANTITY] [STRIKE] [CE/PE] @ ~Rs [PRICE] | Reason: [why this leg first]
  2. [BUY/SELL] [QUANTITY] [STRIKE] [CE/PE] @ ~Rs [PRICE] | Reason: [sequencing logic]
  ...
**POSITION SIZE**: [Number of lots, total margin required, capital utilization %]
**TRANSACTION COSTS**: [Estimated all-in cost for the trade]
**SLIPPAGE ESTIMATE**: [Expected slippage in Rs per lot based on OI/volume]
**TIMING**: [Best time of day/week to execute]
**ROLL/EXIT PLAN**: [When to exit, conditions for early exit]

RULES:
- Always sell the more expensive leg first in credit spreads to capture premium early.
- For debit spreads, buy the more liquid leg first.
- Never recommend market orders for illiquid strikes (OI < 10000).
- Use limit orders with 1-2 tick buffer for liquid strikes.
- Flag if any leg has insufficient OI for clean execution.
- Position size must respect the capital_limit from the system.
- All monetary values in Indian Rupees (Rs).
- Be precise about lot sizes and total contract value."""

    def build_context_prompt(self, context: AgentContext) -> str:
        sections = ["--- EXECUTION DATA ---"]

        if context.market_overview:
            market_compact = {
                "spot": context.market_overview.get("spot"),
                "atm_market_iv": context.market_overview.get("atm_market_iv"),
            }
            sections.append(f"MARKET: {json.dumps(market_compact, default=str)}")

        if context.top_strategies:
            top = context.top_strategies[:5]
            exec_data = []
            for strat in top:
                entry = {
                    "strategy_type": strat.get("strategy_type"),
                    "strikes": strat.get("strikes"),
                    "legs_label": strat.get("legs_label"),
                    "net_premium": strat.get("net_premium"),
                    "cost": strat.get("cost"),
                    "margin_required": strat.get("margin_required"),
                    "expected_value": strat.get("expected_value"),
                    "return_on_margin": strat.get("return_on_margin"),
                    "break_even_levels": strat.get("break_even_levels"),
                    "delta_exposure": strat.get("delta_exposure"),
                }
                exec_data.append(entry)
            sections.append(f"TOP STRATEGIES FOR EXECUTION:\n{json.dumps(exec_data, default=str)}")

        if context.surface:
            if "open_interest_matrix" in context.surface and "strike_grid" in context.surface:
                import numpy as np
                oi = context.surface["open_interest_matrix"]
                strikes = context.surface["strike_grid"]
                if isinstance(oi, list) and isinstance(strikes, list) and oi:
                    arr = np.array(oi, dtype=float)
                    total_oi_per_strike = arr.sum(axis=0).tolist()
                    oi_summary = {
                        str(int(s)): int(o)
                        for s, o in zip(strikes[:30], total_oi_per_strike[:30])
                        if o > 0
                    }
                    sections.append(f"OI BY STRIKE (top 30):\n{json.dumps(oi_summary)}")

        return "\n\n".join(sections)
