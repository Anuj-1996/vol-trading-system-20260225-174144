from __future__ import annotations

from typing import List, Sequence, Tuple

from .base_strategy import BaseStrategy, StrategyObject


class IronButterflyStrategy(BaseStrategy):
    @property
    def strategy_name(self) -> str:
        return "Iron Butterfly"

    def generate_valid_combinations(self, strike_set: Sequence[float]) -> List[StrategyObject]:
        unique = sorted(set(strike_set))
        output: List[StrategyObject] = []
        for center in unique:
            lowers = [s for s in unique if s < center]
            uppers = [s for s in unique if s > center]
            for low in lowers:
                for high in uppers:
                    strategy = self._build_strategy((low, center, center, high))
                    if strategy is not None:
                        output.append(strategy)
        return output

    def compute_margin(self, strikes: Tuple[float, ...]) -> float:
        return max(strikes[1] - strikes[0], strikes[3] - strikes[2])
