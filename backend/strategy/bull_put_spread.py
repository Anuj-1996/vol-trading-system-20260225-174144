from __future__ import annotations

from typing import List, Sequence, Tuple

from .base_strategy import BaseStrategy, StrategyObject


class BullPutSpreadStrategy(BaseStrategy):
    @property
    def strategy_name(self) -> str:
        return "Bull Put Spread"

    def generate_valid_combinations(self, strike_set: Sequence[float]) -> List[StrategyObject]:
        output: List[StrategyObject] = []
        for low, high in self._simple_combinations(strike_set, 2):
            if low >= high:
                continue
            strategy = self._build_strategy((low, high))
            if strategy is not None:
                output.append(strategy)
        return output

    def compute_margin(self, strikes: Tuple[float, ...]) -> float:
        return self._width(strikes)
