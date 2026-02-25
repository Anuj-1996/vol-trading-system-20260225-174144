from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict


@dataclass
class EngineError(Exception):
    message: str
    context: Dict[str, Any]

    def __str__(self) -> str:
        return f"{self.message} | context={self.context}"


class DataIngestionError(EngineError):
    pass


class CalibrationError(EngineError):
    pass


class SimulationError(EngineError):
    pass


class StrategyError(EngineError):
    pass
