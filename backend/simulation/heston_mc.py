from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..config import CONFIG
from ..decorators import log_execution_time
from ..exceptions import SimulationError
from ..logger import get_logger
from ..calibration.heston_fft import JointHestonParameters


@dataclass(frozen=True)
class SimulationResult:
    terminal_prices: np.ndarray
    full_price_paths: Optional[np.ndarray]
    volatility_paths: Optional[np.ndarray]


class HestonMonteCarloEngine:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @staticmethod
    def _clip_variance(variance: np.ndarray) -> np.ndarray:
        return np.maximum(variance, 1e-12)

    @log_execution_time
    def simulate(
        self,
        params: JointHestonParameters,
        spot: float,
        maturity: float,
        risk_free_rate: float,
        path_count: int | None = None,
        time_steps: int | None = None,
        seed: int | None = None,
        full_path: bool = False,
    ) -> SimulationResult:
        paths = path_count or CONFIG.simulation.default_paths
        steps = time_steps or CONFIG.simulation.default_steps
        random_seed = seed if seed is not None else CONFIG.simulation.random_seed

        self._logger.info(
            "START | simulate | paths=%d | steps=%d | maturity=%.6f | full_path=%s | seed=%d",
            paths,
            steps,
            maturity,
            full_path,
            random_seed,
        )

        if paths <= 0 or steps <= 0:
            raise SimulationError(
                message="Invalid simulation dimensions",
                context={"paths": paths, "steps": steps},
            )

        try:
            rng = np.random.default_rng(random_seed)
            dt = maturity / steps
            sqrt_dt = np.sqrt(dt)

            log_prices = np.full(paths, np.log(spot), dtype=float)
            variances = np.full(paths, params.v0, dtype=float)

            price_paths = np.empty((steps + 1, paths), dtype=float) if full_path else None
            vol_paths = np.empty((steps + 1, paths), dtype=float) if full_path else None

            if full_path:
                price_paths[0, :] = np.exp(log_prices)
                vol_paths[0, :] = variances

            for t in range(1, steps + 1):
                z1 = rng.standard_normal(paths)
                z2_independent = rng.standard_normal(paths)
                z2 = params.rho * z1 + np.sqrt(max(1.0 - params.rho**2, 1e-12)) * z2_independent

                variances = self._clip_variance(
                    variances
                    + params.kappa * (params.theta - variances) * dt
                    + params.xi * np.sqrt(self._clip_variance(variances)) * sqrt_dt * z2
                )
                log_prices = (
                    log_prices
                    + (risk_free_rate - 0.5 * variances) * dt
                    + np.sqrt(self._clip_variance(variances)) * sqrt_dt * z1
                )

                if full_path:
                    price_paths[t, :] = np.exp(log_prices)
                    vol_paths[t, :] = variances

            terminal = np.exp(log_prices)

            self._logger.info(
                "END | simulate | terminal_mean=%.6f | terminal_std=%.6f",
                float(np.mean(terminal)),
                float(np.std(terminal)),
            )
            return SimulationResult(
                terminal_prices=terminal,
                full_price_paths=price_paths,
                volatility_paths=vol_paths,
            )
        except SimulationError:
            self._logger.exception("ERROR | simulate")
            raise
        except Exception as exc:
            self._logger.exception("ERROR | simulate")
            raise SimulationError(
                message="Monte Carlo simulation failed",
                context={"error": str(exc), "paths": paths, "steps": steps},
            ) from exc
