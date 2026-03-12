from __future__ import annotations

import random
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, Optional
from zoneinfo import ZoneInfo

from ..logger import get_logger
from .engine_service import LivePipelineRequest, StrategyEngineService


@dataclass
class LiveSymbolState:
    symbol: str
    pipeline_params: Dict[str, Any]
    max_expiries: int
    refresh_interval_seconds: int
    auto_refresh_enabled: bool = True
    latest_snapshot: Optional[Dict[str, Any]] = None
    latest_live_metadata: Optional[Dict[str, Any]] = None
    version: Optional[str] = None
    refreshing: bool = False
    last_attempt_ts: Optional[float] = None
    last_success_ts: Optional[float] = None
    next_refresh_ts: float = 0.0
    last_error: Optional[str] = None
    cooldown_until_ts: Optional[float] = None
    block_error_count: int = 0


class LiveRefreshService:
    def __init__(self, engine: StrategyEngineService) -> None:
        self._engine = engine
        self._logger = get_logger(self.__class__.__name__)
        self._lock = threading.Lock()
        self._states: Dict[str, LiveSymbolState] = {}
        self._stop_event = threading.Event()
        self._thread = threading.Thread(target=self._scheduler_loop, name="live-refresh-scheduler", daemon=True)
        self._thread.start()

    def shutdown(self) -> None:
        self._stop_event.set()
        if self._thread.is_alive():
            self._thread.join(timeout=1.0)

    def seed_from_manual_pipeline(
        self,
        *,
        data_id: str,
        pipeline_params: Dict[str, Any],
        max_expiries: int,
        pipeline_result: Dict[str, Any],
    ) -> None:
        cached = self._engine.get_cached_nse_data(data_id)
        if cached is None:
            return

        fetch_result = cached.get("fetch_result")
        symbol = str(cached.get("symbol", "NIFTY")).upper()
        live_metadata = {
            "data_id": data_id,
            "spot": cached.get("spot"),
            "quality_report": cached.get("quality_report"),
            "expiry_dates": list(getattr(fetch_result, "expiry_dates", []) or []),
            "symbol": symbol,
            "timestamp": getattr(fetch_result, "timestamp", None),
            "record_count": len(cached.get("cleaned_records", []) or []),
        }
        self._upsert_success(
            symbol=symbol,
            pipeline_params=pipeline_params,
            max_expiries=max_expiries,
            pipeline_result=pipeline_result,
            live_metadata=live_metadata,
        )

    def trigger_refresh(
        self,
        *,
        symbol: str,
        pipeline_params: Optional[Dict[str, Any]] = None,
        max_expiries: Optional[int] = None,
        refresh_interval_seconds: Optional[int] = None,
        auto_refresh_enabled: Optional[bool] = None,
        force: bool = False,
        reason: str = "manual",
    ) -> Dict[str, Any]:
        symbol_key = str(symbol or "NIFTY").upper()
        with self._lock:
            state = self._states.get(symbol_key)
            if state is None:
                state = LiveSymbolState(
                    symbol=symbol_key,
                    pipeline_params=dict(pipeline_params or {}),
                    max_expiries=int(max_expiries or 5),
                    refresh_interval_seconds=int(refresh_interval_seconds or 240),
                    auto_refresh_enabled=True if auto_refresh_enabled is None else bool(auto_refresh_enabled),
                )
                self._states[symbol_key] = state
            else:
                if pipeline_params:
                    state.pipeline_params = {**state.pipeline_params, **pipeline_params}
                if max_expiries is not None:
                    state.max_expiries = int(max_expiries)
                if refresh_interval_seconds is not None:
                    state.refresh_interval_seconds = int(refresh_interval_seconds)
                if auto_refresh_enabled is not None:
                    state.auto_refresh_enabled = bool(auto_refresh_enabled)

            if state.refreshing:
                return self._serialize_state(state)

            if (
                not force
                and state.cooldown_until_ts is not None
                and time.time() < state.cooldown_until_ts
            ):
                return self._serialize_state(state)

            if not force and state.next_refresh_ts and time.time() < state.next_refresh_ts and state.latest_snapshot is not None:
                return self._serialize_state(state)

            state.refreshing = True
            state.last_attempt_ts = time.time()
            state.last_error = None

        worker = threading.Thread(
            target=self._refresh_symbol,
            kwargs={"symbol": symbol_key, "reason": reason},
            name=f"live-refresh-{symbol_key.lower()}",
            daemon=True,
        )
        worker.start()
        return self.get_status(symbol_key)

    def get_status(self, symbol: str) -> Dict[str, Any]:
        symbol_key = str(symbol or "NIFTY").upper()
        with self._lock:
            state = self._states.get(symbol_key)
            if state is None:
                return {
                    "symbol": symbol_key,
                    "tracked": False,
                    "refreshing": False,
                    "version": None,
                    "last_success_ts": None,
                    "last_attempt_ts": None,
                    "next_refresh_ts": None,
                    "last_error": None,
                    "stale_seconds": None,
                    "has_snapshot": False,
                }
            return self._serialize_state(state)

    def get_latest_snapshot(self, symbol: str) -> Optional[Dict[str, Any]]:
        symbol_key = str(symbol or "NIFTY").upper()
        with self._lock:
            state = self._states.get(symbol_key)
            if state is None or state.latest_snapshot is None:
                return None
            return {
                "symbol": state.symbol,
                "version": state.version,
                "snapshot": state.latest_snapshot,
                "live_metadata": state.latest_live_metadata,
                "status": self._serialize_state(state),
            }

    def _scheduler_loop(self) -> None:
        while not self._stop_event.wait(15.0):
            with self._lock:
                due_symbols = [
                    state.symbol
                    for state in self._states.values()
                    if state.latest_snapshot is not None
                    and state.auto_refresh_enabled
                    and not state.refreshing
                    and (state.cooldown_until_ts is None or time.time() >= state.cooldown_until_ts)
                    and state.next_refresh_ts > 0
                    and time.time() >= state.next_refresh_ts
                ]
            for symbol in due_symbols:
                try:
                    self.trigger_refresh(symbol=symbol, force=True, reason="scheduled")
                except Exception:
                    self._logger.exception("LIVE_REFRESH_SCHEDULER_ERROR | symbol=%s", symbol)

    def _refresh_symbol(self, *, symbol: str, reason: str) -> None:
        with self._lock:
            state = self._states.get(symbol)
            if state is None:
                return
            pipeline_params = dict(state.pipeline_params)
            max_expiries = int(state.max_expiries)
            refresh_interval_seconds = int(state.refresh_interval_seconds)
            auto_refresh_enabled = bool(state.auto_refresh_enabled)

        if reason == "scheduled" and not auto_refresh_enabled:
            with self._lock:
                state = self._states.get(symbol)
                if state is not None:
                    state.refreshing = False
            return

        if reason == "scheduled" and not self._is_market_hours():
            with self._lock:
                state = self._states.get(symbol)
                if state is not None:
                    state.refreshing = False
                    state.next_refresh_ts = self._next_market_open_ts()
            return

        self._logger.info("LIVE_REFRESH | START | symbol=%s | reason=%s", symbol, reason)
        try:
            live_metadata = self._engine.fetch_nse_live_data(
                symbol=symbol,
                expiries=None,
                max_expiries=max_expiries,
            )
            pipeline_request = LivePipelineRequest(
                data_id=live_metadata["data_id"],
                db_path=str(pipeline_params.get("db_path", "backend/vol_engine.db")),
                risk_free_rate=float(pipeline_params.get("risk_free_rate", 0.065)),
                dividend_yield=float(pipeline_params.get("dividend_yield", 0.012)),
                capital_limit=float(pipeline_params.get("capital_limit", 500000)),
                strike_increment=int(pipeline_params.get("strike_increment", 50)),
                max_legs=int(pipeline_params.get("max_legs", 4)),
                max_width=float(pipeline_params.get("max_width", 1000)),
                simulation_paths=int(pipeline_params.get("simulation_paths", 5000)),
                simulation_steps=int(pipeline_params.get("simulation_steps", 32)),
                model_selection=str(pipeline_params.get("model_selection", "SABR")),
            )
            pipeline_result = self._engine.run_live_pipeline(pipeline_request)
            self._upsert_success(
                symbol=symbol,
                pipeline_params=pipeline_params,
                max_expiries=max_expiries,
                pipeline_result=pipeline_result,
                live_metadata=live_metadata,
            )
            self._logger.info("LIVE_REFRESH | END | symbol=%s", symbol)
        except Exception as exc:
            self._logger.exception("LIVE_REFRESH | ERROR | symbol=%s", symbol)
            with self._lock:
                state = self._states.get(symbol)
                if state is not None:
                    state.refreshing = False
                    state.last_error = str(exc)
                    if self._is_nse_block_error(exc):
                        state.block_error_count += 1
                        cooldown_minutes = min(30, 3 * state.block_error_count)
                        state.cooldown_until_ts = time.time() + cooldown_minutes * 60
                        state.next_refresh_ts = state.cooldown_until_ts
                    else:
                        state.next_refresh_ts = time.time() + max(90, refresh_interval_seconds)

    def _upsert_success(
        self,
        *,
        symbol: str,
        pipeline_params: Dict[str, Any],
        max_expiries: int,
        pipeline_result: Dict[str, Any],
        live_metadata: Dict[str, Any],
    ) -> None:
        now = time.time()
        jitter = random.randint(10, 35)
        with self._lock:
            state = self._states.get(symbol)
            if state is None:
                state = LiveSymbolState(
                    symbol=symbol,
                    pipeline_params=dict(pipeline_params),
                    max_expiries=int(max_expiries),
                    refresh_interval_seconds=240,
                )
                self._states[symbol] = state
            else:
                state.pipeline_params = dict(pipeline_params)
                state.max_expiries = int(max_expiries)

            state.latest_snapshot = pipeline_result
            state.latest_live_metadata = live_metadata
            state.version = f"{symbol.lower()}-{int(now)}"
            state.refreshing = False
            state.last_attempt_ts = now
            state.last_success_ts = now
            state.last_error = None
            state.cooldown_until_ts = None
            state.block_error_count = 0
            if state.auto_refresh_enabled:
                state.next_refresh_ts = now + max(120, state.refresh_interval_seconds) + jitter
            else:
                state.next_refresh_ts = 0.0

    def _serialize_state(self, state: LiveSymbolState) -> Dict[str, Any]:
        stale_seconds = None
        if state.last_success_ts is not None:
            stale_seconds = max(0, int(time.time() - state.last_success_ts))
        return {
            "symbol": state.symbol,
            "tracked": True,
            "auto_refresh_enabled": state.auto_refresh_enabled,
            "refreshing": state.refreshing,
            "version": state.version,
            "last_success_ts": state.last_success_ts,
            "last_attempt_ts": state.last_attempt_ts,
            "next_refresh_ts": state.next_refresh_ts if state.next_refresh_ts else None,
            "last_error": state.last_error,
            "cooldown_until_ts": state.cooldown_until_ts,
            "block_error_count": state.block_error_count,
            "stale_seconds": stale_seconds,
            "has_snapshot": state.latest_snapshot is not None,
        }

    def _is_market_hours(self) -> bool:
        now = datetime.now(ZoneInfo("Asia/Kolkata"))
        if now.weekday() >= 5:
            return False
        open_time = now.replace(hour=9, minute=15, second=0, microsecond=0)
        close_time = now.replace(hour=15, minute=30, second=0, microsecond=0)
        return open_time <= now <= close_time

    def _next_market_open_ts(self) -> float:
        now = datetime.now(ZoneInfo("Asia/Kolkata"))
        next_open = now.replace(hour=9, minute=15, second=0, microsecond=0)
        if now.weekday() >= 5:
            days_ahead = 7 - now.weekday()
            next_open = next_open + timedelta(days=days_ahead)
        elif now > now.replace(hour=15, minute=30, second=0, microsecond=0):
            next_open = next_open + timedelta(days=1)
        elif now < now.replace(hour=9, minute=15, second=0, microsecond=0):
            next_open = next_open

        while next_open.weekday() >= 5:
            next_open += timedelta(days=1)
        return next_open.timestamp()

    def _is_nse_block_error(self, exc: Exception) -> bool:
        text = str(exc).lower()
        return "403" in text or "blocking" in text or "bot" in text
