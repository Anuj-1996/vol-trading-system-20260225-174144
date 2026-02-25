from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from ..calibration.joint_calibrator import JointHestonCalibrator
from ..calibration.heston_fft import HestonFFTPricer
from ..config import CONFIG
from ..data.ingestion import OptionChainIngestionService
from ..data.repository import OptionChainRepository
from ..evaluation.fragility_engine import FragilityEngine
from ..evaluation.ranking_engine import RankedStrategy, RankingEngine
from ..evaluation.static_evaluator import StaticEvaluationEngine
from ..logger import get_logger
from ..regime.regime_classifier import RegimeClassifier
from ..simulation.dynamic_hedge import DynamicHedgingEngine, HedgeMode
from ..simulation.heston_mc import HestonMonteCarloEngine
from ..strategy.base_strategy import StrategyConstraints, StrategyObject
from ..strategy.strategy_factory import StrategyFactory
from ..surface.builder import SurfaceBuilder
from ..surface.liquidity_filter import LiquidityFilterEngine


@dataclass(frozen=True)
class PipelineRequest:
    file_path: str
    db_path: str
    spot: float
    risk_free_rate: float
    dividend_yield: float
    capital_limit: float
    strike_increment: int
    max_legs: int
    max_width: float
    simulation_paths: int
    simulation_steps: int


