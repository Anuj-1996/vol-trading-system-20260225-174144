from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from itertools import combinations
from typing import Iterable, List, Sequence, Tuple

from ..decorators import log_execution_time
from ..logger import get_logger


@dataclass(frozen=True)
class Leg:
    """Single option leg in a strategy."""
    strike: float
    option_type: str   # 'C' (call) or 'P' (put)
    direction: int     # +1 = long (buy), -1 = short (sell)
    ratio: int = 1     # number of contracts for this leg


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
    legs: Tuple[Leg, ...] = ()


def build_legs(strategy_type: str, strikes: Tuple[float, ...]) -> Tuple[Leg, ...]:
    """Build option legs for a strategy given its type and strike tuple.

    Each strategy type has a well-defined leg structure:
    - direction: +1 = long (buy), -1 = short (sell)
    - option_type: 'C' = call, 'P' = put
    """
    t = strategy_type
    s = strikes

    if t == "Long Call":
        return (Leg(s[0], 'C', +1),)
    if t == "Long Put":
        return (Leg(s[0], 'P', +1),)
    if t == "Covered Call":
        # Long underlying + short call  (underlying modeled separately)
        return (Leg(s[0], 'C', -1),)
    if t == "Protective Put":
        # Long underlying + long put
        return (Leg(s[0], 'P', +1),)
    if t == "Cash Secured Put":
        return (Leg(s[0], 'P', -1),)

    # ---------- 2-leg spreads ----------
    if t == "Bull Call Spread":
        # Buy lower call, sell higher call
        return (Leg(s[0], 'C', +1), Leg(s[1], 'C', -1))
    if t == "Bear Call Spread":
        # Sell lower call, buy higher call
        return (Leg(s[0], 'C', -1), Leg(s[1], 'C', +1))
    if t == "Bull Put Spread":
        # Sell higher put, buy lower put
        return (Leg(s[0], 'P', +1), Leg(s[1], 'P', -1))
    if t == "Bear Put Spread":
        # Buy higher put, sell lower put
        return (Leg(s[0], 'P', -1), Leg(s[1], 'P', +1))
    if t == "Long Straddle":
        # Buy call + buy put at same strike
        return (Leg(s[0], 'C', +1), Leg(s[0], 'P', +1))
    if t == "Long Strangle":
        # Buy OTM put (lower) + buy OTM call (higher)
        return (Leg(s[0], 'P', +1), Leg(s[1], 'C', +1))
    if t == "Protective Collar":
        # Long underlying + buy put (lower) + sell call (higher)
        return (Leg(s[0], 'P', +1), Leg(s[1], 'C', -1))
    if t == "Calendar Spread":
        # Sell near-term call, buy far-term call (same strike)
        # Simplified as net debit position at single strike
        return (Leg(s[0], 'C', +1), Leg(s[1], 'C', -1))
    if t == "Diagonal Spread":
        # Buy far-term call at lower, sell near-term call at higher
        return (Leg(s[0], 'C', +1), Leg(s[1], 'C', -1))
    if t == "Ratio Backspread":
        # Sell 1 lower call, buy 2 higher calls
        return (Leg(s[0], 'C', -1), Leg(s[1], 'C', +1, ratio=2))

    # ---------- 4-leg spreads ----------
    if t == "Iron Condor":
        # Buy OTM put (K1), sell put (K2), sell call (K3), buy OTM call (K4)
        return (Leg(s[0], 'P', +1), Leg(s[1], 'P', -1),
                Leg(s[2], 'C', -1), Leg(s[3], 'C', +1))
    if t == "Iron Butterfly":
        # Buy OTM put (low), sell ATM put (mid), sell ATM call (mid), buy OTM call (high)
        return (Leg(s[0], 'P', +1), Leg(s[1], 'P', -1),
                Leg(s[2], 'C', -1), Leg(s[3], 'C', +1))
    if t == "Butterfly Spread":
        # Buy call K1, sell 2× call K2, buy call K3
        return (Leg(s[0], 'C', +1), Leg(s[1], 'C', -1, ratio=2),
                Leg(s[3], 'C', +1))

    # Fallback: treat as long call at first strike
    return (Leg(s[0], 'C', +1),)


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
        legs = build_legs(self.strategy_name, strikes)
        return StrategyObject(strategy_type=self.strategy_name, strikes=strikes, margin=margin, legs=legs)

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
