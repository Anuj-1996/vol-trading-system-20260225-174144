from __future__ import annotations

from typing import Dict, List, Type

from ..decorators import log_execution_time
from ..exceptions import StrategyError
from ..logger import get_logger
from .base_strategy import BaseStrategy, StrategyConstraints
from .bear_call_spread import BearCallSpreadStrategy
from .bear_put_spread import BearPutSpreadStrategy
from .bull_call_spread import BullCallSpreadStrategy
from .bull_put_spread import BullPutSpreadStrategy
from .butterfly_spread import ButterflySpreadStrategy
from .calendar_spread import CalendarSpreadStrategy
from .cash_secured_put import CashSecuredPutStrategy
from .covered_call import CoveredCallStrategy
from .diagonal_spread import DiagonalSpreadStrategy
from .iron_butterfly import IronButterflyStrategy
from .iron_condor import IronCondorStrategy
from .long_call import LongCallStrategy
from .long_put import LongPutStrategy
from .long_straddle import LongStraddleStrategy
from .long_strangle import LongStrangleStrategy
from .protective_collar import ProtectiveCollarStrategy
from .protective_put import ProtectivePutStrategy
from .ratio_backspread import RatioBackspreadStrategy


class StrategyFactory:
    _registry: Dict[str, Type[BaseStrategy]] = {
        "long_call": LongCallStrategy,
        "long_put": LongPutStrategy,
        "covered_call": CoveredCallStrategy,
        "protective_put": ProtectivePutStrategy,
        "cash_secured_put": CashSecuredPutStrategy,
        "bull_call_spread": BullCallSpreadStrategy,
        "bear_put_spread": BearPutSpreadStrategy,
        "bull_put_spread": BullPutSpreadStrategy,
        "bear_call_spread": BearCallSpreadStrategy,
        "long_straddle": LongStraddleStrategy,
        "long_strangle": LongStrangleStrategy,
        "iron_condor": IronCondorStrategy,
        "iron_butterfly": IronButterflyStrategy,
        "butterfly_spread": ButterflySpreadStrategy,
        "calendar_spread": CalendarSpreadStrategy,
        "diagonal_spread": DiagonalSpreadStrategy,
        "protective_collar": ProtectiveCollarStrategy,
        "ratio_backspread": RatioBackspreadStrategy,
    }

    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @log_execution_time
    def create(self, strategy_key: str, constraints: StrategyConstraints) -> BaseStrategy:
        key = strategy_key.strip().lower()
        self._logger.info("START | create_strategy | key=%s", key)
        strategy_cls = self._registry.get(key)
        if strategy_cls is None:
            raise StrategyError(
                message="Unsupported strategy",
                context={"strategy_key": strategy_key, "supported": list(self._registry.keys())},
            )
        instance = strategy_cls(constraints=constraints)
        self._logger.info("END | create_strategy | key=%s", key)
        return instance

    @log_execution_time
    def supported(self) -> List[str]:
        return sorted(self._registry.keys())
