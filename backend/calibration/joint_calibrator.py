from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

import numpy as np
from scipy.optimize import OptimizeResult, minimize

from ..config import CONFIG
from ..decorators import log_execution_time
from ..exceptions import CalibrationError
from ..logger import get_logger
from ..surface.builder import MarketSurface
from ..data.models import FilteredOptionRecord
from .heston_fft import HestonFFTPricer, JointHestonParameters
from .objective import CalibrationErrorMetrics, LiquidityWeightedObjective


@dataclass(frozen=True)
class CalibrationResult:
    parameters: JointHestonParameters
    metrics: CalibrationErrorMetrics
    iterations: int
    converged: bool


class JointHestonCalibrator:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._pricer = HestonFFTPricer()
        self._objective = LiquidityWeightedObjective(pricer=self._pricer)

    @staticmethod
    def _from_vector(vector: np.ndarray) -> JointHestonParameters:
        return JointHestonParameters(
            kappa=float(vector[0]),
            theta=float(vector[1]),
            xi=float(vector[2]),
            rho=float(vector[3]),
            v0=float(vector[4]),
        )

    @log_execution_time
    def calibrate(
        self,
        market_surface: MarketSurface,
        filtered_records: List[FilteredOptionRecord],
        spot: float,
        rate: float,
        dividend_yield: float,
        initial_guess: Tuple[float, float, float, float, float] = (1.5, 0.04, 0.4, -0.6, 0.04),
    ) -> CalibrationResult:
        self._logger.info("START | calibrate | expiries=%d", len(market_surface.expiry_list))

        iteration_counter = {"value": 0}

        def objective_fn(vector: np.ndarray) -> float:
            params = self._from_vector(vector)
            metrics = self._objective.compute(
                params=params,
                market_surface=market_surface,
                filtered_records=filtered_records,
                spot=spot,
                rate=rate,
                dividend_yield=dividend_yield,
            )
            penalty = 0.0
            if metrics.feller_gap < 0.0:
                penalty = CONFIG.calibration.feller_penalty_weight * (metrics.feller_gap**2)
            value = metrics.weighted_rmse + penalty
            self._logger.debug(
                "ITER_OBJ | iter=%d | kappa=%.5f | theta=%.5f | xi=%.5f | rho=%.5f | v0=%.5f | value=%.8f",
                iteration_counter["value"],
                params.kappa,
                params.theta,
                params.xi,
                params.rho,
                params.v0,
                value,
            )
            return float(value)

        def callback(_: np.ndarray) -> None:
            iteration_counter["value"] += 1
            self._logger.info("ITERATION | count=%d", iteration_counter["value"])

        result: OptimizeResult = minimize(
            fun=objective_fn,
            x0=np.array(initial_guess, dtype=float),
            method="L-BFGS-B",
            bounds=CONFIG.calibration.param_bounds,
            callback=callback,
            options={
                "maxiter": CONFIG.calibration.max_iterations,
                "ftol": CONFIG.calibration.tolerance,
            },
        )

        if not result.success:
            self._logger.error("CALIBRATION_FAILED | message=%s", result.message)
            raise CalibrationError(
                message="Joint Heston calibration failed",
                context={
                    "message": str(result.message),
                    "iterations": int(result.nit),
                    "objective": float(result.fun) if result.fun is not None else None,
                },
            )

        final_params = self._from_vector(np.array(result.x, dtype=float))
        final_metrics = self._objective.compute(
            params=final_params,
            market_surface=market_surface,
            filtered_records=filtered_records,
            spot=spot,
            rate=rate,
            dividend_yield=dividend_yield,
        )

        self._logger.info(
            "END | calibrate | converged=%s | iterations=%d | final_error=%.8f",
            result.success,
            int(result.nit),
            final_metrics.weighted_rmse,
        )
        return CalibrationResult(
            parameters=final_params,
            metrics=final_metrics,
            iterations=int(result.nit),
            converged=bool(result.success),
        )
