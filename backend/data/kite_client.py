from __future__ import annotations

import threading
from typing import Any, Callable, Iterable, List, Mapping, Optional

from ..exceptions import DataIngestionError
from ..logger import get_logger

TickCallback = Callable[[List[Mapping[str, Any]]], None]


class KiteMarketDataClient:
    def __init__(
        self,
        *,
        api_key: str,
        access_token: str = "",
        api_secret: str = "",
        request_token: str = "",
    ) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._api_key = api_key
        self._access_token = access_token
        self._api_secret = api_secret
        self._request_token = request_token
        self._kite: Any = None
        self._ticker: Any = None
        self._lock = threading.Lock()

    def _load_sdk(self) -> tuple[Any, Any]:
        try:
            from kiteconnect import KiteConnect, KiteTicker
        except ImportError as exc:
            raise DataIngestionError(
                message="kiteconnect dependency is not installed",
                context={"package": "kiteconnect"},
            ) from exc
        return KiteConnect, KiteTicker

    def authenticate(self) -> None:
        if not self._api_key:
            raise DataIngestionError(
                message="Missing Kite API key",
                context={"config": "KITE_API_KEY"},
            )

        KiteConnect, _ = self._load_sdk()
        kite = KiteConnect(api_key=self._api_key)

        if not self._access_token:
            if not self._request_token or not self._api_secret:
                raise DataIngestionError(
                    message="Missing Kite access token and session bootstrap inputs",
                    context={
                        "required": ["KITE_ACCESS_TOKEN", "KITE_REQUEST_TOKEN", "KITE_API_SECRET"],
                    },
                )
            session = kite.generate_session(self._request_token, api_secret=self._api_secret)
            self._access_token = str(session["access_token"])

        kite.set_access_token(self._access_token)
        self._kite = kite
        self._logger.info("KITE_AUTH | ready")

    @property
    def access_token(self) -> str:
        return self._access_token

    def get_instruments(self, exchange: str) -> List[Mapping[str, Any]]:
        self._ensure_rest_client()
        return list(self._kite.instruments(exchange))

    def get_ltp(self, instrument: str) -> float:
        self._ensure_rest_client()
        data = self._kite.ltp(instrument)
        payload = data.get(instrument, {}) if isinstance(data, dict) else {}
        return float(payload.get("last_price") or 0.0)

    def connect(
        self,
        *,
        tokens: Iterable[int],
        on_ticks: TickCallback,
        on_connect: Optional[Callable[[], None]] = None,
        on_close: Optional[Callable[[int, str], None]] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
    ) -> None:
        self._ensure_rest_client()
        _, KiteTicker = self._load_sdk()
        ticker = KiteTicker(self._api_key, self._access_token)
        subscription_tokens = [int(token) for token in tokens]

        def _handle_ticks(ws: Any, ticks: List[Mapping[str, Any]]) -> None:
            on_ticks(ticks)

        def _handle_connect(ws: Any, _: Any) -> None:
            if subscription_tokens:
                ws.subscribe(subscription_tokens)
                ws.set_mode(ws.MODE_FULL, subscription_tokens)
            if on_connect is not None:
                on_connect()

        def _handle_close(_: Any, code: int, reason: str) -> None:
            if on_close is not None:
                on_close(code, reason)

        def _handle_error(_: Any, code: int, reason: str) -> None:
            if on_error is not None:
                on_error(DataIngestionError(message="Kite websocket error", context={"code": code, "reason": reason}))

        ticker.on_ticks = _handle_ticks
        ticker.on_connect = _handle_connect
        ticker.on_close = _handle_close
        ticker.on_error = _handle_error

        with self._lock:
            self._ticker = ticker
        ticker.connect(threaded=True)

    def subscribe(self, tokens: Iterable[int]) -> None:
        with self._lock:
            if self._ticker is None:
                return
            token_list = [int(token) for token in tokens]
            self._ticker.subscribe(token_list)
            self._ticker.set_mode(self._ticker.MODE_FULL, token_list)

    def unsubscribe(self, tokens: Iterable[int]) -> None:
        with self._lock:
            if self._ticker is None:
                return
            self._ticker.unsubscribe([int(token) for token in tokens])

    def close(self) -> None:
        with self._lock:
            ticker = self._ticker
            self._ticker = None
        if ticker is not None:
            ticker.close()

    def _ensure_rest_client(self) -> None:
        if self._kite is None:
            self.authenticate()
