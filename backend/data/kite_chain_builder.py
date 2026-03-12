from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from math import erf, exp, log, sqrt
from typing import Any, Dict, Iterable, List, Mapping, Optional
from zoneinfo import ZoneInfo

from .kite_option_universe import KiteInstrumentMeta, KiteOptionUniverse
from .models import OptionChainRawRecord

_IST = ZoneInfo("Asia/Kolkata")


@dataclass
class _OptionLegState:
    last_price: float = 0.0
    bid: float = 0.0
    ask: float = 0.0
    oi: float = 0.0
    volume: float = 0.0
    updated_at: Optional[datetime] = None


def _safe_float(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if result == result else 0.0


def _coerce_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=_IST)
        return value.astimezone(_IST)
    return datetime.now(_IST)


def _norm_cdf(value: float) -> float:
    return 0.5 * (1.0 + erf(value / sqrt(2.0)))


def _black_scholes_price(
    *,
    spot: float,
    strike: float,
    maturity: float,
    rate: float,
    volatility: float,
    option_type: str,
) -> float:
    if spot <= 0.0 or strike <= 0.0 or maturity <= 0.0 or volatility <= 0.0:
        intrinsic = max(spot - strike, 0.0) if option_type == "CE" else max(strike - spot, 0.0)
        return intrinsic

    sigma_t = volatility * sqrt(maturity)
    d1 = (log(spot / strike) + (rate + 0.5 * volatility * volatility) * maturity) / sigma_t
    d2 = d1 - sigma_t

    if option_type == "CE":
        return spot * _norm_cdf(d1) - strike * exp(-rate * maturity) * _norm_cdf(d2)
    return strike * exp(-rate * maturity) * _norm_cdf(-d2) - spot * _norm_cdf(-d1)


def _implied_volatility(
    *,
    option_price: float,
    spot: float,
    strike: float,
    maturity: float,
    rate: float,
    option_type: str,
    max_iterations: int = 120,
    tolerance: float = 1e-6,
) -> float:
    if option_price <= 0.0 or spot <= 0.0 or strike <= 0.0 or maturity <= 0.0:
        return 0.0

    lower = 1e-4
    upper = 5.0
    target = option_price
    for _ in range(max_iterations):
        mid = 0.5 * (lower + upper)
        estimate = _black_scholes_price(
            spot=spot,
            strike=strike,
            maturity=maturity,
            rate=rate,
            volatility=mid,
            option_type=option_type,
        )
        if abs(estimate - target) <= tolerance:
            return mid * 100.0
        if estimate > target:
            upper = mid
        else:
            lower = mid
    return 0.5 * (lower + upper) * 100.0


class KiteOptionChainBuilder:
    def __init__(self, universe: KiteOptionUniverse, risk_free_rate: float) -> None:
        self._universe = universe
        self._risk_free_rate = risk_free_rate
        self._contract_state: Dict[int, _OptionLegState] = {
            token: _OptionLegState()
            for token in universe.instrument_map
        }
        self._underlying_price: float = 0.0
        self._last_trade_dt: Optional[datetime] = None

    @property
    def underlying_price(self) -> float:
        return self._underlying_price

    @property
    def latest_trade_date(self) -> date:
        if self._last_trade_dt is not None:
            return self._last_trade_dt.date()
        return datetime.now(_IST).date()

    def update_underlying_price(self, price: float, timestamp: Optional[datetime] = None) -> None:
        clean_price = _safe_float(price)
        if clean_price <= 0.0:
            return
        self._underlying_price = clean_price
        if timestamp is not None:
            self._last_trade_dt = _coerce_timestamp(timestamp)

    def apply_ticks(
        self,
        ticks: Iterable[Mapping[str, Any]],
        *,
        underlying_price: Optional[float] = None,
    ) -> List[OptionChainRawRecord]:
        if underlying_price is not None:
            self.update_underlying_price(price=underlying_price)

        for tick in ticks:
            token = int(tick.get("instrument_token", 0) or 0)
            timestamp = _coerce_timestamp(
                tick.get("exchange_timestamp") or tick.get("last_trade_time") or tick.get("timestamp")
            )
            if token == self._universe.underlying_token:
                self.update_underlying_price(price=_safe_float(tick.get("last_price")), timestamp=timestamp)
                continue

            meta = self._universe.instrument_map.get(token)
            if meta is None:
                continue

            state = self._contract_state[token]
            depth = tick.get("depth") or {}
            buy_depth = (depth.get("buy") or [{}])[0] or {}
            sell_depth = (depth.get("sell") or [{}])[0] or {}
            state.last_price = _safe_float(tick.get("last_price"))
            state.bid = _safe_float(buy_depth.get("price"))
            state.ask = _safe_float(sell_depth.get("price"))
            state.oi = _safe_float(tick.get("oi"))
            state.volume = _safe_float(tick.get("volume_traded") or tick.get("volume"))
            state.updated_at = timestamp
            self._last_trade_dt = timestamp

        return self.build_snapshot()

    def build_snapshot(self) -> List[OptionChainRawRecord]:
        grouped: Dict[tuple[date, float], Dict[str, _OptionLegState]] = {}

        for token, meta in self._universe.instrument_map.items():
            state = self._contract_state[token]
            key = (meta.expiry, meta.strike)
            grouped.setdefault(key, {})[meta.option_type] = state

        records: List[OptionChainRawRecord] = []
        valuation_dt = self._last_trade_dt or datetime.now(_IST)
        trade_date = valuation_dt.date()

        for (expiry, strike), pair in sorted(grouped.items(), key=lambda item: (item[0][0], item[0][1])):
            call_state = pair.get("CE", _OptionLegState())
            put_state = pair.get("PE", _OptionLegState())
            if not self._has_data(call_state) and not self._has_data(put_state):
                continue

            maturity = self._time_to_expiry(expiry=expiry, valuation_dt=valuation_dt)
            call_iv = _implied_volatility(
                option_price=call_state.last_price,
                spot=self._underlying_price,
                strike=strike,
                maturity=maturity,
                rate=self._risk_free_rate,
                option_type="CE",
            )
            put_iv = _implied_volatility(
                option_price=put_state.last_price,
                spot=self._underlying_price,
                strike=strike,
                maturity=maturity,
                rate=self._risk_free_rate,
                option_type="PE",
            )

            records.append(
                OptionChainRawRecord(
                    trade_date=trade_date,
                    expiry=expiry,
                    strike=strike,
                    call_price=call_state.last_price,
                    put_price=put_state.last_price,
                    call_iv=call_iv,
                    put_iv=put_iv,
                    volume=call_state.volume + put_state.volume,
                    open_interest=call_state.oi + put_state.oi,
                    call_bid=call_state.bid,
                    call_ask=call_state.ask,
                    put_bid=put_state.bid,
                    put_ask=put_state.ask,
                    call_oi=call_state.oi,
                    put_oi=put_state.oi,
                    call_volume=call_state.volume,
                    put_volume=put_state.volume,
                )
            )

        return records

    @staticmethod
    def _has_data(state: _OptionLegState) -> bool:
        return any(
            value > 0.0
            for value in (state.last_price, state.bid, state.ask, state.oi, state.volume)
        )

    @staticmethod
    def _time_to_expiry(*, expiry: date, valuation_dt: datetime) -> float:
        expiry_dt = datetime.combine(expiry, time(hour=15, minute=30), tzinfo=_IST)
        remaining = max(expiry_dt - valuation_dt.astimezone(_IST), timedelta(0))
        return max(remaining.total_seconds() / (365.0 * 24.0 * 3600.0), 1e-6)
