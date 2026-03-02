"""
NSE data quality engine — cleans and validates fetched option chain data.

This module sits between the raw NSE fetch and the existing pipeline.
It handles data issues specific to NSE's delayed feed that would confuse
the surface builder and calibration engine if left uncleaned:

  1. Empty / zero-data rows (both sides dead)
  2. IV=0 on deep ITM/OTM strikes (NSE doesn't compute IV for illiquid strikes)
  3. Bid-ask anomalies (zero bids after market close, inverted spreads)
  4. Stale quotes (zero volume, zero change — no real trading happened)
  5. Out-of-range strikes (beyond ±30% moneyness — garbage data)
  6. Past expiries (should not reach here, but belt-and-suspenders)

The existing LiquidityFilter still runs downstream and applies its own
OI/volume/spread thresholds. This cleaner handles NSE-specific edge cases
that the CSV-based filter was never designed for.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, List

from ..decorators import log_execution_time
from ..logger import get_logger
from .models import OptionChainRawRecord

_logger = get_logger(__name__)

# Strikes beyond this percentage from spot are not useful for calibration
_MAX_MONEYNESS_DEVIATION = 0.30

# Minimum combined OI to keep a record (very loose — LiquidityFilter applies stricter)
_MIN_COMBINED_OI = 1.0

# Minimum combined volume to keep (0 = no real trading)
_MIN_COMBINED_VOLUME = 0.0  # Allow zero-volume to pass through; LiquidityFilter handles it


@dataclass
class CleanResult:
    """Result of the data cleaning pass."""
    cleaned_records: List[OptionChainRawRecord]
    quality_report: Dict[str, Any]


class NSEDataCleaner:
    """Validates and cleans raw OptionChainRawRecords from NSE."""

    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @log_execution_time
    def clean(
        self,
        records: List[OptionChainRawRecord],
        spot: float,
    ) -> CleanResult:
        """
        Clean NSE option chain records.

        Parameters
        ----------
        records : list[OptionChainRawRecord]
            Raw records from NSEOptionChainFetcher
        spot : float
            Underlying spot price for moneyness calculation

        Returns
        -------
        CleanResult with cleaned records and a quality report dict.
        """
        self._logger.info("CLEAN_START | records=%d | spot=%.2f", len(records), spot)

        total = len(records)
        removed_empty = 0
        removed_moneyness = 0
        removed_expired = 0
        iv_missing_count = 0
        stale_count = 0
        bid_ask_fixed = 0

        today = date.today()
        lower_bound = spot * (1.0 - _MAX_MONEYNESS_DEVIATION)
        upper_bound = spot * (1.0 + _MAX_MONEYNESS_DEVIATION)

        cleaned: List[OptionChainRawRecord] = []

        for record in records:
            # ----------------------------------------------------------
            # 1. Remove past expiries
            # ----------------------------------------------------------
            if record.expiry < today:
                removed_expired += 1
                continue

            # ----------------------------------------------------------
            # 2. Remove completely empty rows
            #    Both call and put have zero price, zero volume, zero OI
            # ----------------------------------------------------------
            if (
                record.call_price <= 0
                and record.put_price <= 0
                and record.volume <= 0
                and record.open_interest <= 0
            ):
                removed_empty += 1
                continue

            # ----------------------------------------------------------
            # 3. Moneyness bounds
            #    Strikes far from spot have no calibration value and
            #    produce garbage IVs (often IV=0 from NSE).
            # ----------------------------------------------------------
            if record.strike < lower_bound or record.strike > upper_bound:
                removed_moneyness += 1
                continue

            # ----------------------------------------------------------
            # 4. Fix bid-ask anomalies
            #    NSE sometimes has ask < bid or zero bids post-close.
            #    Swap if inverted; leave zero bids alone (LiquidityFilter
            #    will handle them via spread check).
            # ----------------------------------------------------------
            call_bid = record.call_bid
            call_ask = record.call_ask
            put_bid = record.put_bid
            put_ask = record.put_ask

            if call_bid > 0 and call_ask > 0 and call_ask < call_bid:
                call_bid, call_ask = call_ask, call_bid
                bid_ask_fixed += 1

            if put_bid > 0 and put_ask > 0 and put_ask < put_bid:
                put_bid, put_ask = put_ask, put_bid
                bid_ask_fixed += 1

            # ----------------------------------------------------------
            # 5. Track IV-missing strikes (don't remove — let downstream
            #    filter handle it, but count for quality report)
            # ----------------------------------------------------------
            if record.call_iv <= 0 and record.put_iv <= 0:
                iv_missing_count += 1

            # ----------------------------------------------------------
            # 6. Track stale quotes (volume=0 on both sides)
            # ----------------------------------------------------------
            if record.volume <= 0:
                stale_count += 1

            # ----------------------------------------------------------
            # Build potentially cleaned record (bid/ask may have been fixed)
            # ----------------------------------------------------------
            if (
                call_bid != record.call_bid
                or call_ask != record.call_ask
                or put_bid != record.put_bid
                or put_ask != record.put_ask
            ):
                # Create new record with fixed bid/ask
                cleaned_record = OptionChainRawRecord(
                    trade_date=record.trade_date,
                    expiry=record.expiry,
                    strike=record.strike,
                    call_price=record.call_price,
                    put_price=record.put_price,
                    call_iv=record.call_iv,
                    put_iv=record.put_iv,
                    volume=record.volume,
                    open_interest=record.open_interest,
                    call_bid=call_bid,
                    call_ask=call_ask,
                    put_bid=put_bid,
                    put_ask=put_ask,
                )
                cleaned.append(cleaned_record)
            else:
                cleaned.append(record)

        quality_report = {
            "total_raw": total,
            "total_cleaned": len(cleaned),
            "removed_empty": removed_empty,
            "removed_moneyness": removed_moneyness,
            "removed_expired": removed_expired,
            "iv_missing": iv_missing_count,
            "stale_quotes": stale_count,
            "bid_ask_fixed": bid_ask_fixed,
        }

        self._logger.info(
            "CLEAN_DONE | raw=%d → cleaned=%d | removed: empty=%d, moneyness=%d, expired=%d | "
            "iv_missing=%d | stale=%d | bid_ask_fixed=%d",
            total,
            len(cleaned),
            removed_empty,
            removed_moneyness,
            removed_expired,
            iv_missing_count,
            stale_count,
            bid_ask_fixed,
        )

        return CleanResult(
            cleaned_records=cleaned,
            quality_report=quality_report,
        )
