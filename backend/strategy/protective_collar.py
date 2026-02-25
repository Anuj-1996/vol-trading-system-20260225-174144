from __future__ import annotations

from typing import List, Sequence, Tuple

from .base_strategy import BaseStrategy, StrategyObject


class ProtectiveCollarStrategy(BaseStrategy):
    @property
    def strategy_name(self) -> str:
        return "Protective Collar"

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
        return max(1.0, (strikes[1] - strikes[0]) * 0.5)
