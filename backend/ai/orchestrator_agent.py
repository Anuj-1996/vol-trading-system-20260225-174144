from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from ..logger import get_logger
from .agent_base import AgentContext, AgentMessage, BaseAgent
from .calibration_monitor_agent import CalibrationMonitorAgent
from .gemini_client import GeminiClient
from .market_intel_agent import MarketIntelAgent
from .pre_trade_agent import PreTradeAgent
from .risk_analyst_agent import RiskAnalystAgent
from .strategy_advisor_agent import StrategyAdvisorAgent
from .trade_exec_agent import TradeExecutionAgent
from .vol_surface_agent import VolSurfaceAgent


# Agent routing keywords for intent detection
_ROUTING_PATTERNS = {
    "market_intel": [
        r"market", r"regime", r"volatility\s*(environment|condition|state)",
        r"iv\s*rank", r"realized", r"skew", r"term\s*structure",
        r"oi\b", r"open\s*interest", r"max\s*pain", r"vvix",
        r"overview", r"what.*happening", r"sentiment",
    ],
    "strategy_advisor": [
        r"strategy", r"recommend", r"which.*trade", r"iron\s*condor",
        r"butterfly", r"spread", r"straddle", r"strangle",
        r"best.*position", r"what.*do", r"advisor", r"suggest",
        r"why.*score", r"explain.*rank",
    ],
    "risk_analyst": [
        r"risk", r"var\b", r"expected\s*shortfall", r"tail",
        r"stress", r"what.*if", r"scenario", r"greek",
        r"delta", r"gamma", r"vega", r"theta",
        r"max\s*loss", r"danger", r"fragility", r"blow\s*up",
    ],
    "calibration_monitor": [
        r"calibrat", r"heston", r"parameter", r"feller",
        r"kappa", r"theta.*model", r"rho\b", r"xi\b",
        r"rmse", r"model\s*fit", r"residual", r"convergence",
        r"v0\b", r"vol.*of.*vol",
    ],
    "trade_execution": [
        r"execut", r"enter", r"order", r"leg\b", r"lot\b",
        r"position\s*siz", r"margin", r"slippage", r"timing",
        r"when.*trade", r"how.*enter", r"transaction\s*cost",
        r"entry.*plan", r"roll",
    ],
    "pre_trade": [
        r"pre.*trade", r"before.*enter", r"scenario.*matrix",
        r"what.*happen.*if", r"hidden.*risk", r"edge.*decay",
        r"holding\s*period", r"approve", r"reject", r"should\s*i",
    ],
    "vol_surface": [
        r"vol\s*surface", r"volatility\s*surface", r"3[- ]?d\s*vol",
        r"iv\s*surface", r"smile", r"smirk", r"vol\s*smile",
        r"iv\s*rank", r"iv\s*percentile", r"realized\s*vol",
        r"historical\s*vol", r"hv\b", r"rv\b",
        r"term\s*structure", r"contango", r"backwardation",
        r"skew\s*(slope|analys|analy)", r"put.*skew", r"wing",
        r"vol\s*of\s*vol", r"vvix", r"vrp", r"vol.*premium",
        r"vol.*rank", r"implied.*realized", r"vol.*regime",
        r"butterfl.*vol", r"risk\s*reversal", r"sticky",
        r"local\s*vol", r"forward\s*vol", r"vol.*cone",
        r"vol.*compress", r"vol.*expand", r"residual.*surface",
    ],
}


