from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from itertools import combinations
from typing import Iterable, List, Sequence, Tuple

from ..decorators import log_execution_time
from ..logger import get_logger


@dataclass(frozen=True)
class StrategyConstraints:
    capital_limit: float
    strike_increment: int
    max_legs: int
    max_width: float
    max_combinations_per_strategy: int


@dataclass(frozen=True)
class StrategyObject:
    strategy_type: str
    strikes: Tuple[float, ...]
    margin: float


class BaseStrategy(ABC):
    def __init__(self, constraints: StrategyConstraints) -> None:
        self.constraints = constraints
        self._logger = get_logger(self.__class__.__name__)

    @property
    @abstractmethod
    def strategy_name(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def generate_valid_combinations(self, strike_set: Sequence[float]) -> List[StrategyObject]:
        raise NotImplementedError

    @abstractmethod
    def compute_margin(self, strikes: Tuple[float, ...]) -> float:
        raise NotImplementedError

    def _valid_increment(self, strike: float) -> bool:
        return int(round(strike)) % self.constraints.strike_increment == 0

    def _validate_strikes(self, strikes: Tuple[float, ...]) -> bool:
        if len(strikes) > self.constraints.max_legs:
            return False
        if any(not self._valid_increment(s) for s in strikes):
            return False
        width = max(strikes) - min(strikes)
        return width <= self.constraints.max_width

    def _build_strategy(self, strikes: Tuple[float, ...]) -> StrategyObject | None:
        if not self._validate_strikes(strikes):
            return None
        margin = self.compute_margin(strikes)
        if margin > self.constraints.capital_limit:
            return None
        return StrategyObject(strategy_type=self.strategy_name, strikes=strikes, margin=margin)

    @log_execution_time
    def _simple_combinations(self, strike_set: Sequence[float], legs: int) -> List[Tuple[float, ...]]:
        unique = sorted(set(strike_set))
        output: List[Tuple[float, ...]] = []
        for combo in combinations(unique, legs):
            output.append(combo)
            if len(output) >= self.constraints.max_combinations_per_strategy:
                break
        self._logger.info("COMBOS | strategy=%s | legs=%d | count=%d", self.strategy_name, legs, len(output))
        return output

    @staticmethod
    def _width(strikes: Iterable[float]) -> float:
        sorted_strikes = sorted(strikes)
        return sorted_strikes[-1] - sorted_strikes[0]
