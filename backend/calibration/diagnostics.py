from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Dict, List

import numpy as np

from ..decorators import log_execution_time
from ..logger import get_logger
from ..surface.builder import MarketSurface


@dataclass(frozen=True)
class DiagnosticsResult:
    rmse_by_expiry: Dict[date, float]
    residual_surface: np.ndarray
    wing_mispricing_score: float
    skew_slope_mismatch: float
    unstable: bool


class ModelMarketDiagnostics:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @log_execution_time
    def evaluate(self, market_surface: MarketSurface, model_iv_matrix: np.ndarray) -> DiagnosticsResult:
        self._logger.info("START | diagnostics_evaluate")
        residual_surface = model_iv_matrix - market_surface.implied_vol_matrix

        rmse_by_expiry: Dict[date, float] = {}
        for idx, expiry in enumerate(market_surface.expiry_list):
            rmse_by_expiry[expiry] = float(np.sqrt(np.mean(residual_surface[idx, :] ** 2)))

        left_wing = residual_surface[:, : max(1, residual_surface.shape[1] // 5)]
        right_wing = residual_surface[:, -max(1, residual_surface.shape[1] // 5) :]
        wing_mispricing_score = float(np.mean(np.abs(left_wing)) + np.mean(np.abs(right_wing)))

        market_skew = np.gradient(market_surface.implied_vol_matrix, axis=1)
        model_skew = np.gradient(model_iv_matrix, axis=1)
        skew_slope_mismatch = float(np.mean(np.abs(model_skew - market_skew)))

        rmse_values: List[float] = list(rmse_by_expiry.values())
        unstable = bool(np.std(rmse_values) > 0.05 or np.mean(rmse_values) > 0.12)

        self._logger.info(
            "END | diagnostics_evaluate | wing_mispricing=%.6f | skew_mismatch=%.6f | unstable=%s",
            wing_mispricing_score,
            skew_slope_mismatch,
            unstable,
        )
        return DiagnosticsResult(
            rmse_by_expiry=rmse_by_expiry,
            residual_surface=residual_surface,
            wing_mispricing_score=wing_mispricing_score,
            skew_slope_mismatch=skew_slope_mismatch,
            unstable=unstable,
        )
