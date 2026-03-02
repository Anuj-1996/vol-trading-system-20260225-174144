"""
Multi-expiry NSE option chain fetcher.

Fetches option chain data for all future expiries of a given symbol,
parses NSE JSON into OptionChainRawRecord objects compatible with the
existing ingestion pipeline.

Key design choices:
  - Single API call fetches ALL expiries (NSE returns everything in one response)
  - Client-side filtering per expiry avoids redundant HTTP calls
  - Trade date and expiry are parsed from the NSE timestamp and expiryDate fields
  - IVs are kept as percentages (matching existing CSV convention; surface builder divides by 100)
  - Volume and OI are summed across call + put per strike (matching existing model)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

from ..decorators import log_execution_time
from ..exceptions import DataIngestionError
from ..logger import get_logger
from .models import OptionChainRawRecord
from .nse_client import NSEClient

_logger = get_logger(__name__)

# Date formats used by NSE API
_NSE_TIMESTAMP_FORMATS = [
    "%d-%b-%Y %H:%M:%S",   # "02-Mar-2026 15:30:00"
    "%d-%b-%Y",             # "02-Mar-2026"
    "%d-%m-%Y",             # "02-03-2026"
]

_NSE_EXPIRY_FORMATS = [
    "%d-%b-%Y",             # "02-Mar-2026"
    "%d-%m-%Y",             # "02-03-2026"
]


def _parse_nse_date(date_string: str, formats: List[str]) -> date:
    """Try multiple date formats to parse an NSE date string."""
    cleaned = date_string.strip()
    for fmt in formats:
        try:
            return datetime.strptime(cleaned, fmt).date()
        except ValueError:
            continue
    raise DataIngestionError(
        message="Unable to parse NSE date",
        context={"date_string": date_string, "tried_formats": formats},
    )


def _safe_float(value: Any) -> float:
    """Safely convert NSE JSON values to float, defaulting to 0.0."""
    if value is None:
        return 0.0
    try:
        result = float(value)
        return result if result == result else 0.0  # NaN check
    except (ValueError, TypeError):
        return 0.0


@dataclass(frozen=True)
class FetchResult:
    """Result of a multi-expiry NSE data fetch."""
    records: List[OptionChainRawRecord]
    spot: float
    timestamp: str
    expiry_dates: List[str]
    symbol: str
    raw_entry_count: int = 0


class NSEOptionChainFetcher:
    """Fetches and parses NIFTY/BANKNIFTY option chains from NSE delayed API."""

    def __init__(self, client: Optional[NSEClient] = None) -> None:
        self._client = client or NSEClient()
        self._logger = get_logger(self.__class__.__name__)

    @log_execution_time
    def fetch_all_expiries(
        self,
        symbol: str = "NIFTY",
        max_expiries: int = 5,
    ) -> FetchResult:
        """
        Fetch option chain for future expiries.

        Uses the proven two-step flow:
        1. contract-info → get expiry dates list
        2. V3 with expiry param → full chain data per expiry

        Parameters
        ----------
        symbol : str
            Index symbol ("NIFTY" or "BANKNIFTY")
        max_expiries : int
            Maximum number of near-term expiries to fetch (0 = all).
            Default 5 keeps response fast (~10s) while covering
            enough maturities for Heston calibration.

        Returns
        -------
        FetchResult with all records, spot, timestamp, and expiry list.
        """
        self._logger.info("FETCH_ALL | symbol=%s", symbol)

        # Step 1: Get available expiry dates from contract-info
        expiry_strings = self._client.get_expiry_dates(symbol=symbol)
        if not expiry_strings:
            raise DataIngestionError(
                message="NSE returned no expiry dates",
                context={"symbol": symbol},
            )

        # Filter to future expiries only — skip contracts that have already
        # expired.  NSE index options expire at 15:30 IST on the expiry day,
        # so anything on or before today at >=15:30 IST is expired.
        from datetime import datetime as _dt, timezone as _tz, timedelta as _td
        _IST = _tz(offset=_td(hours=5, minutes=30))
        _now_ist = _dt.now(tz=_IST)
        _today = _now_ist.date()
        _expiry_cutoff_hour = 15   # 3:30 PM IST
        _expiry_cutoff_minute = 30

        future_expiries: List[Tuple[str, date]] = []
        for exp_str in expiry_strings:
            try:
                exp_date = _parse_nse_date(exp_str, _NSE_EXPIRY_FORMATS)
                if exp_date > _today:
                    # Strictly future day → always valid
                    future_expiries.append((exp_str, exp_date))
                elif exp_date == _today:
                    # Same day → only include if market hasn't closed yet
                    if _now_ist.hour < _expiry_cutoff_hour or (
                        _now_ist.hour == _expiry_cutoff_hour and _now_ist.minute < _expiry_cutoff_minute
                    ):
                        future_expiries.append((exp_str, exp_date))
                    else:
                        self._logger.info(
                            "SKIP_EXPIRED_TODAY | expiry=%s | now=%s (past 15:30 IST)",
                            exp_str, _now_ist.strftime("%H:%M"),
                        )
                # else: exp_date < today → skip
            except DataIngestionError:
                self._logger.warning("SKIP_EXPIRY | unparseable=%s", exp_str)
                continue

        future_expiries.sort(key=lambda x: x[1])

        # Limit to nearest N expiries for speed (each requires ~2s API call)
        if max_expiries > 0 and len(future_expiries) > max_expiries:
            self._logger.info(
                "FETCH_ALL | limiting from %d to %d near-term expiries",
                len(future_expiries), max_expiries,
            )
            future_expiries = future_expiries[:max_expiries]

        if not future_expiries:
            raise DataIngestionError(
                message="No future expiry dates found",
                context={"symbol": symbol, "all_expiries": expiry_strings[:5]},
            )

        self._logger.info(
            "FETCH_ALL | future_expiries=%d | nearest=%s | farthest=%s",
            len(future_expiries),
            future_expiries[0][0],
            future_expiries[-1][0],
        )

        # Step 2: Fetch each expiry via V3 endpoint
        all_records: List[OptionChainRawRecord] = []
        fetched_expiries: List[str] = []
        spot: float = 0.0
        timestamp: str = ""
        total_raw = 0

        for exp_str, exp_date in future_expiries:
            try:
                chain_data = self._client.get_option_chain_for_expiry(
                    symbol=symbol, expiry_date=exp_str,
                )
                entries = chain_data.get("data", [])
                underlying_value = _safe_float(chain_data.get("underlyingValue", 0.0))
                raw_timestamp = chain_data.get("timestamp", "")

                if not entries:
                    self._logger.warning("FETCH_ALL | no entries for expiry=%s", exp_str)
                    continue

                # Use first successful response's spot and timestamp
                if spot <= 0 and underlying_value > 0:
                    spot = underlying_value
                    timestamp = raw_timestamp

                trade_dt = self._parse_trade_date(raw_timestamp)
                parsed = self._parse_entries(
                    entries=entries,
                    trade_date=trade_dt,
                    expiry_date=exp_date,
                    spot=underlying_value,
                )

                if parsed:
                    all_records.extend(parsed)
                    fetched_expiries.append(exp_str)
                    total_raw += len(entries)
                    self._logger.info(
                        "FETCH_ALL | expiry=%s | entries=%d | parsed=%d",
                        exp_str, len(entries), len(parsed),
                    )

            except DataIngestionError as exc:
                self._logger.warning(
                    "FETCH_ALL | failed expiry=%s | error=%s", exp_str, exc,
                )
                continue

        if not all_records:
            raise DataIngestionError(
                message="No records parsed from any expiry",
                context={"symbol": symbol, "tried_expiries": [e[0] for e in future_expiries[:5]]},
            )

        self._logger.info(
            "FETCH_ALL | COMPLETE | symbol=%s | expiries=%d | total_records=%d | spot=%.2f",
            symbol, len(fetched_expiries), len(all_records), spot,
        )

        return FetchResult(
            records=all_records,
            spot=spot,
            timestamp=timestamp,
            expiry_dates=fetched_expiries,
            symbol=symbol,
            raw_entry_count=total_raw,
        )

    @log_execution_time
    def fetch_single_expiry(self, symbol: str, expiry_date: str) -> FetchResult:
        """Fetch option chain for a single expiry date string."""
        self._logger.info("FETCH_SINGLE | symbol=%s | expiry=%s", symbol, expiry_date)

        chain_data = self._client.get_option_chain_for_expiry(symbol=symbol, expiry_date=expiry_date)
        entries = chain_data.get("data", [])
        underlying_value = _safe_float(chain_data.get("underlyingValue", 0.0))
        raw_timestamp = chain_data.get("timestamp", "")

        if not entries:
            raise DataIngestionError(
                message="No option chain entries for requested expiry",
                context={"symbol": symbol, "expiry": expiry_date},
            )

        trade_dt = self._parse_trade_date(raw_timestamp)
        exp_date = _parse_nse_date(expiry_date, _NSE_EXPIRY_FORMATS)

        records = self._parse_entries(
            entries=entries,
            trade_date=trade_dt,
            expiry_date=exp_date,
            spot=underlying_value,
        )

        return FetchResult(
            records=records,
            spot=underlying_value,
            timestamp=raw_timestamp,
            expiry_dates=[expiry_date],
            symbol=symbol,
            raw_entry_count=len(entries),
        )

    # ------------------------------------------------------------------
    # Internal parsing
    # ------------------------------------------------------------------

    def _parse_trade_date(self, timestamp_str: str) -> date:
        """Parse trade date from NSE timestamp string, fallback to today."""
        if not timestamp_str:
            self._logger.warning("TRADE_DATE | empty timestamp, using today")
            return date.today()
        try:
            return _parse_nse_date(timestamp_str, _NSE_TIMESTAMP_FORMATS)
        except DataIngestionError:
            self._logger.warning(
                "TRADE_DATE | unparseable=%s | using today",
                timestamp_str,
            )
            return date.today()

    def _parse_entries(
        self,
        entries: List[Dict[str, Any]],
        trade_date: date,
        expiry_date: date,
        spot: float,
    ) -> List[OptionChainRawRecord]:
        """
        Parse a list of NSE JSON entries into OptionChainRawRecord objects.

        Each entry has the shape:
        {
            "strikePrice": 24800,
            "CE": { "lastPrice": ..., "impliedVolatility": ..., ... },
            "PE": { "lastPrice": ..., "impliedVolatility": ..., ... },
        }

        Notes on NSE data quirks:
        - CE or PE may be missing for some strikes (one-sided)
        - impliedVolatility = 0 for deep ITM/OTM or illiquid (handled downstream)
        - openInterest and totalTradedVolume are per-side; we sum them
        """
        records: List[OptionChainRawRecord] = []

        for entry in entries:
            strike = _safe_float(entry.get("strikePrice", 0))
            if strike <= 0:
                continue

            ce = entry.get("CE", {}) or {}
            pe = entry.get("PE", {}) or {}

            # Skip completely empty entries (both sides missing)
            if not ce and not pe:
                continue

            call_price = _safe_float(ce.get("lastPrice", 0))
            put_price = _safe_float(pe.get("lastPrice", 0))
            call_iv = _safe_float(ce.get("impliedVolatility", 0))
            put_iv = _safe_float(pe.get("impliedVolatility", 0))

            call_volume = _safe_float(ce.get("totalTradedVolume", 0))
            put_volume = _safe_float(pe.get("totalTradedVolume", 0))
            call_oi = _safe_float(ce.get("openInterest", 0))
            put_oi = _safe_float(pe.get("openInterest", 0))

            call_bid = _safe_float(ce.get("buyPrice1", 0))
            call_ask = _safe_float(ce.get("sellPrice1", 0))
            put_bid = _safe_float(pe.get("buyPrice1", 0))
            put_ask = _safe_float(pe.get("sellPrice1", 0))

            # OptionChainRawRecord expects combined volume and OI
            combined_volume = call_volume + put_volume
            combined_oi = call_oi + put_oi

            record = OptionChainRawRecord(
                trade_date=trade_date,
                expiry=expiry_date,
                strike=strike,
                call_price=call_price,
                put_price=put_price,
                call_iv=call_iv,      # percentage (e.g., 20.97) — surface builder divides by 100
                put_iv=put_iv,        # percentage (e.g., 14.42) — surface builder divides by 100
                volume=combined_volume,
                open_interest=combined_oi,
                call_bid=call_bid,
                call_ask=call_ask,
                put_bid=put_bid,
                put_ask=put_ask,
            )
            records.append(record)

        return records
