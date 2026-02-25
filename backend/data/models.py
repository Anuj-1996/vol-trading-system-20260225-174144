from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class OptionChainRawRecord:
    trade_date: date
    expiry: date
    strike: float
    call_price: float
    put_price: float
    call_iv: float
    put_iv: float
    volume: float
    open_interest: float
    call_bid: float
    call_ask: float
    put_bid: float
    put_ask: float


@dataclass(frozen=True)
class FilteredOptionRecord:
    trade_date: date
    expiry: date
    strike: float
    iv: float
    side: str
    volume: float
    open_interest: float
    bid: float
    ask: float
    mid: float
    moneyness: float
