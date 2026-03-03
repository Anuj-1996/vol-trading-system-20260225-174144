from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from google import genai
from google.genai import types

from ..logger import get_logger


_GEMINI_API_KEY = "AIzaSyCzf1zgHHYKrS7pHJ9KcyK6HDPNjx2Ft-g"
_MODEL_ID = "gemini-2.5-flash"
_MAX_RETRIES = 3
_RETRY_BACKOFF_BASE = 2.0


class GeminiClient:
    """Thread-safe wrapper around the Google GenAI SDK for Gemini 2.5 Flash."""

    def __init__(self, api_key: str = _GEMINI_API_KEY, model_id: str = _MODEL_ID) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._model_id = model_id
        self._client = genai.Client(api_key=api_key)
        self._logger.info("GEMINI_CLIENT_INIT | model=%s", model_id)

    def generate(
        self,
        *,
        system_instruction: str,
        user_prompt: str,
        temperature: float = 0.4,
        max_output_tokens: int = 4096,
        history: Optional[List[Dict[str, str]]] = None,
    ) -> str:
        """
        Send a prompt to Gemini and return the text response.

        Parameters
        ----------
        system_instruction : str
            The system-level instruction defining agent persona.
        user_prompt : str
            The user message / data payload.
        temperature : float
            Sampling temperature (0.0 = deterministic, 1.0 = creative).
        max_output_tokens : int
            Maximum response length.
        history : list[dict] or None
            Previous conversation turns: [{"role": "user"|"model", "text": "..."}]

        Returns
        -------
        str  The model response text.
        """
        contents: List[types.Content] = []

        if history:
            for turn in history:
                role = turn.get("role", "user")
                text = turn.get("text", "")
                contents.append(
                    types.Content(
                        role=role,
                        parts=[types.Part.from_text(text=text)],
                    )
                )

        contents.append(
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=user_prompt)],
            )
        )

        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )

        last_error: Optional[Exception] = None
        for attempt in range(1, _MAX_RETRIES + 1):
            try:
                self._logger.info(
                    "GEMINI_REQUEST | model=%s | attempt=%d | prompt_len=%d",
                    self._model_id,
                    attempt,
                    len(user_prompt),
                )
                response = self._client.models.generate_content(
                    model=self._model_id,
                    contents=contents,
                    config=config,
                )
                text = response.text or ""
                self._logger.info(
                    "GEMINI_RESPONSE | model=%s | response_len=%d | attempt=%d",
                    self._model_id,
                    len(text),
                    attempt,
                )
                return text

            except Exception as exc:
                last_error = exc
                self._logger.warning(
                    "GEMINI_RETRY | attempt=%d | error=%s",
                    attempt,
                    str(exc)[:200],
                )
                if attempt < _MAX_RETRIES:
                    sleep_time = _RETRY_BACKOFF_BASE ** attempt
                    time.sleep(sleep_time)

        error_msg = f"Gemini API failed after {_MAX_RETRIES} attempts: {last_error}"
        self._logger.error("GEMINI_FAILED | %s", error_msg)
        raise RuntimeError(error_msg)

    def generate_streaming(
        self,
        *,
        system_instruction: str,
        user_prompt: str,
        temperature: float = 0.4,
        max_output_tokens: int = 4096,
        history: Optional[List[Dict[str, str]]] = None,
    ):
        """
        Stream response chunks from Gemini. Yields text strings.
        """
        contents: List[types.Content] = []

        if history:
            for turn in history:
                role = turn.get("role", "user")
                text = turn.get("text", "")
                contents.append(
                    types.Content(
                        role=role,
                        parts=[types.Part.from_text(text=text)],
                    )
                )

        contents.append(
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=user_prompt)],
            )
        )

        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )

        self._logger.info(
            "GEMINI_STREAM_REQUEST | model=%s | prompt_len=%d",
            self._model_id,
            len(user_prompt),
        )

        for chunk in self._client.models.generate_content_stream(
            model=self._model_id,
            contents=contents,
            config=config,
        ):
            if chunk.text:
                yield chunk.text