class OrchestratorAgent:
    """
    Master coordinator that routes user queries to specialist agents,
    combines multi-agent outputs, and manages the conversation flow.

    The orchestrator can:
    1. Auto-detect which agent(s) to invoke based on user query
    2. Run multiple agents in sequence for comprehensive analysis
    3. Synthesize outputs from multiple agents into a unified response
    4. Generate automatic market briefings using all agents
    """

    def __init__(self, gemini_client: Optional[GeminiClient] = None) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._client = gemini_client or GeminiClient()

        self._agents: Dict[str, BaseAgent] = {
            "market_intel": MarketIntelAgent(self._client),
            "strategy_advisor": StrategyAdvisorAgent(self._client),
            "risk_analyst": RiskAnalystAgent(self._client),
            "calibration_monitor": CalibrationMonitorAgent(self._client),
            "trade_execution": TradeExecutionAgent(self._client),
            "pre_trade": PreTradeAgent(self._client),
            "vol_surface": VolSurfaceAgent(self._client),
        }

        self._conversation_history: List[AgentMessage] = []
        self._last_pipeline_data: Optional[Dict[str, Any]] = None

    def set_pipeline_data(self, pipeline_response: Dict[str, Any]) -> None:
        """
        Store the latest pipeline response so agents can reference it.
        Called after each pipeline run completes.
        """
        self._last_pipeline_data = pipeline_response
        self._logger.info("ORCHESTRATOR | pipeline_data_updated | keys=%s", list(pipeline_response.keys()))

    def get_available_agents(self) -> List[Dict[str, str]]:
        """Return list of available agents with their roles."""
        return [
            {"name": agent.name, "role": agent.role}
            for agent in self._agents.values()
        ]

    def _detect_intent(self, query: str) -> List[str]:
        """
        Detect which agents should handle the query based on keyword patterns.
        Returns a list of agent names, ordered by relevance score.
        """
        query_lower = query.lower()
        scores: Dict[str, int] = {}

        for agent_name, patterns in _ROUTING_PATTERNS.items():
            score = 0
            for pattern in patterns:
                if re.search(pattern, query_lower):
                    score += 1
            if score > 0:
                scores[agent_name] = score

        if not scores:
            # Default: strategy_advisor for actionable queries, market_intel for general
            if any(word in query_lower for word in ["what", "how", "why", "explain", "help"]):
                return ["strategy_advisor"]
            return ["market_intel"]

        sorted_agents = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return [name for name, _ in sorted_agents]

    def _build_context(
        self,
        user_query: str,
        pipeline_data: Optional[Dict[str, Any]] = None,
    ) -> AgentContext:
        """Build AgentContext from pipeline data and conversation history."""
        data = pipeline_data or self._last_pipeline_data or {}

        return AgentContext(
            market_overview=data.get("market_overview"),
            surface=data.get("surface"),
            calibration=data.get("calibration"),
            regime=data.get("regime"),
            top_strategies=data.get("top_strategies"),
            risk_data=data.get("risk_data"),
            dynamic_hedge=data.get("dynamic_hedge"),
            user_query=user_query,
            conversation_history=self._conversation_history[-10:],
        )

    def chat(
        self,
        query: str,
        agent_name: Optional[str] = None,
        pipeline_data: Optional[Dict[str, Any]] = None,
        model_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Main chat interface. Routes query to appropriate agent(s) and returns response.

        Parameters
        ----------
        query : str
            User's question or command.
        agent_name : str or None
            Force a specific agent. If None, auto-detects from query.
        pipeline_data : dict or None
            Override pipeline data for this request.

        Returns
        -------
        dict with: agent, role, response, agents_consulted
        """
        self._logger.info("ORCHESTRATOR_CHAT | query=%s | forced_agent=%s", query[:80], agent_name)

        if pipeline_data:
            self.set_pipeline_data(pipeline_data)

        context = self._build_context(query, pipeline_data)

        if not self._last_pipeline_data:
            return {
                "agent": "orchestrator",
                "role": "System",
                "response": "No pipeline data available. Run 'Fetch Live & Analyse' first to load market data, then I can provide analysis across all agents.",
                "agents_consulted": [],
            }

        if agent_name and agent_name in self._agents:
            target_agents = [agent_name]
        else:
            target_agents = self._detect_intent(query)

        primary_agent_name = target_agents[0]
        primary_agent = self._agents[primary_agent_name]

        self._logger.info(
            "ORCHESTRATOR_ROUTE | primary=%s | all_detected=%s",
            primary_agent_name,
            target_agents,
        )

        response_text = primary_agent.run(context, model_id=model_id)

        self._conversation_history.append(AgentMessage(role="user", text=query))
        self._conversation_history.append(AgentMessage(role="model", text=response_text))

        return {
            "agent": primary_agent.name,
            "role": primary_agent.role,
            "response": response_text,
            "agents_consulted": target_agents,
        }

    def chat_streaming(
        self,
        query: str,
        agent_name: Optional[str] = None,
        pipeline_data: Optional[Dict[str, Any]] = None,
        model_id: Optional[str] = None,
    ):
        """
        Streaming chat interface. Yields dict chunks with partial response text.
        """
        self._logger.info("ORCHESTRATOR_STREAM | query=%s", query[:80])

        if pipeline_data:
            self.set_pipeline_data(pipeline_data)

        context = self._build_context(query, pipeline_data)

        if not self._last_pipeline_data:
            yield {
                "agent": "orchestrator",
                "role": "System",
                "chunk": "No pipeline data available. Run 'Fetch Live & Analyse' first.",
                "done": True,
            }
            return

        if agent_name and agent_name in self._agents:
            target_agents = [agent_name]
        else:
            target_agents = self._detect_intent(query)

        primary_agent = self._agents[target_agents[0]]

        yield {
            "agent": primary_agent.name,
            "role": primary_agent.role,
            "chunk": "",
            "done": False,
        }

        full_response = []
        for chunk in primary_agent.run_streaming(context, model_id=model_id):
            full_response.append(chunk)
            yield {
                "agent": primary_agent.name,
                "role": primary_agent.role,
                "chunk": chunk,
                "done": False,
            }

        combined = "".join(full_response)
        self._conversation_history.append(AgentMessage(role="user", text=query))
        self._conversation_history.append(AgentMessage(role="model", text=combined))

        yield {
            "agent": primary_agent.name,
            "role": primary_agent.role,
            "chunk": "",
            "done": True,
        }

    def generate_briefing(
        self,
        pipeline_data: Optional[Dict[str, Any]] = None,
        model_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Generate a comprehensive market briefing by consulting all key agents.
        Returns structured briefing with sections from each agent.
        """
        self._logger.info("ORCHESTRATOR_BRIEFING | generating full briefing")

        if pipeline_data:
            self.set_pipeline_data(pipeline_data)

        if not self._last_pipeline_data:
            return {"error": "No pipeline data available."}

        briefing = {}

        # 1. Market Intelligence
        market_context = self._build_context("Provide a concise market intelligence briefing.")
        briefing["market_intel"] = {
            "agent": "market_intel",
            "role": self._agents["market_intel"].role,
            "analysis": self._agents["market_intel"].run(market_context, temperature=0.2, model_id=model_id),
        }

        # 2. Calibration Check
        cal_context = self._build_context("Assess the current model calibration quality.")
        briefing["calibration"] = {
            "agent": "calibration_monitor",
            "role": self._agents["calibration_monitor"].role,
            "analysis": self._agents["calibration_monitor"].run(cal_context, temperature=0.2, model_id=model_id),
        }

        # 3. Strategy Recommendation
        strat_context = self._build_context("What is the best strategy for current conditions?")
        briefing["strategy"] = {
            "agent": "strategy_advisor",
            "role": self._agents["strategy_advisor"].role,
            "analysis": self._agents["strategy_advisor"].run(strat_context, temperature=0.3, model_id=model_id),
        }

        # 4. Risk Assessment
        risk_context = self._build_context("Perform a comprehensive risk assessment of the top strategies.")
        briefing["risk"] = {
            "agent": "risk_analyst",
            "role": self._agents["risk_analyst"].role,
            "analysis": self._agents["risk_analyst"].run(risk_context, temperature=0.2, model_id=model_id),
        }

        # 5. Volatility Surface Deep-Dive
        vol_context = self._build_context("Provide a deep volatility surface analysis: IV rank, RV spreads, term structure, skew, and surface topology.")
        briefing["vol_surface"] = {
            "agent": "vol_surface",
            "role": self._agents["vol_surface"].role,
            "analysis": self._agents["vol_surface"].run(vol_context, temperature=0.2, model_id=model_id),
        }

        self._logger.info("ORCHESTRATOR_BRIEFING | complete | sections=%d", len(briefing))
        return briefing

    def clear_conversation(self) -> None:
        """Reset conversation history for a fresh session."""
        self._conversation_history.clear()
        for agent in self._agents.values():
            agent.clear_history()
        self._logger.info("ORCHESTRATOR | conversation_cleared")
