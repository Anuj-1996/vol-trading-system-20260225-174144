from __future__ import annotations

from typing import List, Sequence, Tuple

from .base_strategy import BaseStrategy, StrategyObject


class CalendarSpreadStrategy(BaseStrategy):
    @property
    def strategy_name(self) -> str:
        return "Calendar Spread"

    def generate_valid_combinations(self, strike_set: Sequence[float]) -> List[StrategyObject]:
        output: List[StrategyObject] = []
        for (strike,) in self._simple_combinations(strike_set, 1):
            strategy = self._build_strategy((strike, strike))
            if strategy is not None:
                output.append(strategy)
        return output

    def compute_margin(self, strikes: Tuple[float, ...]) -> float:
        return max(1.0, strikes[0] * 0.05)