class StrategyEngineService:
    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._ingestion = OptionChainIngestionService()
        self._surface_builder = SurfaceBuilder()
        self._liquidity_filter = LiquidityFilterEngine()
        self._calibrator = JointHestonCalibrator()
        self._pricer = HestonFFTPricer()
        self._monte_carlo = HestonMonteCarloEngine()
        self._strategy_factory = StrategyFactory()
        self._static_eval = StaticEvaluationEngine()
        self._fragility = FragilityEngine()
        self._ranking = RankingEngine()
        self._regime = RegimeClassifier()
        self._dynamic_hedge = DynamicHedgingEngine()

    def _map_underlying_to_ticker(self, file_path: str) -> str:
        file_upper = Path(file_path).name.upper()
        if "NIFTY" in file_upper:
            return "^NSEI"
        if "BANKNIFTY" in file_upper:
            return "^NSEBANK"
        return "^NSEI"

    def _fetch_market_history_metrics(self, file_path: str, atm_market_iv: float) -> Dict[str, Any]:
        ticker = self._map_underlying_to_ticker(file_path)
        try:
            import yfinance as yf

            history = yf.download(
                ticker,
                period="18mo",
                interval="1d",
                auto_adjust=False,
                progress=False,
                threads=False,
            )
        except Exception as exc:
            self._logger.warning("YFINANCE_FETCH_ERROR | ticker=%s | error=%s", ticker, exc)
            return {
                "ticker": ticker,
                "price_history": None,
                "rv_10d": None,
                "rv_20d": None,
                "rv_60d": None,
                "rv_percentile": None,
                "iv_rank": None,
                "iv_percentile": None,
                "vvix_equivalent": None,
            }

        if history is None or history.empty:
            self._logger.warning("YFINANCE_EMPTY | ticker=%s", ticker)
            return {
                "ticker": ticker,
                "price_history": None,
                "rv_10d": None,
                "rv_20d": None,
                "rv_60d": None,
                "rv_percentile": None,
                "iv_rank": None,
                "iv_percentile": None,
                "vvix_equivalent": None,
            }

        frame = history.copy()
        if isinstance(frame.columns, pd.MultiIndex):
            frame.columns = [col[0] for col in frame.columns]

        required = ["Open", "High", "Low", "Close"]
        for column in required:
            if column not in frame.columns:
                self._logger.warning("YFINANCE_MISSING_COL | ticker=%s | column=%s", ticker, column)
                return {
                    "ticker": ticker,
                    "price_history": None,
                    "rv_10d": None,
                    "rv_20d": None,
                    "rv_60d": None,
                    "rv_percentile": None,
                    "iv_rank": None,
                    "iv_percentile": None,
                    "vvix_equivalent": None,
                }

        close = frame["Close"].astype(float)
        log_returns = np.log(close / close.shift(1)).dropna()
        annualizer = np.sqrt(252.0)

        def trailing_realized(window: int) -> float | None:
            if log_returns.size < window:
                return None
            return float(log_returns.tail(window).std(ddof=1) * annualizer)

        rv_10d = trailing_realized(10)
        rv_20d = trailing_realized(20)
        rv_60d = trailing_realized(60)

        rv20_series = log_returns.rolling(20).std(ddof=1).dropna() * annualizer
        if rv20_series.empty:
            rv_percentile = None
            iv_rank = None
            iv_percentile = None
            vvix_equivalent = None
        else:
            rv_min = float(rv20_series.min())
            rv_max = float(rv20_series.max())
            current_rv = float(rv20_series.iloc[-1])
            rv_percentile = float((rv20_series <= current_rv).mean() * 100.0)

            if rv_max - rv_min > 1e-9:
                iv_rank = float(np.clip((atm_market_iv - rv_min) / (rv_max - rv_min), 0.0, 1.0) * 100.0)
            else:
                iv_rank = 50.0

            iv_percentile = float((rv20_series <= atm_market_iv).mean() * 100.0)
            vvix_equivalent = float(rv20_series.diff().dropna().std(ddof=1) * annualizer)

        recent = frame.tail(180)
        history_payload = {
            "dates": [index.strftime("%Y-%m-%d") for index in recent.index],
            "open": [float(value) for value in recent["Open"].astype(float)],
            "high": [float(value) for value in recent["High"].astype(float)],
            "low": [float(value) for value in recent["Low"].astype(float)],
            "close": [float(value) for value in recent["Close"].astype(float)],
            "volume": [float(value) for value in recent["Volume"].fillna(0.0).astype(float)]
            if "Volume" in recent.columns
            else [],
            "rv20_annualized": [
                float(value) if not np.isnan(value) else None
                for value in (log_returns.rolling(20).std(ddof=1) * annualizer).reindex(recent.index)
            ],
            "rv60_annualized": [
                float(value) if not np.isnan(value) else None
                for value in (log_returns.rolling(60).std(ddof=1) * annualizer).reindex(recent.index)
            ],
        }

        self._logger.info(
            "YFINANCE_METRICS | ticker=%s | points=%d | rv20=%s | iv_rank=%s | iv_percentile=%s",
            ticker,
            len(history_payload["dates"]),
            f"{rv_20d:.6f}" if rv_20d is not None else "None",
            f"{iv_rank:.2f}" if iv_rank is not None else "None",
            f"{iv_percentile:.2f}" if iv_percentile is not None else "None",
        )

        return {
            "ticker": ticker,
            "price_history": history_payload,
            "rv_10d": rv_10d,
            "rv_20d": rv_20d,
            "rv_60d": rv_60d,
            "rv_percentile": rv_percentile,
            "iv_rank": iv_rank,
            "iv_percentile": iv_percentile,
            "vvix_equivalent": vvix_equivalent,
        }

    def _resolve_input_paths(self, file_path: str) -> List[Path]:
        candidate = Path(file_path)
        if candidate.exists():
            self._logger.info("INPUT_PATH | direct=%s", candidate)
            return [candidate]

        data_candidate = CONFIG.data.data_root / candidate
        if data_candidate.exists():
            self._logger.info("INPUT_PATH | data_root=%s", data_candidate)
            return [data_candidate]

        latest_candidates = sorted(
            CONFIG.data.data_root.glob(CONFIG.data.file_pattern),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        if latest_candidates:
            self._logger.warning(
                "INPUT_PATH_FALLBACK_MULTI | requested=%s | files=%d | newest=%s",
                file_path,
                len(latest_candidates),
                latest_candidates[0],
            )
            ordered = sorted(latest_candidates, key=lambda item: item.name)
            return ordered

        raise FileNotFoundError(f"Input file not found: {file_path}")

    def _generate_strategies(self, constraints: StrategyConstraints, strike_set: List[float]) -> List[StrategyObject]:
        strategies: List[StrategyObject] = []
        for key in self._strategy_factory.supported():
            strategy = self._strategy_factory.create(key, constraints=constraints)
            generated = strategy.generate_valid_combinations(strike_set=strike_set)
            strategies.extend(generated)
        return strategies

    def _select_candidate_strikes(self, strikes: List[float], spot: float) -> List[float]:
        if not strikes:
            return []

        max_candidates = CONFIG.strategy.max_candidate_strikes
        ordered = sorted(strikes, key=lambda strike: abs(strike - spot))
        selected = sorted(ordered[:max_candidates])
        self._logger.info(
            "STRIKE_SELECTION | original=%d | selected=%d | spot=%.2f",
            len(strikes),
            len(selected),
            spot,
        )
        return selected

    def _build_model_surface_matrix(
        self,
        spot: float,
        rate: float,
        dividend_yield: float,
        maturity_grid: np.ndarray,
        strike_grid: np.ndarray,
        params: Any,
    ) -> np.ndarray:
        model_matrix = np.zeros((maturity_grid.size, strike_grid.size), dtype=float)
        for maturity_index, maturity in enumerate(maturity_grid):
            prices = self._pricer.price_calls_fft(
                spot=spot,
                maturity=float(maturity),
                rate=rate,
                dividend_yield=dividend_yield,
                params=params,
                strikes=strike_grid,
            )
            model_ivs = self._pricer.implied_vol_from_call_prices(
                call_prices=prices,
                spot=spot,
                strikes=strike_grid,
                maturity=float(maturity),
                rate=rate,
                dividend_yield=dividend_yield,
            )
            model_matrix[maturity_index, :] = model_ivs

            sample_count = min(5, strike_grid.size)
            self._logger.info(
                "SURFACE_TRACE | maturity=%.6f | prices_first5=%s | ivs_first5=%s",
                float(maturity),
                np.array2string(prices[:sample_count], precision=6, separator=", "),
                np.array2string(model_ivs[:sample_count], precision=6, separator=", "),
            )

            iv_span = float(np.nanmax(model_ivs) - np.nanmin(model_ivs))
            if iv_span < 1e-4:
                self._logger.warning(
                    "SURFACE_IV_NEARLY_IDENTICAL | maturity=%.6f | iv_span=%.8f | params=%s",
                    float(maturity),
                    iv_span,
                    params,
                )

        if model_matrix.ndim != 2:
            raise ValueError(f"Model IV surface must be 2D, got shape {model_matrix.shape}")

        self._logger.info(
            "SURFACE_SHAPE | maturities=%d | strikes=%d | matrix_shape=%s",
            maturity_grid.size,
            strike_grid.size,
            model_matrix.shape,
        )
        return model_matrix

    def run_static_pipeline(self, request: PipelineRequest) -> Dict[str, Any]:
        self._logger.info("START | run_static_pipeline | file=%s", request.file_path)

        repository = OptionChainRepository(db_path=Path(request.db_path))
        repository.ensure_schema()

        source_files = self._resolve_input_paths(request.file_path)
        raw_records = []
        for source_file in source_files:
            parsed = self._ingestion.parse_file(file_path=source_file)
            raw_records.extend(parsed)
        self._logger.info("INGEST_COMBINED | files=%d | records=%d", len(source_files), len(raw_records))
        repository.upsert_raw_records(raw_records)

        filtered = self._liquidity_filter.filter_records(records=raw_records, spot=request.spot)
        surface = self._surface_builder.build_surface(records=filtered)

        calibration_result = self._calibrator.calibrate(
            market_surface=surface,
            filtered_records=filtered,
            spot=request.spot,
            rate=request.risk_free_rate,
            dividend_yield=request.dividend_yield,
        )

        maturity = float(np.max(surface.maturity_grid))
        simulation_result = self._monte_carlo.simulate(
            params=calibration_result.parameters,
            spot=request.spot,
            maturity=maturity,
            risk_free_rate=request.risk_free_rate,
            path_count=request.simulation_paths,
            time_steps=request.simulation_steps,
            full_path=False,
        )

        constraints = StrategyConstraints(
            capital_limit=request.capital_limit,
            strike_increment=request.strike_increment,
            max_legs=request.max_legs,
            max_width=request.max_width,
            max_combinations_per_strategy=CONFIG.strategy.max_combinations_per_strategy,
        )
        strike_set = self._select_candidate_strikes(
            strikes=sorted({item.strike for item in filtered}),
            spot=request.spot,
        )
        strategies = self._generate_strategies(constraints=constraints, strike_set=strike_set)

        metrics, pnl_distributions = self._static_eval.evaluate(
            strategies=strategies,
            terminal_prices=simulation_result.terminal_prices,
            spot=request.spot,
        )

        fragility_scores: Dict[str, float] = {}
        for metric in metrics:
            key = f"{metric.strategy_type}:{metric.strikes}"
            fragility_input = pnl_distributions.get(key, np.array([], dtype=float))
            fragility_scores[key] = self._fragility.compute_fragility(fragility_input)

        returns_proxy = np.diff(np.log(np.sort(simulation_result.terminal_prices)))
        regime = self._regime.classify(returns_proxy)
        ranked: List[RankedStrategy] = self._ranking.rank(
            metrics=metrics,
            fragility_scores=fragility_scores,
            regime_weights=regime.ranking_weights,
        )

        model_iv_matrix = self._build_model_surface_matrix(
            spot=request.spot,
            rate=request.risk_free_rate,
            dividend_yield=request.dividend_yield,
            maturity_grid=surface.maturity_grid,
            strike_grid=surface.strike_grid,
            params=calibration_result.parameters,
        )
        residual_iv_matrix = model_iv_matrix - surface.implied_vol_matrix
        model_iv_min = float(np.nanmin(model_iv_matrix))
        model_iv_max = float(np.nanmax(model_iv_matrix))
        model_skew = np.gradient(model_iv_matrix, surface.strike_grid, axis=1)
        skew_slope = float(np.nanmean(model_skew))
        surface_rmse = float(np.sqrt(np.mean((model_iv_matrix - surface.implied_vol_matrix) ** 2)))

        self._logger.info(
            "MODEL_IV_STATS | min=%.6f | max=%.6f | skew_slope=%.8f | rmse_vs_market=%.6f",
            model_iv_min,
            model_iv_max,
            skew_slope,
            surface_rmse,
        )

        atm_index = int(np.argmin(np.abs(surface.strike_grid - request.spot)))
        near_index = int(np.argmin(surface.maturity_grid))
        atm_market_iv = float(surface.implied_vol_matrix[near_index, atm_index])
        atm_model_iv = float(model_iv_matrix[near_index, atm_index])
        history_metrics = self._fetch_market_history_metrics(request.file_path, atm_market_iv)
        rv_reference = history_metrics["rv_20d"] if history_metrics["rv_20d"] is not None else atm_model_iv
        realized_implied_spread = float(atm_market_iv - rv_reference)
        strategy_margin_lookup = {
            (strategy.strategy_type, strategy.strikes): float(strategy.margin)
            for strategy in strategies
        }

        response = {
            "ingestion": self._ingestion.build_ingestion_report(raw_records),
            "market_overview": {
                "spot": request.spot,
                "atm_market_iv": atm_market_iv,
                "atm_model_iv": atm_model_iv,
                "realized_implied_spread": realized_implied_spread,
                "ticker": history_metrics["ticker"],
                "rv_10d": history_metrics["rv_10d"],
                "rv_20d": history_metrics["rv_20d"],
                "rv_60d": history_metrics["rv_60d"],
                "rv_percentile": history_metrics["rv_percentile"],
                "iv_rank": history_metrics["iv_rank"],
                "iv_percentile": history_metrics["iv_percentile"],
                "vvix_equivalent": history_metrics["vvix_equivalent"],
                "price_history": history_metrics["price_history"],
            },
            "surface": {
                "strike_grid": surface.strike_grid.tolist(),
                "maturity_grid": surface.maturity_grid.tolist(),
                "market_iv_matrix": surface.implied_vol_matrix.tolist(),
                "model_iv_matrix": model_iv_matrix.tolist(),
                "residual_iv_matrix": residual_iv_matrix.tolist(),
            },
            "calibration": {
                "parameters": asdict(calibration_result.parameters),
                "weighted_rmse": calibration_result.metrics.weighted_rmse,
                "iterations": calibration_result.iterations,
                "converged": calibration_result.converged,
            },
            "regime": {"label": regime.label, "confidence": regime.confidence},
            "top_strategies": [
                {
                    "strategy_type": item.metrics.strategy_type,
                    "strikes": item.metrics.strikes,
                    "overall_score": item.overall_score,
                    "cost": strategy_margin_lookup.get((item.metrics.strategy_type, item.metrics.strikes), 0.0),
                    "margin_required": strategy_margin_lookup.get((item.metrics.strategy_type, item.metrics.strikes), 0.0),
                    "expected_value": item.metrics.expected_value,
                    "var_95": item.metrics.var_95,
                    "var_99": item.metrics.var_99,
                    "expected_shortfall": item.metrics.expected_shortfall,
                    "return_on_margin": item.metrics.return_on_margin,
                    "probability_of_loss": item.metrics.probability_of_loss,
                    "pnl_kurtosis": item.metrics.pnl_kurtosis,
                    "max_loss": item.metrics.max_loss,
                    "delta_exposure": item.metrics.delta_exposure,
                    "gamma_exposure": item.metrics.gamma_exposure,
                    "vega_exposure": item.metrics.vega_exposure,
                    "theta_exposure": item.metrics.theta_exposure,
                    "skew_exposure": item.metrics.skew_exposure,
                    "break_even_levels": list(item.metrics.strikes),
                    "pnl_distribution": pnl_distributions.get(
                        f"{item.metrics.strategy_type}:{item.metrics.strikes}",
                        np.array([], dtype=float),
                    )[:1200].tolist(),
                    "fragility_score": item.fragility_score,
                }
                for item in ranked
            ],
        }
        self._logger.info("END | run_static_pipeline")
        return response

    def run_dynamic_hedge(self, request: PipelineRequest, hedge_mode: HedgeMode, transaction_cost_rate: float) -> Dict[str, Any]:
        self._logger.info("START | run_dynamic_hedge | file=%s", request.file_path)
        source_files = self._resolve_input_paths(request.file_path)
        raw_records = []
        for source_file in source_files:
            parsed = self._ingestion.parse_file(file_path=source_file)
            raw_records.extend(parsed)
        self._logger.info("INGEST_COMBINED | files=%d | records=%d", len(source_files), len(raw_records))
        filtered = self._liquidity_filter.filter_records(records=raw_records, spot=request.spot)
        surface = self._surface_builder.build_surface(records=filtered)

        calibration_result = self._calibrator.calibrate(
            market_surface=surface,
            filtered_records=filtered,
            spot=request.spot,
            rate=request.risk_free_rate,
            dividend_yield=request.dividend_yield,
        )

        simulation_result = self._monte_carlo.simulate(
            params=calibration_result.parameters,
            spot=request.spot,
            maturity=float(np.max(surface.maturity_grid)),
            risk_free_rate=request.risk_free_rate,
            path_count=request.simulation_paths,
            time_steps=request.simulation_steps,
            full_path=True,
        )

        if simulation_result.full_price_paths is None:
            raise ValueError("Dynamic hedging requires full path simulation")

        strike = float(np.median(surface.strike_grid))
        premium = float(np.mean(simulation_result.terminal_prices) * 0.02)
        dynamic = self._dynamic_hedge.evaluate(
            full_price_paths=simulation_result.full_price_paths,
            strike=strike,
            premium=premium,
            hedge_mode=hedge_mode,
            transaction_cost_rate=transaction_cost_rate,
        )

        self._logger.info("END | run_dynamic_hedge")
        return {
            "mean_pnl": float(np.mean(dynamic.pnl)),
            "var_99": float(np.percentile(dynamic.pnl, 1)),
            "expected_shortfall": float(np.mean(dynamic.pnl[dynamic.pnl <= np.percentile(dynamic.pnl, 1)])),
            "average_adjustments": dynamic.average_adjustments,
        }
