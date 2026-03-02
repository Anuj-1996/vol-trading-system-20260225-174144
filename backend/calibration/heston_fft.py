from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

import numpy as np
from scipy.interpolate import PchipInterpolator
from scipy.optimize import brentq
from scipy.stats import norm

from ..config import CONFIG
from ..logger import get_logger


@dataclass(frozen=True)
class JointHestonParameters:
    kappa: float
    theta: float
    xi: float
    rho: float
    v0: float


class HestonFFTPricer:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @staticmethod
    def _char_func(
        u: np.ndarray,
        spot: float,
        maturity: float,
        rate: float,
        dividend_yield: float,
        params: JointHestonParameters,
    ) -> np.ndarray:
        i = 1j
        kappa = params.kappa
        theta = params.theta
        xi = params.xi
        rho = params.rho
        v0 = params.v0

        d = np.sqrt((rho * xi * i * u - kappa) ** 2 + xi**2 * (i * u + u**2))
        g = (kappa - rho * xi * i * u - d) / (kappa - rho * xi * i * u + d)

        exp_dt = np.exp(-d * maturity)
        c = (
            (rate - dividend_yield) * i * u * maturity
            + (kappa * theta / xi**2)
            * ((kappa - rho * xi * i * u - d) * maturity - 2.0 * np.log((1.0 - g * exp_dt) / (1.0 - g)))
        )
        d_term = ((kappa - rho * xi * i * u - d) / xi**2) * ((1.0 - exp_dt) / (1.0 - g * exp_dt))
        return np.exp(c + d_term * v0 + i * u * np.log(spot))

    @staticmethod
    def _bs_call_price(
        spot: float,
        strike: float,
        maturity: float,
        rate: float,
        dividend_yield: float,
        sigma: float,
    ) -> float:
        sigma = max(float(sigma), 1e-12)
        maturity = max(float(maturity), 1e-12)
        strike = max(float(strike), 1e-12)
        spot = max(float(spot), 1e-12)

        sqrt_t = np.sqrt(maturity)
        d1 = (
            np.log(spot / strike)
            + (rate - dividend_yield + 0.5 * sigma * sigma) * maturity
        ) / (sigma * sqrt_t)
        d2 = d1 - sigma * sqrt_t

        discounted_spot = spot * np.exp(-dividend_yield * maturity)
        discounted_strike = strike * np.exp(-rate * maturity)
        return float(discounted_spot * norm.cdf(d1) - discounted_strike * norm.cdf(d2))

    def implied_vol_from_call_prices(
        self,
        call_prices: np.ndarray,
        spot: float,
        strikes: np.ndarray,
        maturity: float,
        rate: float,
        dividend_yield: float,
    ) -> np.ndarray:
        maturity = max(float(maturity), 1e-12)
        discounted_spot = float(spot) * float(np.exp(-float(dividend_yield) * maturity))
        implied_vols = np.full(call_prices.shape, np.nan, dtype=float)

        for idx, strike in enumerate(strikes):
            strike_value = max(float(strike), 1e-12)
            intrinsic = max(
                discounted_spot - strike_value * float(np.exp(-float(rate) * maturity)),
                0.0,
            )
            upper_bound = max(discounted_spot - 1e-12, intrinsic + 1e-12)
            target = float(np.clip(call_prices[idx], intrinsic + 1e-12, upper_bound))

            def objective_fn(vol: float) -> float:
                return self._bs_call_price(
                    spot=spot,
                    strike=strike_value,
                    maturity=maturity,
                    rate=rate,
                    dividend_yield=dividend_yield,
                    sigma=vol,
                ) - target

            try:
                implied_vols[idx] = float(brentq(objective_fn, 1e-6, 5.0, maxiter=200))
            except ValueError:
                fallback = np.sqrt(max(2.0 * np.log(max(spot, 1e-12) / strike_value), 0.0) / maturity)
                implied_vols[idx] = float(np.clip(fallback, 1e-6, 5.0))

        return implied_vols

    def price_calls_fft(
        self,
        spot: float,
        maturity: float,
        rate: float,
        dividend_yield: float,
        params: JointHestonParameters,
        strikes: np.ndarray,
    ) -> np.ndarray:
        n = CONFIG.calibration.fft_grid_size
        eta = CONFIG.calibration.fft_eta
        alpha = CONFIG.calibration.alpha_damp
        self._logger.debug(
            "START | price_calls_fft | maturity=%.6f | strike_count=%d | alpha=%.4f | kappa=%.6f | theta=%.6f | xi=%.6f | rho=%.6f | v0=%.6f",
            maturity,
            strikes.size,
            alpha,
            params.kappa,
            params.theta,
            params.xi,
            params.rho,
            params.v0,
        )

        j = np.arange(n)
        vj = eta * j
        delta_k = 2.0 * np.pi / (n * eta)
        b = 0.5 * n * delta_k
        log_spot = float(np.log(max(spot, 1e-12)))
        log_strike_grid = (log_spot - b) + delta_k * j

        u = vj - (alpha + 1.0) * 1j
        numerator = np.exp(-rate * maturity) * self._char_func(
            u=u,
            spot=spot,
            maturity=maturity,
            rate=rate,
            dividend_yield=dividend_yield,
            params=params,
        )
        denominator = alpha**2 + alpha - vj**2 + 1j * (2.0 * alpha + 1.0) * vj
        psi = numerator / denominator

        weights = np.ones(n)
        weights[0] = 1.0
        weights[1::2] = 4.0
        weights[2:-1:2] = 2.0
        weights = weights / 3.0

        fft_input = np.exp(1j * (b - log_spot) * vj) * psi * eta * weights
        fft_values = np.fft.fft(fft_input)
        call_grid = np.exp(-alpha * log_strike_grid) * np.real(fft_values) / np.pi

        grid_strikes = np.exp(log_strike_grid)

        finite_mask = np.isfinite(grid_strikes) & np.isfinite(call_grid)
        grid_strikes = grid_strikes[finite_mask]
        call_grid = call_grid[finite_mask]

        if grid_strikes.size < 2 or call_grid.size < 2:
            fallback_prices = np.full_like(strikes, fill_value=max(float(np.nanmean(call_grid)) if call_grid.size else 0.0, 0.0), dtype=float)
            self._logger.warning("MODEL_GRID_FALLBACK | insufficient finite FFT points")
            return fallback_prices

        call_grid = np.maximum(call_grid, 0.0)

        call_grid = np.maximum.accumulate(call_grid[::-1])[::-1]

        log_grid = np.log(np.maximum(grid_strikes, 1e-12))
        log_target = np.log(np.maximum(strikes, 1e-12))
        interpolator = PchipInterpolator(log_grid, call_grid, extrapolate=False)
        prices = interpolator(log_target)

        left_value = float(call_grid[0])
        right_value = float(call_grid[-1])
        prices = np.where(np.isnan(prices), np.interp(log_target, log_grid, call_grid, left=left_value, right=right_value), prices)
        prices = np.maximum(prices, 0.0)

        self._logger.debug(
            "END | price_calls_fft | min_price=%.6f | max_price=%.6f | strike_min=%.2f | strike_max=%.2f",
            prices.min(),
            prices.max(),
            grid_strikes.min(),
            grid_strikes.max(),
        )
        return prices
