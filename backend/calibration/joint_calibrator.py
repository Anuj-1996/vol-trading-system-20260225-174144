from __future__ import annotations

from dataclasses import dataclass
import sys
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

try:
    from tqdm.auto import tqdm
except Exception:  # pragma: no cover - graceful fallback
    tqdm = None


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
        progress_bar = None
        if tqdm is not None and sys.stderr.isatty():
            progress_bar = tqdm(total=CONFIG.calibration.max_iterations, desc="Heston calibration", leave=False)

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
            if progress_bar is not None:
                progress_bar.update(1)
            elif iteration_counter["value"] % 10 == 0:
                self._logger.info("ITERATION | count=%d", iteration_counter["value"])

        initial_objective = objective_fn(np.array(initial_guess, dtype=float))

        result: OptimizeResult = minimize(
            fun=objective_fn,
            x0=np.array(initial_guess, dtype=float),
            method="L-BFGS-B",
            bounds=CONFIG.calibration.param_bounds,
            callback=callback,
            options={
                "maxiter": CONFIG.calibration.max_iterations,
                "ftol": CONFIG.calibration.tolerance,
                "maxls": 60,
            },
        )

        if progress_bar is not None:
            progress_bar.close()

        if not result.success:
            result_message = str(result.message)
            result_objective = float(result.fun) if result.fun is not None else float("inf")
            has_finite_candidate = bool(result.x is not None and np.all(np.isfinite(result.x)) and np.isfinite(result_objective))
            looks_like_linesearch_abort = "ABNORMAL" in result_message.upper() or "LINE SEARCH" in result_message.upper()
            objective_is_reasonable = result_objective <= max(0.25, initial_objective * 0.98)

            if has_finite_candidate and looks_like_linesearch_abort and objective_is_reasonable:
                self._logger.warning(
                    "CALIBRATION_ACCEPTED_WITH_ABORT | message=%s | iterations=%d | objective=%.8f | initial_objective=%.8f",
                    result_message,
                    int(result.nit),
                    result_objective,
                    initial_objective,
                )
            else:
                self._logger.error("CALIBRATION_FAILED | message=%s", result_message)
                raise CalibrationError(
                    message="Joint Heston calibration failed",
                    context={
                        "message": result_message,
                        "iterations": int(result.nit),
                        "objective": result_objective if np.isfinite(result_objective) else None,
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
