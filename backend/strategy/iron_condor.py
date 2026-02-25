from __future__ import annotations

from typing import List, Sequence, Tuple

from .base_strategy import BaseStrategy, StrategyObject


class IronCondorStrategy(BaseStrategy):
    @property
    def strategy_name(self) -> str:
        return "Iron Condor"

    def generate_valid_combinations(self, strike_set: Sequence[float]) -> List[StrategyObject]:
        output: List[StrategyObject] = []
        combos = self._simple_combinations(strike_set, 4)
        for k1, k2, k3, k4 in combos:
            if not (k1 < k2 < k3 < k4):
                continue
            strategy = self._build_strategy((k1, k2, k3, k4))
            if strategy is not None:
                output.append(strategy)
        return output

    def compute_margin(self, strikes: Tuple[float, ...]) -> float:
        left_width = strikes[1] - strikes[0]
        right_width = strikes[3] - strikes[2]
        return max(left_width, right_width)
