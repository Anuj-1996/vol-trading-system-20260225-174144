from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Dict, List, Tuple

import numpy as np

from ..decorators import log_execution_time
from ..logger import get_logger
from ..data.models import FilteredOptionRecord


@dataclass(frozen=True)
class MarketSurface:
    expiry_list: Tuple[date, ...]
    strike_grid: np.ndarray
    maturity_grid: np.ndarray
    implied_vol_matrix: np.ndarray


class SurfaceBuilder:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @staticmethod
    def _year_fraction(start: date, end: date) -> float:
        return max((end - start).days / 365.0, 1.0 / 365.0)

    @log_execution_time
    def build_surface(self, records: List[FilteredOptionRecord]) -> MarketSurface:
        self._logger.info("START | build_surface | record_count=%d", len(records))
        if not records:
            raise ValueError("No filtered option records supplied to surface builder")

        trade_date = min(item.trade_date for item in records)
        expiries = sorted({item.expiry for item in records})
        strike_grid = np.array(sorted({item.strike for item in records}), dtype=float)
        maturity_grid = np.array([self._year_fraction(trade_date, expiry) for expiry in expiries], dtype=float)

        smile_by_expiry: Dict[date, Dict[float, List[float]]] = {}
        for record in records:
            expiry_bucket = smile_by_expiry.setdefault(record.expiry, {})
            strike_bucket = expiry_bucket.setdefault(record.strike, [])
            strike_bucket.append(record.iv / 100.0)

        iv_matrix = np.zeros((len(expiries), len(strike_grid)), dtype=float)
        for expiry_index, expiry in enumerate(expiries):
            strike_to_iv = smile_by_expiry[expiry]
            known_strikes = np.array(sorted(strike_to_iv.keys()), dtype=float)
            known_ivs = np.array(
                [float(np.mean(strike_to_iv[strike])) for strike in known_strikes],
                dtype=float,
            )

            if known_strikes.size == 1:
                iv_matrix[expiry_index, :] = known_ivs[0]
            else:
                iv_matrix[expiry_index, :] = np.interp(strike_grid, known_strikes, known_ivs)

        self._logger.info(
            "END | build_surface | expiries=%d | strikes=%d | iv_matrix_shape=%s",
            len(expiries),
            strike_grid.size,
            iv_matrix.shape,
        )
        return MarketSurface(
            expiry_list=tuple(expiries),
            strike_grid=strike_grid,
            maturity_grid=maturity_grid,
            implied_vol_matrix=iv_matrix,
        )
