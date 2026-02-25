from __future__ import annotations

from typing import List, Sequence, Tuple

from .base_strategy import BaseStrategy, StrategyObject


class RatioBackspreadStrategy(BaseStrategy):
    @property
    def strategy_name(self) -> str:
        return "Ratio Backspread"

    def generate_valid_combinations(self, strike_set: Sequence[float]) -> List[StrategyObject]:
        output: List[StrategyObject] = []
        for low, high in self._simple_combinations(strike_set, 2):
            if low >= high:
                continue
            strategy = self._build_strategy((low, high, high))
            if strategy is not None:
                output.append(strategy)
        return output

    def compute_margin(self, strikes: Tuple[float, ...]) -> float:
        return max(1.0, (max(strikes) - min(strikes)) * 1.5)
