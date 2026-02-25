from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

import numpy as np

from ..decorators import log_execution_time
from ..logger import get_logger
from .garch_model import GarchModel
from .hmm_model import HMMVolatilityModel


@dataclass(frozen=True)
class RegimeClassification:
    label: str
    confidence: float
    ranking_weights: Dict[str, float]


class RegimeClassifier:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._garch = GarchModel()
        self._hmm = HMMVolatilityModel()

    @log_execution_time
    def classify(self, returns: np.ndarray) -> RegimeClassification:
        self._logger.info("START | classify_regime")
        conditional_vol = self._garch.estimate_conditional_volatility(returns)
        hmm_result = self._hmm.fit_predict_two_state(conditional_vol)

        if hmm_result.state_series.size == 0:
            return RegimeClassification(
                label="unknown",
                confidence=0.0,
                ranking_weights={"lambda_es99": 0.35, "lambda_fragility": 0.30, "lambda_rom": 0.20},
            )

        current_state = int(hmm_result.state_series[-1])
        label = "high_vol" if current_state == 1 else "low_vol"
        distance = abs(hmm_result.high_vol_mean - hmm_result.low_vol_mean)
        confidence = min(1.0, distance / max(hmm_result.high_vol_mean + hmm_result.low_vol_mean, 1e-8))

        if label == "high_vol":
            weights = {"lambda_es99": 0.45, "lambda_fragility": 0.40, "lambda_rom": 0.15}
        else:
            weights = {"lambda_es99": 0.30, "lambda_fragility": 0.20, "lambda_rom": 0.30}

        self._logger.info("END | classify_regime | label=%s | confidence=%.4f", label, confidence)
        return RegimeClassification(label=label, confidence=confidence, ranking_weights=weights)
