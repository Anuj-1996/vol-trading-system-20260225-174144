from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import List

import numpy as np

from ..decorators import log_execution_time
from ..logger import get_logger


@dataclass(frozen=True)
class BacktestPoint:
    trade_date: date
    selected_strategy: str
    realized_pnl: float


@dataclass(frozen=True)
class BacktestSummary:
    sharpe: float
    max_drawdown: float
    tail_error_rate: float
    calibration_drift: float
    points: List[BacktestPoint]


class WalkForwardBacktestEngine:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @log_execution_time
    def evaluate(self, points: List[BacktestPoint], calibration_errors: np.ndarray) -> BacktestSummary:
        self._logger.info("START | walk_forward_evaluate | points=%d", len(points))
        if not points:
            return BacktestSummary(0.0, 0.0, 0.0, 0.0, [])

        pnl = np.array([point.realized_pnl for point in points], dtype=float)
        mean_pnl = float(np.mean(pnl))
        std_pnl = float(np.std(pnl))
        sharpe = mean_pnl / std_pnl if std_pnl > 1e-12 else 0.0

        cumulative = np.cumsum(pnl)
        running_max = np.maximum.accumulate(cumulative)
        drawdown = running_max - cumulative
        max_drawdown = float(np.max(drawdown))

        var_99 = float(np.percentile(pnl, 1))
        tail_error_rate = float(np.mean(pnl < var_99))

        calibration_drift = float(np.std(calibration_errors)) if calibration_errors.size > 0 else 0.0
        self._logger.info(
            "END | walk_forward_evaluate | sharpe=%.6f | max_drawdown=%.6f",
            sharpe,
            max_drawdown,
        )

        return BacktestSummary(
            sharpe=sharpe,
            max_drawdown=max_drawdown,
            tail_error_rate=tail_error_rate,
            calibration_drift=calibration_drift,
            points=points,
        )
