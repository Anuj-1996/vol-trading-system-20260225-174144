from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import numpy as np

from ..decorators import log_execution_time
from ..logger import get_logger

try:
    from ..cpp import vol_core, HAS_CPP
except Exception:
    vol_core = None  # type: ignore
    HAS_CPP = False


class HedgeMode(str, Enum):
    NO_HEDGE = "no_hedge"
    DAILY_DELTA = "daily_delta"
    THRESHOLD = "threshold"


@dataclass(frozen=True)
class DynamicPnLDistribution:
    pnl: np.ndarray
    average_adjustments: float


class DynamicHedgingEngine:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @staticmethod
    def _delta_approximation(price: np.ndarray, strike: float) -> np.ndarray:
        return np.clip((price - strike) / np.maximum(np.abs(price), 1e-8), -1.0, 1.0)

    @log_execution_time
    def evaluate(
        self,
        full_price_paths: np.ndarray,
        strike: float,
        premium: float,
        hedge_mode: HedgeMode,
        transaction_cost_rate: float,
        delta_threshold: float = 0.10,
    ) -> DynamicPnLDistribution:
        self._logger.info(
            "START | dynamic_hedge | mode=%s | path_shape=%s",
            hedge_mode.value,
            full_price_paths.shape,
        )

        # ── C++ fast path ──
        if HAS_CPP and vol_core is not None:
            mode_int = {HedgeMode.NO_HEDGE: 0, HedgeMode.DAILY_DELTA: 1, HedgeMode.THRESHOLD: 2}[hedge_mode]
            result = vol_core.dynamic_hedge(
                np.ascontiguousarray(full_price_paths, dtype=np.float64),
                strike, premium, mode_int, transaction_cost_rate, delta_threshold,
            )
            pnl = np.asarray(result["pnl"])
            avg_adj = float(result["average_adjustments"])
            self._logger.info("END | dynamic_hedge [C++] | mean_pnl=%.6f | avg_adj=%.3f", float(np.mean(pnl)), avg_adj)
            return DynamicPnLDistribution(pnl=pnl, average_adjustments=avg_adj)

        steps_plus_one, path_count = full_price_paths.shape
        steps = steps_plus_one - 1

        hedge_positions = np.zeros(path_count, dtype=float)
        cumulative_cost = np.zeros(path_count, dtype=float)
        adjustment_count = np.zeros(path_count, dtype=float)

        for step in range(steps):
            spot = full_price_paths[step, :]
            next_spot = full_price_paths[step + 1, :]
            target_delta = self._delta_approximation(spot, strike)

            if hedge_mode == HedgeMode.NO_HEDGE:
                adjustment = np.zeros(path_count, dtype=float)
            elif hedge_mode == HedgeMode.DAILY_DELTA:
                adjustment = target_delta - hedge_positions
            else:
                gap = np.abs(target_delta - hedge_positions)
                adjustment = np.where(gap >= delta_threshold, target_delta - hedge_positions, 0.0)

            trade_notional = np.abs(adjustment) * spot
            trade_cost = transaction_cost_rate * trade_notional

            hedge_positions = hedge_positions + adjustment
            cumulative_cost = cumulative_cost + trade_cost
            adjustment_count = adjustment_count + (np.abs(adjustment) > 0.0).astype(float)

            self._logger.debug(
                "HEDGE_STEP | step=%d | avg_abs_adjustment=%.6f | avg_trade_cost=%.6f",
                step,
                float(np.mean(np.abs(adjustment))),
                float(np.mean(trade_cost)),
            )

            hedge_pnl_step = hedge_positions * (next_spot - spot)
            cumulative_cost = cumulative_cost - hedge_pnl_step

        terminal_spot = full_price_paths[-1, :]
        option_payoff = np.maximum(terminal_spot - strike, 0.0)
        pnl = premium - option_payoff - cumulative_cost

        result = DynamicPnLDistribution(
            pnl=pnl,
            average_adjustments=float(np.mean(adjustment_count)),
        )
        self._logger.info(
            "END | dynamic_hedge | mean_pnl=%.6f | avg_adjustments=%.3f",
            float(np.mean(pnl)),
            result.average_adjustments,
        )
        return result
