from __future__ import annotations

from dataclasses import dataclass
from typing import List

import numpy as np
from scipy.optimize import least_squares

from ..logger import get_logger
from ..surface.builder import MarketSurface


@dataclass(frozen=True)
class SABRParameters:
    alpha: float
    beta: float
    rho: float
    nu: float


@dataclass(frozen=True)
class SABRSmileCalibration:
    expiry_label: str
    maturity: float
    parameters: SABRParameters
    rmse: float
    iterations: int
    converged: bool
    point_count: int


@dataclass(frozen=True)
class SABRSurfaceCalibrationResult:
    parameters: SABRParameters
    weighted_rmse: float
    iterations: int
    converged: bool
    expiry_fits: List[SABRSmileCalibration]
    model_iv_matrix: np.ndarray


class SABRSurfaceCalibrator:
    def __init__(self, beta: float = 0.7) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._beta = float(np.clip(beta, 0.0, 1.0))

    @staticmethod
    def _safe_float(value: float, fallback: float = 0.0) -> float:
        return float(value) if np.isfinite(value) else fallback

    @staticmethod
    def _hagan_log_normal_vol_scalar(
        forward: float,
        strike: float,
        maturity: float,
        alpha: float,
        beta: float,
        rho: float,
        nu: float,
    ) -> float:
        if (
            not np.isfinite(forward)
            or not np.isfinite(strike)
            or not np.isfinite(maturity)
            or not np.isfinite(alpha)
            or not np.isfinite(beta)
            or not np.isfinite(rho)
            or not np.isfinite(nu)
            or forward <= 0.0
            or strike <= 0.0
            or maturity <= 0.0
            or alpha <= 0.0
            or nu < 0.0
            or abs(rho) >= 1.0
        ):
            return np.nan

        one_minus_beta = 1.0 - beta
        if abs(forward - strike) < 1e-12:
            fk_beta = max(forward ** one_minus_beta, 1e-12)
            correction = (
                ((one_minus_beta ** 2) / 24.0) * (alpha ** 2) / max(forward ** (2.0 * one_minus_beta), 1e-12)
                + 0.25 * rho * beta * nu * alpha / fk_beta
                + ((2.0 - 3.0 * rho * rho) / 24.0) * (nu ** 2)
            )
            return (alpha / fk_beta) * (1.0 + correction * maturity)

        log_fk = float(np.log(forward / strike))
        fk_beta = max((forward * strike) ** (0.5 * one_minus_beta), 1e-12)
        z = (nu / alpha) * fk_beta * log_fk
        sqrt_term = max(1.0 - 2.0 * rho * z + z * z, 1e-16)
        numerator = np.sqrt(sqrt_term) + z - rho
        denominator = max(1.0 - rho, 1e-16)
        x_z = np.log(max(numerator / denominator, 1e-16))
        if abs(x_z) < 1e-12:
            z_over_xz = 1.0
        else:
            z_over_xz = z / x_z

        log_fk_sq = log_fk * log_fk
        log_fk_q = log_fk_sq * log_fk_sq
        denom = fk_beta * (
            1.0
            + ((one_minus_beta ** 2) / 24.0) * log_fk_sq
            + ((one_minus_beta ** 4) / 1920.0) * log_fk_q
        )
        correction = (
            ((one_minus_beta ** 2) / 24.0) * (alpha ** 2) / max((forward * strike) ** one_minus_beta, 1e-12)
            + 0.25 * rho * beta * nu * alpha / fk_beta
            + ((2.0 - 3.0 * rho * rho) / 24.0) * (nu ** 2)
        )
        return (alpha / max(denom, 1e-12)) * z_over_xz * (1.0 + correction * maturity)

    def implied_vols(
        self,
        forward: float,
        strikes: np.ndarray,
        maturity: float,
        params: SABRParameters,
    ) -> np.ndarray:
        vols = np.asarray(
            [
                self._hagan_log_normal_vol_scalar(
                    forward=forward,
                    strike=float(strike),
                    maturity=float(maturity),
                    alpha=float(params.alpha),
                    beta=float(params.beta),
                    rho=float(params.rho),
                    nu=float(params.nu),
                )
                for strike in np.asarray(strikes, dtype=float)
            ],
            dtype=float,
        )
        return np.clip(vols, 0.01, 3.0)

    def calibrate_surface(
        self,
        market_surface: MarketSurface,
        spot: float,
        rate: float,
        dividend_yield: float,
    ) -> SABRSurfaceCalibrationResult:
        strike_grid = np.asarray(market_surface.strike_grid, dtype=float)
        maturity_grid = np.asarray(market_surface.maturity_grid, dtype=float)
        market_matrix = np.asarray(market_surface.implied_vol_matrix, dtype=float)
        model_matrix = np.zeros_like(market_matrix, dtype=float)

        fits: List[SABRSmileCalibration] = []
        total_squared_error = 0.0
        total_points = 0

        for maturity_index, maturity in enumerate(maturity_grid):
            market_row = np.asarray(market_matrix[maturity_index], dtype=float)
            valid_mask = np.isfinite(market_row) & np.isfinite(strike_grid) & (market_row > 0.0) & (strike_grid > 0.0)
            strikes = strike_grid[valid_mask]
            market_ivs = market_row[valid_mask]
            expiry_label = (
                market_surface.expiry_list[maturity_index].isoformat()
                if maturity_index < len(market_surface.expiry_list)
                else f"T{maturity_index + 1}"
            )
            forward = float(spot * np.exp((rate - dividend_yield) * float(maturity)))

            if strikes.size < 3:
                atm_iv = float(np.nanmedian(market_row[np.isfinite(market_row) & (market_row > 0.0)])) if np.any(np.isfinite(market_row) & (market_row > 0.0)) else 0.2
                fallback = SABRParameters(
                    alpha=max(atm_iv * max(forward, 1.0) ** (1.0 - self._beta), 1e-4),
                    beta=self._beta,
                    rho=-0.2,
                    nu=0.5,
                )
                model_matrix[maturity_index, :] = self.implied_vols(forward, strike_grid, float(maturity), fallback)
                rmse = float(np.sqrt(np.mean((model_matrix[maturity_index, valid_mask] - market_ivs) ** 2))) if strikes.size else 0.0
                fits.append(
                    SABRSmileCalibration(
                        expiry_label=expiry_label,
                        maturity=float(maturity),
                        parameters=fallback,
                        rmse=rmse,
                        iterations=0,
                        converged=False,
                        point_count=int(strikes.size),
                    )
                )
                total_squared_error += rmse * rmse * max(int(strikes.size), 1)
                total_points += max(int(strikes.size), 1)
                continue

            atm_index = int(np.argmin(np.abs(strikes - forward)))
            atm_iv = float(np.clip(market_ivs[atm_index], 0.01, 3.0))
            alpha0 = max(atm_iv * max(forward, 1.0) ** (1.0 - self._beta), 1e-4)
            x0 = np.array([alpha0, -0.2, 0.6], dtype=float)
            lower = np.array([1e-4, -0.999, 1e-4], dtype=float)
            upper = np.array([5.0, 0.999, 5.0], dtype=float)

            def residuals(vector: np.ndarray) -> np.ndarray:
                params = SABRParameters(
                    alpha=float(vector[0]),
                    beta=self._beta,
                    rho=float(vector[1]),
                    nu=float(vector[2]),
                )
                model_ivs = self.implied_vols(forward, strikes, float(maturity), params)
                return model_ivs - market_ivs

            try:
                result = least_squares(
                    residuals,
                    x0=x0,
                    bounds=(lower, upper),
                    method="trf",
                    max_nfev=250,
                    ftol=1e-9,
                    xtol=1e-9,
                    gtol=1e-9,
                )
                fit_params = SABRParameters(
                    alpha=float(result.x[0]),
                    beta=self._beta,
                    rho=float(result.x[1]),
                    nu=float(result.x[2]),
                )
                converged = bool(result.success)
                iterations = int(getattr(result, "nfev", 0))
            except Exception as exc:
                self._logger.warning("SABR_FIT_FAILED | expiry=%s | error=%s", expiry_label, exc)
                fit_params = SABRParameters(alpha=float(x0[0]), beta=self._beta, rho=float(x0[1]), nu=float(x0[2]))
                converged = False
                iterations = 0

            full_row = self.implied_vols(forward, strike_grid, float(maturity), fit_params)
            model_matrix[maturity_index, :] = full_row
            fitted_valid = full_row[valid_mask]
            rmse = float(np.sqrt(np.mean((fitted_valid - market_ivs) ** 2))) if fitted_valid.size else 0.0
            fits.append(
                SABRSmileCalibration(
                    expiry_label=expiry_label,
                    maturity=float(maturity),
                    parameters=fit_params,
                    rmse=rmse,
                    iterations=iterations,
                    converged=converged,
                    point_count=int(strikes.size),
                )
            )
            total_squared_error += rmse * rmse * max(int(strikes.size), 1)
            total_points += max(int(strikes.size), 1)

        weights = np.asarray([max(fit.point_count, 1) for fit in fits], dtype=float)
        if weights.size and np.sum(weights) > 0:
            alpha = float(np.average([fit.parameters.alpha for fit in fits], weights=weights))
            rho = float(np.average([fit.parameters.rho for fit in fits], weights=weights))
            nu = float(np.average([fit.parameters.nu for fit in fits], weights=weights))
        else:
            alpha, rho, nu = 0.2, -0.2, 0.6

        weighted_rmse = float(np.sqrt(total_squared_error / max(total_points, 1)))
        iterations = int(sum(fit.iterations for fit in fits))
        converged_ratio = float(np.mean([1.0 if fit.converged else 0.0 for fit in fits])) if fits else 0.0
        summary = SABRParameters(alpha=alpha, beta=self._beta, rho=rho, nu=nu)

        self._logger.info(
            "SABR_SURFACE | expiries=%d | weighted_rmse=%.6f | converged_ratio=%.2f",
            len(fits),
            weighted_rmse,
            converged_ratio,
        )

        return SABRSurfaceCalibrationResult(
            parameters=summary,
            weighted_rmse=weighted_rmse,
            iterations=iterations,
            converged=bool(converged_ratio >= 0.6),
            expiry_fits=fits,
            model_iv_matrix=model_matrix,
        )
