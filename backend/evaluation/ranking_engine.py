from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

import numpy as np

from ..config import CONFIG
from ..decorators import log_execution_time
from ..logger import get_logger
from .static_evaluator import StrategyMetrics


@dataclass(frozen=True)
class RankedStrategy:
    metrics: StrategyMetrics
    fragility_score: float
    overall_score: float


class RankingEngine:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @staticmethod
    def _normalize(values: List[float]) -> np.ndarray:
        array = np.array(values, dtype=float)
        min_value = float(np.min(array))
        max_value = float(np.max(array))
        if abs(max_value - min_value) < 1e-12:
            return np.ones_like(array)
        return (array - min_value) / (max_value - min_value)

    @log_execution_time
    def rank(
        self,
        metrics: List[StrategyMetrics],
        fragility_scores: Dict[str, float],
        regime_weights: Dict[str, float] | None = None,
    ) -> List[RankedStrategy]:
        self._logger.info("START | rank | count=%d", len(metrics))
        if not metrics:
            return []

        lambda_es99 = regime_weights.get("lambda_es99", CONFIG.ranking.lambda_es99) if regime_weights else CONFIG.ranking.lambda_es99
        lambda_fragility = (
            regime_weights.get("lambda_fragility", CONFIG.ranking.lambda_fragility)
            if regime_weights
            else CONFIG.ranking.lambda_fragility
        )
        lambda_rom = regime_weights.get("lambda_rom", CONFIG.ranking.lambda_rom) if regime_weights else CONFIG.ranking.lambda_rom

        normalized_ev = self._normalize([item.expected_value for item in metrics])
        normalized_es99 = self._normalize([item.expected_shortfall for item in metrics])
        normalized_rom = self._normalize([item.return_on_margin for item in metrics])

        ranked: List[RankedStrategy] = []
        for idx, metric in enumerate(metrics):
            key = f"{metric.strategy_type}:{metric.strikes}"
            fragility = fragility_scores.get(key, 0.0)
            score = (
                float(normalized_ev[idx])
                - lambda_es99 * float(normalized_es99[idx])
                - lambda_fragility * fragility
                + lambda_rom * float(normalized_rom[idx])
            )
            # Realism penalty: strategies with zero VaR and zero P(Loss)
            # are almost certainly unrealistic (deep ITM arb artifacts).
            # Apply a heavy discount so they don't dominate rankings.
            if metric.var_99 <= 0 and metric.probability_of_loss <= 0 and metric.max_loss <= 0:
                score *= 0.30  # 70% penalty for "too good to be true"
            ranked.append(RankedStrategy(metrics=metric, fragility_score=fragility, overall_score=score))

        ranked_sorted = sorted(ranked, key=lambda item: item.overall_score, reverse=True)[: CONFIG.ranking.top_n]
        self._logger.info("END | rank | top_n=%d", len(ranked_sorted))
        return ranked_sorted
