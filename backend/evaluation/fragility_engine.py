from __future__ import annotations

import numpy as np

from ..decorators import log_execution_time
from ..logger import get_logger


class FragilityEngine:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @log_execution_time
    def compute_fragility(self, pnl_distribution: np.ndarray) -> float:
        self._logger.info("START | compute_fragility | sample_size=%d", pnl_distribution.size)
        if pnl_distribution.size == 0:
            return 0.0
        downside = pnl_distribution[pnl_distribution < 0.0]
        downside_ratio = float(downside.size) / float(pnl_distribution.size)
        tail = np.percentile(pnl_distribution, 1)
        fragility = float(downside_ratio * abs(tail))
        self._logger.info("END | compute_fragility | fragility=%.6f", fragility)
        return fragility
