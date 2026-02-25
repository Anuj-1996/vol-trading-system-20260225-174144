from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..decorators import log_execution_time
from ..logger import get_logger


@dataclass(frozen=True)
class HMMStateResult:
    state_series: np.ndarray
    low_vol_mean: float
    high_vol_mean: float


class HMMVolatilityModel:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @log_execution_time
    def fit_predict_two_state(self, volatility_series: np.ndarray) -> HMMStateResult:
        self._logger.info("START | fit_predict_two_state | observations=%d", volatility_series.size)
        if volatility_series.size == 0:
            empty = np.array([], dtype=int)
            return HMMStateResult(state_series=empty, low_vol_mean=0.0, high_vol_mean=0.0)

        threshold = float(np.median(volatility_series))
        states = (volatility_series > threshold).astype(int)
        low_values = volatility_series[states == 0]
        high_values = volatility_series[states == 1]

        low_mean = float(np.mean(low_values)) if low_values.size > 0 else threshold
        high_mean = float(np.mean(high_values)) if high_values.size > 0 else threshold

        self._logger.info("END | fit_predict_two_state | low_mean=%.6f | high_mean=%.6f", low_mean, high_mean)
        return HMMStateResult(state_series=states, low_vol_mean=low_mean, high_vol_mean=high_mean)
