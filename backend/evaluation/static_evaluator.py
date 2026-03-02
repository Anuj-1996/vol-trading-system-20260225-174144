from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
from scipy.stats import norm as sp_norm

from ..decorators import log_execution_time
from ..logger import get_logger
from ..strategy.base_strategy import Leg, StrategyObject


# ── Black-Scholes helpers ─────────────────────────────────────────────

def bs_call_price(spot: float, strike: float, T: float, r: float, sigma: float) -> float:
    """Black-Scholes call price."""
    sigma = max(sigma, 1e-8)
    T = max(T, 1e-8)
    d1 = (np.log(spot / strike) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    d2 = d1 - sigma * np.sqrt(T)
    return float(spot * sp_norm.cdf(d1) - strike * np.exp(-r * T) * sp_norm.cdf(d2))


def bs_put_price(spot: float, strike: float, T: float, r: float, sigma: float) -> float:
    """Black-Scholes put price via put-call parity."""
    call = bs_call_price(spot, strike, T, r, sigma)
    return float(call - spot + strike * np.exp(-r * T))


def bs_delta(spot: float, strike: float, T: float, r: float, sigma: float, option_type: str) -> float:
    sigma = max(sigma, 1e-8)
    T = max(T, 1e-8)
    d1 = (np.log(spot / strike) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    if option_type == 'C':
        return float(sp_norm.cdf(d1))
    return float(sp_norm.cdf(d1) - 1.0)


def bs_gamma(spot: float, strike: float, T: float, r: float, sigma: float) -> float:
    sigma = max(sigma, 1e-8)
    T = max(T, 1e-8)
    d1 = (np.log(spot / strike) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    return float(sp_norm.pdf(d1) / (spot * sigma * np.sqrt(T)))


def bs_vega(spot: float, strike: float, T: float, r: float, sigma: float) -> float:
    sigma = max(sigma, 1e-8)
    T = max(T, 1e-8)
    d1 = (np.log(spot / strike) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    return float(spot * sp_norm.pdf(d1) * np.sqrt(T) * 0.01)  # per 1% vol move


def bs_theta(spot: float, strike: float, T: float, r: float, sigma: float, option_type: str) -> float:
    sigma = max(sigma, 1e-8)
    T = max(T, 1e-8)
    d1 = (np.log(spot / strike) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    d2 = d1 - sigma * np.sqrt(T)
    term1 = -(spot * sp_norm.pdf(d1) * sigma) / (2.0 * np.sqrt(T))
    if option_type == 'C':
        term2 = -r * strike * np.exp(-r * T) * sp_norm.cdf(d2)
    else:
        term2 = r * strike * np.exp(-r * T) * sp_norm.cdf(-d2)
    return float((term1 + term2) / 365.0)  # per day


def price_leg(leg: Leg, spot: float, T: float, r: float, sigma: float) -> float:
    """Price a single leg (premium that would be paid/received)."""
    if leg.option_type == 'C':
        return bs_call_price(spot, leg.strike, T, r, sigma)
    return bs_put_price(spot, leg.strike, T, r, sigma)


@dataclass(frozen=True)
class StrategyMetrics:
    strategy_type: str
    strikes: tuple[float, ...]
    legs_label: str          # human-readable legs e.g. "24150P↑ 24200C↑"
    net_premium: float       # net premium paid (positive = debit, negative = credit)
    expected_value: float
    var_95: float
    var_99: float
    expected_shortfall: float
    probability_of_loss: float
    return_on_margin: float
    pnl_skewness: float
    pnl_kurtosis: float
    max_loss: float
    convexity_exposure: float
    delta_exposure: float
    gamma_exposure: float
    vega_exposure: float
    theta_exposure: float
    skew_exposure: float


IVLookup = Callable[[float, str], float]
"""iv_lookup(strike, option_type) -> implied vol"""


class StaticEvaluationEngine:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @staticmethod
    def _compute_break_evens(terminal_prices: np.ndarray, pnl: np.ndarray, spot: float) -> list[float]:
        """Find break-even prices where PnL crosses zero, estimated from MC samples."""
        try:
            order = np.argsort(terminal_prices)
            sorted_prices = terminal_prices[order]
            sorted_pnl = pnl[order]
            crossings = []
            for i in range(len(sorted_pnl) - 1):
                if sorted_pnl[i] * sorted_pnl[i + 1] < 0:
                    p0, p1 = float(sorted_prices[i]), float(sorted_prices[i + 1])
                    v0, v1 = float(sorted_pnl[i]), float(sorted_pnl[i + 1])
                    be = p0 + (p1 - p0) * (-v0) / (v1 - v0 + 1e-15)
                    crossings.append(round(be, 2))
            if not crossings:
                return []
            unique = [crossings[0]]
            threshold = max(spot * 0.005, 10.0)
            for c in crossings[1:]:
                if abs(c - unique[-1]) > threshold:
                    unique.append(c)
            return unique[:6]
        except Exception:
            return []

    @staticmethod
    def _intrinsic_payoff(terminal_prices: np.ndarray, legs: Tuple[Leg, ...]) -> np.ndarray:
        """Compute multi-leg intrinsic payoff at expiry (before premium cost)."""
        payoff = np.zeros_like(terminal_prices, dtype=float)
        for leg in legs:
            if leg.option_type == 'C':
                intrinsic = np.maximum(terminal_prices - leg.strike, 0.0)
            else:
                intrinsic = np.maximum(leg.strike - terminal_prices, 0.0)
            payoff += leg.direction * leg.ratio * intrinsic
        return payoff

    @staticmethod
    def _compute_net_premium(
        legs: Tuple[Leg, ...],
        spot: float,
        T: float,
        r: float,
        iv_lookup: IVLookup,
    ) -> float:
        """Compute net premium paid to enter the trade (positive = debit)."""
        total = 0.0
        for leg in legs:
            sigma = iv_lookup(leg.strike, leg.option_type)
            premium = price_leg(leg, spot, T, r, sigma)
            # direction: +1 means we buy → we pay premium
            # direction: -1 means we sell → we receive premium
            total += leg.direction * leg.ratio * premium
        return total

    @staticmethod
    def _compute_greeks(
        legs: Tuple[Leg, ...],
        spot: float,
        T: float,
        r: float,
        iv_lookup: IVLookup,
    ) -> Tuple[float, float, float, float, float]:
        """Compute aggregate Greeks from BS for all legs."""
        total_delta = 0.0
        total_gamma = 0.0
        total_vega = 0.0
        total_theta = 0.0
        for leg in legs:
            sigma = iv_lookup(leg.strike, leg.option_type)
            d = bs_delta(spot, leg.strike, T, r, sigma, leg.option_type)
            g = bs_gamma(spot, leg.strike, T, r, sigma)
            v = bs_vega(spot, leg.strike, T, r, sigma)
            th = bs_theta(spot, leg.strike, T, r, sigma, leg.option_type)
            total_delta += leg.direction * leg.ratio * d
            total_gamma += leg.direction * leg.ratio * g
            total_vega += leg.direction * leg.ratio * v
            total_theta += leg.direction * leg.ratio * th
        skew = -0.25 * total_delta  # simple proxy
        return total_delta, total_gamma, total_vega, total_theta, skew

    @staticmethod
    def _legs_label(legs: Tuple[Leg, ...]) -> str:
        """Human-readable leg description, e.g. '24150P↑ 24200C↑'."""
        parts = []
        for leg in legs:
            arrow = '↑' if leg.direction > 0 else '↓'
            ratio_str = f'{leg.ratio}×' if leg.ratio > 1 else ''
            parts.append(f"{ratio_str}{int(leg.strike)}{leg.option_type}{arrow}")
        return ' '.join(parts)

    @log_execution_time
    def evaluate(
        self,
        strategies: List[StrategyObject],
        terminal_prices: np.ndarray,
        spot: float,
        T: float = 0.02,
        r: float = 0.065,
        iv_lookup: Optional[IVLookup] = None,
    ) -> Tuple[List[StrategyMetrics], Dict[str, np.ndarray]]:
        self._logger.info("START | evaluate | strategies=%d | sample_size=%d", len(strategies), terminal_prices.size)

        # Default IV lookup: flat 20% vol
        if iv_lookup is None:
            iv_lookup = lambda strike, otype: 0.20

        results: List[StrategyMetrics] = []
        pnl_distributions: Dict[str, np.ndarray] = {}

        for strategy in strategies:
            legs = strategy.legs
            if not legs:
                # Skip strategies with no legs defined
                continue

            # 1. Intrinsic payoff at expiry
            payoff = self._intrinsic_payoff(terminal_prices, legs)

            # 2. Net premium cost (positive = debit paid)
            net_premium = self._compute_net_premium(legs, spot, T, r, iv_lookup)

            # 3. PnL = payoff - net_premium
            # For covered call / protective put, add underlying P&L
            has_underlying = strategy.strategy_type in ("Covered Call", "Protective Put", "Protective Collar")
            if has_underlying:
                pnl = payoff - net_premium + (terminal_prices - spot)
            else:
                pnl = payoff - net_premium

            expected_value = float(np.mean(pnl))
            var_95_threshold = float(np.percentile(pnl, 5))
            var_99_threshold = float(np.percentile(pnl, 1))
            var_95 = max(0.0, -var_95_threshold)
            var_99 = max(0.0, -var_99_threshold)
            tail = pnl[pnl <= var_99_threshold]
            expected_shortfall = max(0.0, -float(np.mean(tail))) if tail.size > 0 else var_99
            probability_of_loss = float(np.mean(pnl < 0.0))

            # cost = abs(net_premium) for debit strategies, margin for credit
            cost = abs(net_premium) if net_premium > 0 else max(strategy.margin, abs(net_premium) + 1.0)
            return_on_margin = expected_value / max(cost, 1e-8)

            centered = pnl - expected_value
            std = float(np.std(centered))
            pnl_skewness = float(np.mean((centered / std) ** 3)) if std > 1e-12 else 0.0
            pnl_kurtosis = float(np.mean((centered / std) ** 4)) if std > 1e-12 else 0.0
            max_loss = max(0.0, -float(np.min(pnl)))
            convexity_exposure = float(np.mean(np.abs(np.gradient(np.gradient(np.sort(pnl))))))

            delta_exposure, gamma_exposure, vega_exposure, theta_exposure, skew_exposure = self._compute_greeks(
                legs, spot, T, r, iv_lookup,
            )

            metrics = StrategyMetrics(
                strategy_type=strategy.strategy_type,
                strikes=strategy.strikes,
                legs_label=self._legs_label(legs),
                net_premium=net_premium,
                expected_value=expected_value,
                var_95=var_95,
                var_99=var_99,
                expected_shortfall=expected_shortfall,
                probability_of_loss=probability_of_loss,
                return_on_margin=return_on_margin,
                pnl_skewness=pnl_skewness,
                pnl_kurtosis=pnl_kurtosis,
                max_loss=max_loss,
                convexity_exposure=convexity_exposure,
                delta_exposure=delta_exposure,
                gamma_exposure=gamma_exposure,
                vega_exposure=vega_exposure,
                theta_exposure=theta_exposure,
                skew_exposure=skew_exposure,
            )
            results.append(metrics)
            key = f"{strategy.strategy_type}:{strategy.strikes}"
            pnl_distributions[key] = pnl

        self._logger.info("END | evaluate | metrics_generated=%d", len(results))
        return results, pnl_distributions
