from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Dict, List

import numpy as np

from ..config import CONFIG
from ..decorators import log_execution_time
from ..logger import get_logger
from ..surface.builder import MarketSurface
from ..data.models import FilteredOptionRecord
from .heston_fft import HestonFFTPricer, JointHestonParameters


@dataclass(frozen=True)
class CalibrationErrorMetrics:
    weighted_rmse: float
    rmse_by_expiry: Dict[date, float]
    feller_gap: float


class LiquidityWeightedObjective:
    def __init__(self, pricer: HestonFFTPricer) -> None:
        self._pricer = pricer
        self._logger = get_logger(self.__class__.__name__)

    @staticmethod
    def _build_weights(records: List[FilteredOptionRecord]) -> Dict[date, float]:
        weights: Dict[date, float] = {}
        for item in records:
            weight = item.open_interest + item.volume
            weights[item.expiry] = weights.get(item.expiry, 0.0) + weight
        return weights

    @log_execution_time
    def compute(
        self,
        params: JointHestonParameters,
        market_surface: MarketSurface,
        filtered_records: List[FilteredOptionRecord],
        spot: float,
        rate: float,
        dividend_yield: float,
    ) -> CalibrationErrorMetrics:
        self._logger.debug("START | objective_compute")
        expiry_weights = self._build_weights(filtered_records)
        total_weight = max(sum(expiry_weights.values()), 1e-8)

        rmse_by_expiry: Dict[date, float] = {}
        weighted_error_sum = 0.0

        for expiry_index, expiry in enumerate(market_surface.expiry_list):
            maturity = float(market_surface.maturity_grid[expiry_index])
            strikes = market_surface.strike_grid
            model_prices = self._pricer.price_calls_fft(
                spot=spot,
                maturity=maturity,
                rate=rate,
                dividend_yield=dividend_yield,
                params=params,
                strikes=strikes,
            )
            model_ivs = self._pricer.implied_vol_from_call_prices(
                call_prices=model_prices,
                spot=spot,
                strikes=strikes,
                maturity=maturity,
                rate=rate,
                dividend_yield=dividend_yield,
            )
            market_ivs = market_surface.implied_vol_matrix[expiry_index, :]

            sample_count = min(5, strikes.size)
            self._logger.debug(
                "MODEL_TRACE | expiry=%s | maturity=%.6f | params=(kappa=%.6f,theta=%.6f,xi=%.6f,rho=%.6f,v0=%.6f) | prices_first5=%s | ivs_first5=%s",
                expiry,
                maturity,
                params.kappa,
                params.theta,
                params.xi,
                params.rho,
                params.v0,
                np.array2string(model_prices[:sample_count], precision=6, separator=", "),
                np.array2string(model_ivs[:sample_count], precision=6, separator=", "),
            )

            iv_span = float(np.nanmax(model_ivs) - np.nanmin(model_ivs))
            if iv_span < 1e-4:
                self._logger.warning(
                    "MODEL_IV_NEARLY_IDENTICAL | expiry=%s | maturity=%.6f | iv_span=%.8f | params=(kappa=%.6f,theta=%.6f,xi=%.6f,rho=%.6f,v0=%.6f)",
                    expiry,
                    maturity,
                    iv_span,
                    params.kappa,
                    params.theta,
                    params.xi,
                    params.rho,
                    params.v0,
                )

            rmse = float(np.sqrt(np.mean((model_ivs - market_ivs) ** 2)))
            rmse_by_expiry[expiry] = rmse

            expiry_weight = expiry_weights.get(expiry, 1.0)
            if maturity <= 30.0 / 365.0:
                expiry_weight *= CONFIG.calibration.short_maturity_weight_multiplier
            weighted_error_sum += expiry_weight * (rmse**2)

        weighted_rmse = float(np.sqrt(weighted_error_sum / total_weight))
        feller_gap = 2.0 * params.kappa * params.theta - params.xi**2

        self._logger.debug(
            "END | objective_compute | weighted_rmse=%.8f | feller_gap=%.8f",
            weighted_rmse,
            feller_gap,
        )
        return CalibrationErrorMetrics(
            weighted_rmse=weighted_rmse,
            rmse_by_expiry=rmse_by_expiry,
            feller_gap=feller_gap,
        )
