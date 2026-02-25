from __future__ import annotations

from typing import List

from ..config import CONFIG
from ..decorators import log_execution_time
from ..logger import get_logger
from ..data.models import FilteredOptionRecord, OptionChainRawRecord


class LiquidityFilterEngine:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @staticmethod
    def _valid_increment(strike: float) -> bool:
        for increment in CONFIG.data.strike_increment_allowed:
            if int(round(strike)) % increment == 0:
                return True
        return False

    @staticmethod
    def _spread_ok(bid: float, ask: float) -> bool:
        if bid <= 0.0 or ask <= 0.0 or ask < bid:
            return False
        mid = 0.5 * (bid + ask)
        if mid <= 0.0:
            return False
        spread_pct = (ask - bid) / mid
        return spread_pct <= CONFIG.liquidity.max_bid_ask_spread_pct

    @log_execution_time
    def filter_records(self, records: List[OptionChainRawRecord], spot: float) -> List[FilteredOptionRecord]:
        self._logger.info("START | filter_records | record_count=%d | spot=%.4f", len(records), spot)
        output: List[FilteredOptionRecord] = []

        lower_bound = spot * (1.0 - CONFIG.liquidity.moneyness_window_pct)
        upper_bound = spot * (1.0 + CONFIG.liquidity.moneyness_window_pct)

        for record in records:
            if record.open_interest < CONFIG.liquidity.min_open_interest:
                continue
            if record.volume < CONFIG.liquidity.min_volume:
                continue
            if record.strike < lower_bound or record.strike > upper_bound:
                continue
            if not self._valid_increment(record.strike):
                continue

            call_mid = 0.5 * (record.call_bid + record.call_ask)
            if self._spread_ok(record.call_bid, record.call_ask):
                output.append(
                    FilteredOptionRecord(
                        trade_date=record.trade_date,
                        expiry=record.expiry,
                        strike=record.strike,
                        iv=record.call_iv,
                        side="CALL",
                        volume=record.volume,
                        open_interest=record.open_interest,
                        bid=record.call_bid,
                        ask=record.call_ask,
                        mid=call_mid,
                        moneyness=record.strike / spot,
                    )
                )

            put_mid = 0.5 * (record.put_bid + record.put_ask)
            if self._spread_ok(record.put_bid, record.put_ask):
                output.append(
                    FilteredOptionRecord(
                        trade_date=record.trade_date,
                        expiry=record.expiry,
                        strike=record.strike,
                        iv=record.put_iv,
                        side="PUT",
                        volume=record.volume,
                        open_interest=record.open_interest,
                        bid=record.put_bid,
                        ask=record.put_ask,
                        mid=put_mid,
                        moneyness=record.strike / spot,
                    )
                )

        self._logger.info(
            "END | filter_records | input=%d | output=%d | lower_bound=%.2f | upper_bound=%.2f",
            len(records),
            len(output),
            lower_bound,
            upper_bound,
        )
        return output
