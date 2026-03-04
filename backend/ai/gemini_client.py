from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional
from urllib.request import urlopen, Request
from urllib.error import URLError

from ..logger import get_logger


_OLLAMA_BASE = "http://127.0.0.1:11434"
_MODEL_ID = "gemma:2b"
_MAX_RETRIES = 3
_RETRY_BACKOFF_BASE = 2.0


class GeminiClient:
    """
    Drop-in replacement using local Ollama (gemma:2b) instead of Gemini API.
    Keeps the same class name & method signatures so all agents work unchanged.
    """

    def __init__(self, api_key: str = "", model_id: str = _MODEL_ID) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._model_id = model_id
        self._base_url = _OLLAMA_BASE
        self._logger.info("OLLAMA_CLIENT_INIT | model=%s | base=%s", model_id, self._base_url)

    # ── helpers ──────────────────────────────────────────────────────────────

    def _build_messages(
        self,
        system_instruction: str,
        user_prompt: str,
        history: Optional[List[Dict[str, str]]] = None,
    ) -> List[Dict[str, str]]:
        msgs: List[Dict[str, str]] = []
        if system_instruction:
            msgs.append({"role": "system", "content": system_instruction})
        if history:
            for turn in history:
                role = turn.get("role", "user")
                # Ollama uses "assistant" not "model"
                if role == "model":
                    role = "assistant"
                msgs.append({"role": role, "content": turn.get("text", "")})
        msgs.append({"role": "user", "content": user_prompt})
        return msgs

    def _post_json(self, endpoint: str, payload: dict, timeout: float = 120) -> Any:
        url = f"{self._base_url}{endpoint}"
        data = json.dumps(payload).encode()
        req = Request(url, data=data, headers={"Content-Type": "application/json"})
        resp = urlopen(req, timeout=timeout)
        return json.loads(resp.read().decode())

    # ── public API (same signatures as before) ───────────────────────────────

    def generate(
        self,
        *,
        system_instruction: str,
        user_prompt: str,
        temperature: float = 0.4,
        max_output_tokens: int = 4096,
        history: Optional[List[Dict[str, str]]] = None,
        model_id: Optional[str] = None,
    ) -> str:
        selected_model = (model_id or self._model_id).strip()
        messages = self._build_messages(system_instruction, user_prompt, history)

        payload = {
            "model": selected_model,
            "messages": messages,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_output_tokens,
            },
        }

        last_error: Optional[Exception] = None
        for attempt in range(1, _MAX_RETRIES + 1):
            try:
                self._logger.info(
                    "OLLAMA_REQUEST | model=%s | attempt=%d | prompt_len=%d",
                    selected_model,
                    attempt,
                    len(user_prompt),
                )
                result = self._post_json("/api/chat", payload)
                text = result.get("message", {}).get("content", "")
                self._logger.info(
                    "OLLAMA_RESPONSE | model=%s | response_len=%d | attempt=%d",
                    selected_model,
                    len(text),
                    attempt,
                )
                return text

            except Exception as exc:
                last_error = exc
                self._logger.warning(
                    "OLLAMA_RETRY | attempt=%d | error=%s",
                    attempt,
                    str(exc)[:200],
                )
                if attempt < _MAX_RETRIES:
                    time.sleep(_RETRY_BACKOFF_BASE ** attempt)

        error_msg = f"Ollama failed after {_MAX_RETRIES} attempts: {last_error}"
        self._logger.error("OLLAMA_FAILED | %s", error_msg)
        raise RuntimeError(error_msg)

    def generate_streaming(
        self,
        *,
        system_instruction: str,
        user_prompt: str,
        temperature: float = 0.4,
        max_output_tokens: int = 4096,
        history: Optional[List[Dict[str, str]]] = None,
        model_id: Optional[str] = None,
    ):
        """Stream response chunks from Ollama. Yields text strings."""
        selected_model = (model_id or self._model_id).strip()
        messages = self._build_messages(system_instruction, user_prompt, history)

        payload = {
            "model": selected_model,
            "messages": messages,
            "stream": True,
            "options": {
                "temperature": temperature,
                "num_predict": max_output_tokens,
            },
        }

        self._logger.info(
            "OLLAMA_STREAM_REQUEST | model=%s | prompt_len=%d",
            selected_model,
            len(user_prompt),
        )

        url = f"{self._base_url}/api/chat"
        data = json.dumps(payload).encode()
        req = Request(url, data=data, headers={"Content-Type": "application/json"})
        resp = urlopen(req, timeout=300)

        for line in resp:
            if not line.strip():
                continue
            try:
                chunk = json.loads(line)
                text = chunk.get("message", {}).get("content", "")
                if text:
                    yield text
            except json.JSONDecodeError:
                continue
