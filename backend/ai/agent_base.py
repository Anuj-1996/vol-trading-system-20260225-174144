from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..logger import get_logger
from .gemini_client import GeminiClient


@dataclass
class AgentMessage:
    """A single message in agent conversation history."""
    role: str  # "user" or "model"
    text: str


@dataclass
class AgentContext:
    """
    Structured context passed to agents containing pipeline data.

    Agents receive only the slices relevant to their domain,
    populated by the orchestrator before invocation.
    """
    market_overview: Optional[Dict[str, Any]] = None
    surface: Optional[Dict[str, Any]] = None
    calibration: Optional[Dict[str, Any]] = None
    regime: Optional[Dict[str, Any]] = None
    top_strategies: Optional[List[Dict[str, Any]]] = None
    risk_data: Optional[Dict[str, Any]] = None
    dynamic_hedge: Optional[Dict[str, Any]] = None
    user_query: str = ""
    conversation_history: List[AgentMessage] = field(default_factory=list)


class BaseAgent(ABC):
    """
    Abstract base class for all specialist agents.

    Each agent has:
    - A unique name and role description
    - A system prompt defining its persona and capabilities
    - Access to the Gemini client for LLM calls
    - A method to serialize relevant context into a prompt
    """

    def __init__(self, gemini_client: GeminiClient) -> None:
        self._client = gemini_client
        self._logger = get_logger(self.__class__.__name__)
        self._history: List[AgentMessage] = []

    @property
    @abstractmethod
    def name(self) -> str:
        """Agent identifier (e.g., 'market_intel')."""

    @property
    @abstractmethod
    def role(self) -> str:
        """Human-readable role description."""

    @property
    @abstractmethod
    def system_prompt(self) -> str:
        """Full system instruction for the LLM."""

    @abstractmethod
    def build_context_prompt(self, context: AgentContext) -> str:
        """
        Transform AgentContext into a structured prompt string
        containing only the data this agent needs.
        """

    def run(self, context: AgentContext, temperature: float = 0.3, model_id: Optional[str] = None) -> str:
        """
        Execute the agent: build prompt from context, call LLM, return response.
        """
        self._logger.info("AGENT_RUN | agent=%s | query=%s", self.name, context.user_query[:80])

        data_prompt = self.build_context_prompt(context)
        user_prompt = data_prompt
        if context.user_query:
            user_prompt += f"\n\n--- USER QUERY ---\n{context.user_query}"

        history_dicts = [
            {"role": msg.role, "text": msg.text}
            for msg in context.conversation_history
        ]

        response = self._client.generate(
            system_instruction=self.system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            max_output_tokens=4096,
            history=history_dicts,
            model_id=model_id,
        )

        self._history.append(AgentMessage(role="user", text=user_prompt))
        self._history.append(AgentMessage(role="model", text=response))

        self._logger.info(
            "AGENT_DONE | agent=%s | response_len=%d",
            self.name,
            len(response),
        )
        return response

    def run_streaming(self, context: AgentContext, temperature: float = 0.3, model_id: Optional[str] = None):
        """
        Execute the agent with streaming response. Yields text chunks.
        """
        self._logger.info("AGENT_STREAM | agent=%s | query=%s", self.name, context.user_query[:80])

        data_prompt = self.build_context_prompt(context)
        user_prompt = data_prompt
        if context.user_query:
            user_prompt += f"\n\n--- USER QUERY ---\n{context.user_query}"

        history_dicts = [
            {"role": msg.role, "text": msg.text}
            for msg in context.conversation_history
        ]

        full_response = []
        for chunk in self._client.generate_streaming(
            system_instruction=self.system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            max_output_tokens=4096,
            history=history_dicts,
            model_id=model_id,
        ):
            full_response.append(chunk)
            yield chunk

        combined = "".join(full_response)
        self._history.append(AgentMessage(role="user", text=user_prompt))
        self._history.append(AgentMessage(role="model", text=combined))

    def clear_history(self) -> None:
        self._history.clear()

    @staticmethod
    def _format_dict(data: Optional[Dict[str, Any]], max_items: int = 50) -> str:
        """Compact JSON serialization for LLM context injection."""
        if data is None:
            return "{}"
        truncated = {}
        for i, (key, value) in enumerate(data.items()):
            if i >= max_items:
                break
            if isinstance(value, list) and len(value) > 20:
                truncated[key] = value[:20]
                truncated[f"_{key}_truncated"] = True
                truncated[f"_{key}_total_count"] = len(value)
            elif isinstance(value, dict) and len(value) > 30:
                truncated[key] = dict(list(value.items())[:30])
            else:
                truncated[key] = value
        return json.dumps(truncated, indent=None, default=str)

    @staticmethod
    def _format_strategies(strategies: Optional[List[Dict[str, Any]]], top_n: int = 10) -> str:
        """Format top strategies for LLM consumption, omitting large arrays."""
        if not strategies:
            return "[]"
        compact = []
        for strat in strategies[:top_n]:
            entry = {k: v for k, v in strat.items() if k != "pnl_distribution"}
            if "pnl_distribution" in strat and isinstance(strat["pnl_distribution"], list):
                dist = strat["pnl_distribution"]
                entry["pnl_sample_size"] = len(dist)
                if dist:
                    import numpy as np
                    arr = np.array(dist[:1000], dtype=float)
                    entry["pnl_mean"] = round(float(np.mean(arr)), 2)
                    entry["pnl_std"] = round(float(np.std(arr)), 2)
                    entry["pnl_p5"] = round(float(np.percentile(arr, 5)), 2)
                    entry["pnl_p95"] = round(float(np.percentile(arr, 95)), 2)
            compact.append(entry)
        return json.dumps(compact, indent=None, default=str)
