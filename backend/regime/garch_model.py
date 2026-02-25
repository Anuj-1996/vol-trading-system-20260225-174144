from __future__ import annotations

import numpy as np

from ..decorators import log_execution_time
from ..logger import get_logger


class GarchModel:
    def __init__(self, omega: float = 1e-6, alpha: float = 0.08, beta: float = 0.90) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self.omega = omega
        self.alpha = alpha
        self.beta = beta

    @log_execution_time
    def estimate_conditional_volatility(self, returns: np.ndarray) -> np.ndarray:
        self._logger.info("START | estimate_conditional_volatility | observations=%d", returns.size)
        if returns.size == 0:
            return np.array([], dtype=float)
        sigma2 = np.empty_like(returns, dtype=float)
        sigma2[0] = np.var(returns) if returns.size > 1 else 1e-4
        for idx in range(1, returns.size):
            sigma2[idx] = self.omega + self.alpha * (returns[idx - 1] ** 2) + self.beta * sigma2[idx - 1]
        vol = np.sqrt(np.maximum(sigma2, 1e-12))
        self._logger.info("END | estimate_conditional_volatility")
        return vol
