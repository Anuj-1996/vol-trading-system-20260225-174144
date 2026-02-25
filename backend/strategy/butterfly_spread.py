from __future__ import annotations

from typing import List, Sequence, Tuple

from .base_strategy import BaseStrategy, StrategyObject


class ButterflySpreadStrategy(BaseStrategy):
    @property
    def strategy_name(self) -> str:
        return "Butterfly Spread"

    def generate_valid_combinations(self, strike_set: Sequence[float]) -> List[StrategyObject]:
        unique = sorted(set(strike_set))
        output: List[StrategyObject] = []
        for i in range(len(unique) - 2):
            low = unique[i]
            mid = unique[i + 1]
            high = unique[i + 2]
            strategy = self._build_strategy((low, mid, mid, high))
            if strategy is not None:
                output.append(strategy)
        return output

    def compute_margin(self, strikes: Tuple[float, ...]) -> float:
        return max(strikes[1] - strikes[0], strikes[3] - strikes[2])
