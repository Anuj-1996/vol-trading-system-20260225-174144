from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

from ..config import CONFIG
from ..exceptions import DataIngestionError
from ..logger import get_logger


class KiteAuthService:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._env_path = Path("backend/.env.local")

    def build_login_url(self) -> str:
        kite = self._build_client()
        return str(kite.login_url())

    def generate_access_token(self, request_token: str) -> Dict[str, Any]:
        if not request_token:
            raise DataIngestionError(
                message="Missing Kite request token",
                context={"query_param": "request_token"},
            )

        kite = self._build_client()
        try:
            session = kite.generate_session(request_token, api_secret=CONFIG.zerodha.api_secret)
        except Exception as exc:
            raise DataIngestionError(
                message="Failed to exchange Kite request token for access token",
                context={"error": str(exc)},
            ) from exc

        access_token = str(session.get("access_token", "") or "")
        if not access_token:
            raise DataIngestionError(
                message="Kite did not return an access token",
                context={"session_keys": list(session.keys())},
            )

        self._write_env_updates(
            {
                "KITE_ACCESS_TOKEN": access_token,
                "KITE_TOKEN_UPDATED_AT": datetime.now(timezone.utc).isoformat(),
            }
        )
        self._logger.info("KITE_AUTH | access token updated | env_path=%s", self._env_path)
        return session

    def _build_client(self) -> Any:
        if not CONFIG.zerodha.api_key:
            raise DataIngestionError(
                message="Missing Kite API key",
                context={"env": "KITE_API_KEY"},
            )
        if not CONFIG.zerodha.api_secret:
            raise DataIngestionError(
                message="Missing Kite API secret",
                context={"env": "KITE_API_SECRET"},
            )

        try:
            from kiteconnect import KiteConnect
        except ImportError as exc:
            raise DataIngestionError(
                message="kiteconnect dependency is not installed",
                context={"package": "kiteconnect"},
            ) from exc

        return KiteConnect(api_key=CONFIG.zerodha.api_key)

    def _write_env_updates(self, updates: Dict[str, str]) -> None:
        self._env_path.parent.mkdir(parents=True, exist_ok=True)
        existing_lines = []
        if self._env_path.exists():
            existing_lines = self._env_path.read_text(encoding="utf-8").splitlines()

        pending = dict(updates)
        new_lines = []
        for line in existing_lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in line:
                new_lines.append(line)
                continue
            key, _ = line.split("=", 1)
            env_key = key.strip()
            if env_key in pending:
                new_lines.append(f"{env_key}={pending.pop(env_key)}")
            else:
                new_lines.append(line)

        if new_lines and new_lines[-1].strip():
            new_lines.append("")

        for key, value in pending.items():
            new_lines.append(f"{key}={value}")

        content = "\n".join(new_lines).rstrip() + "\n"
        self._env_path.write_text(content, encoding="utf-8")
        os.chmod(self._env_path, 0o600)
