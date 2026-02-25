from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np

from ..decorators import log_execution_time
from ..logger import get_logger
from ..strategy.base_strategy import StrategyObject


@dataclass(frozen=True)
class StrategyMetrics:
    strategy_type: str
    strikes: tuple[float, ...]
    expected_value: float
    var_95: float
    var_99: float
    expected_shortfall: float
    probability_of_loss: float
    return_on_margin: float
    pnl_skewness: float
    pnl_kurtosis: float
    max_loss: float
    convexity_exposure: float
    delta_exposure: float
    gamma_exposure: float
    vega_exposure: float
    theta_exposure: float
    skew_exposure: float


class StaticEvaluationEngine:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @staticmethod
    def _strategy_payoff(terminal_prices: np.ndarray, strategy: StrategyObject) -> np.ndarray:
        strikes = strategy.strikes
        terminal = terminal_prices

        if strategy.strategy_type == "Long Call":
            return np.maximum(terminal - strikes[0], 0.0)
        if strategy.strategy_type == "Long Put":
            return np.maximum(strikes[0] - terminal, 0.0)

        center = float(np.mean(strikes))
        return np.maximum(np.abs(terminal - center) - (max(strikes) - min(strikes)) * 0.25, -strategy.margin)

    @staticmethod
    def _estimate_greeks(strategy: StrategyObject, spot: float) -> tuple[float, float, float, float, float]:
        strikes = np.array(strategy.strikes, dtype=float)
        center = float(np.mean(strikes)) if strikes.size else spot
        moneyness_gap = abs(center - spot) / max(spot, 1e-8)
        width = float(np.ptp(strikes)) if strikes.size > 1 else max(spot * 0.02, 1.0)
        width_scale = max(width / max(spot, 1e-8), 1e-4)
        style = strategy.strategy_type.lower()

        if "long call" in style:
            delta = float(np.clip(0.55 - 1.5 * moneyness_gap, 0.05, 0.75))
            gamma = float(0.02 / (1.0 + 12.0 * moneyness_gap))
            vega = float(0.10 / (1.0 + 8.0 * moneyness_gap))
        elif "long put" in style:
            delta = -float(np.clip(0.55 - 1.5 * moneyness_gap, 0.05, 0.75))
            gamma = float(0.02 / (1.0 + 12.0 * moneyness_gap))
            vega = float(0.10 / (1.0 + 8.0 * moneyness_gap))
        elif "straddle" in style or "strangle" in style:
            delta = 0.0
            gamma = float(0.028 / (1.0 + 6.0 * width_scale))
            vega = float(0.14 / (1.0 + 5.0 * width_scale))
        elif "condor" in style or "butterfly" in style:
            delta = 0.0
            gamma = float(0.018 / (1.0 + 7.0 * width_scale))
            vega = float(0.08 / (1.0 + 6.0 * width_scale))
        else:
            delta = float(np.clip((spot - center) / max(width, 1.0), -0.4, 0.4))
            gamma = float(0.012 / (1.0 + 8.0 * width_scale))
            vega = float(0.07 / (1.0 + 6.0 * width_scale))

        theta = float(-0.35 * vega)
        skew = float(-0.25 * delta)
        return delta, gamma, vega, theta, skew

    @log_execution_time
    def evaluate(
        self,
        strategies: List[StrategyObject],
        terminal_prices: np.ndarray,
        spot: float,
    ) -> Tuple[List[StrategyMetrics], Dict[str, np.ndarray]]:
        self._logger.info("START | evaluate | strategies=%d | sample_size=%d", len(strategies), terminal_prices.size)
        results: List[StrategyMetrics] = []
        pnl_distributions: Dict[str, np.ndarray] = {}

        for strategy in strategies:
            pnl = self._strategy_payoff(terminal_prices, strategy) - 0.01 * strategy.margin
            expected_value = float(np.mean(pnl))
            var_95_threshold = float(np.percentile(pnl, 5))
            var_99_threshold = float(np.percentile(pnl, 1))
            var_95 = max(0.0, -var_95_threshold)
            var_99 = max(0.0, -var_99_threshold)
            tail = pnl[pnl <= var_99_threshold]
            expected_shortfall = max(0.0, -float(np.mean(tail))) if tail.size > 0 else var_99
            probability_of_loss = float(np.mean(pnl < 0.0))
            return_on_margin = expected_value / max(strategy.margin, 1e-8)

            centered = pnl - expected_value
            std = float(np.std(centered))
            pnl_skewness = float(np.mean((centered / std) ** 3)) if std > 1e-12 else 0.0
            pnl_kurtosis = float(np.mean((centered / std) ** 4)) if std > 1e-12 else 0.0
            max_loss = max(0.0, -float(np.min(pnl)))
            convexity_exposure = float(np.mean(np.abs(np.gradient(np.gradient(np.sort(pnl))))))
            delta_exposure, gamma_exposure, vega_exposure, theta_exposure, skew_exposure = self._estimate_greeks(
                strategy=strategy,
                spot=spot,
            )

            metrics = StrategyMetrics(
                strategy_type=strategy.strategy_type,
                strikes=strategy.strikes,
                expected_value=expected_value,
                var_95=var_95,
                var_99=var_99,
                expected_shortfall=expected_shortfall,
                probability_of_loss=probability_of_loss,
                return_on_margin=return_on_margin,
                pnl_skewness=pnl_skewness,
                pnl_kurtosis=pnl_kurtosis,
                max_loss=max_loss,
                convexity_exposure=convexity_exposure,
                delta_exposure=delta_exposure,
                gamma_exposure=gamma_exposure,
                vega_exposure=vega_exposure,
                theta_exposure=theta_exposure,
                skew_exposure=skew_exposure,
            )
            results.append(metrics)
            key = f"{strategy.strategy_type}:{strategy.strikes}"
            pnl_distributions[key] = pnl

        self._logger.info("END | evaluate | metrics_generated=%d", len(results))
        return results, pnl_distributions
