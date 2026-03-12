from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional

from ..exceptions import DataIngestionError
from ..logger import get_logger


@dataclass(frozen=True)
class KiteInstrumentMeta:
    instrument_token: int
    tradingsymbol: str
    strike: float
    option_type: str
    expiry: date
    exchange: str
    lot_size: int = 0


@dataclass(frozen=True)
class KiteOptionUniverse:
    symbol: str
    instrument_map: Dict[int, KiteInstrumentMeta]
    expiry_map: Dict[date, List[int]]
    underlying_symbol: str
    underlying_token: Optional[int] = None

    def tokens_for_expiries(self, expiries: Iterable[date]) -> List[int]:
        tokens: List[int] = []
        seen = set()
        for expiry in expiries:
            for token in self.expiry_map.get(expiry, []):
                if token not in seen:
                    seen.add(token)
                    tokens.append(token)
        if self.underlying_token is not None and self.underlying_token not in seen:
            tokens.append(self.underlying_token)
        return tokens


class KiteOptionUniverseBuilder:
    def __init__(self, underlying_symbol: str = "NSE:NIFTY 50") -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._underlying_symbol = underlying_symbol

    @staticmethod
    def _parse_date(value: Any) -> date:
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        if value in {None, ""}:
            raise DataIngestionError(message="Missing instrument expiry", context={"expiry": value})
        text = str(value).strip()
        for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%d-%m-%Y", "%d-%b-%Y"):
            try:
                return datetime.strptime(text, fmt).date()
            except ValueError:
                continue
        raise DataIngestionError(message="Unsupported Zerodha expiry format", context={"expiry": text})

    @staticmethod
    def _safe_int(value: Any) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _safe_float(value: Any) -> float:
        try:
            result = float(value)
        except (TypeError, ValueError):
            return 0.0
        return result if result == result else 0.0

    def build(
        self,
        *,
        nfo_instruments: Iterable[Mapping[str, Any]],
        underlying_instruments: Optional[Iterable[Mapping[str, Any]]] = None,
        symbol: str = "NIFTY",
        max_expiries: int = 5,
    ) -> KiteOptionUniverse:
        instrument_map: Dict[int, KiteInstrumentMeta] = {}
        expiry_map: Dict[date, List[int]] = {}

        for row in nfo_instruments:
            name = str(row.get("name", "") or "").upper()
            instrument_type = str(row.get("instrument_type", "") or "").upper()
            segment = str(row.get("segment", "") or "").upper()
            if name != symbol.upper():
                continue
            if segment != "NFO-OPT" or instrument_type not in {"CE", "PE"}:
                continue

            token = self._safe_int(row.get("instrument_token"))
            strike = self._safe_float(row.get("strike"))
            if token <= 0 or strike <= 0:
                continue

            expiry = self._parse_date(row.get("expiry"))
            meta = KiteInstrumentMeta(
                instrument_token=token,
                tradingsymbol=str(row.get("tradingsymbol", "") or ""),
                strike=strike,
                option_type=instrument_type,
                expiry=expiry,
                exchange=str(row.get("exchange", "NFO") or "NFO"),
                lot_size=self._safe_int(row.get("lot_size")),
            )
            instrument_map[token] = meta
            expiry_map.setdefault(expiry, []).append(token)

        if not instrument_map:
            raise DataIngestionError(
                message="No Zerodha option instruments matched the requested symbol",
                context={"symbol": symbol},
            )

        sorted_expiries = sorted(expiry_map)
        if max_expiries > 0:
            sorted_expiries = sorted_expiries[:max_expiries]
        expiry_map = {expiry: expiry_map[expiry] for expiry in sorted_expiries}
        instrument_map = {
            token: meta
            for token, meta in instrument_map.items()
            if meta.expiry in expiry_map
        }

        underlying_token = self._find_underlying_token(underlying_instruments=underlying_instruments)

        self._logger.info(
            "KITE_UNIVERSE | symbol=%s | expiries=%d | option_tokens=%d | underlying_token=%s",
            symbol,
            len(expiry_map),
            len(instrument_map),
            underlying_token,
        )

        return KiteOptionUniverse(
            symbol=symbol.upper(),
            instrument_map=instrument_map,
            expiry_map=expiry_map,
            underlying_symbol=self._underlying_symbol,
            underlying_token=underlying_token,
        )

    def _find_underlying_token(
        self,
        *,
        underlying_instruments: Optional[Iterable[Mapping[str, Any]]],
    ) -> Optional[int]:
        if not underlying_instruments:
            return None

        exchange, _, tradingsymbol = self._underlying_symbol.partition(":")
        exchange = exchange.upper()
        tradingsymbol = tradingsymbol.upper()

        for row in underlying_instruments:
            row_exchange = str(row.get("exchange", "") or "").upper()
            row_symbol = str(row.get("tradingsymbol", "") or "").upper()
            if row_exchange == exchange and row_symbol == tradingsymbol:
                token = self._safe_int(row.get("instrument_token"))
                if token > 0:
                    return token
        return None
