from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from ..calibration.joint_calibrator import JointHestonCalibrator
from ..calibration.heston_fft import HestonFFTPricer
from ..config import CONFIG
from ..data.ingestion import OptionChainIngestionService
from ..data.models import OptionChainRawRecord
from ..data.nse_client import NSEClient
from ..data.nse_cleaner import NSEDataCleaner
from ..data.nse_fetcher import FetchResult, NSEOptionChainFetcher
from ..data.repository import OptionChainRepository
from ..evaluation.fragility_engine import FragilityEngine
from ..evaluation.ranking_engine import RankedStrategy, RankingEngine
from ..evaluation.static_evaluator import StaticEvaluationEngine
from ..logger import get_logger
from ..regime.regime_classifier import RegimeClassifier
from ..simulation.dynamic_hedge import DynamicHedgingEngine, HedgeMode
from ..simulation.heston_mc import HestonMonteCarloEngine
from ..strategy.base_strategy import StrategyConstraints, StrategyObject, build_legs
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


@dataclass(frozen=True)
class LivePipelineRequest:
    """Request for running the pipeline on live NSE data (no file_path / spot needed)."""
    data_id: str
    db_path: str = "backend/vol_engine.db"
    risk_free_rate: float = 0.065
    dividend_yield: float = 0.012
    capital_limit: float = 500000
    strike_increment: int = 50
    max_legs: int = 4
    max_width: float = 1000
    simulation_paths: int = 5000
    simulation_steps: int = 32


# In-memory cache for fetched NSE data (data_id -> FetchResult + cleaned records)
_live_data_cache: Dict[str, Dict[str, Any]] = {}
_cache_lock = threading.Lock()


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
        self._nse_client = NSEClient()
        self._nse_fetcher = NSEOptionChainFetcher(client=self._nse_client)
        self._nse_cleaner = NSEDataCleaner()

    # ------------------------------------------------------------------
    # NSE Live Data: Fetch + Cache
    # ------------------------------------------------------------------

    def fetch_nse_live_data(
        self,
        symbol: str = "NIFTY",
        expiries: Optional[List[str]] = None,
        max_expiries: int = 5,
    ) -> Dict[str, Any]:
        """
        Fetch live data from NSE, clean it, cache it, and return summary.

        Parameters
        ----------
        symbol : str
            Index symbol ("NIFTY" or "BANKNIFTY")
        expiries : list[str] or None
            If None or ["all"], fetches all future expiries.
            Otherwise fetches only the specified expiry strings.

        Returns
        -------
        dict with: data_id, spot, timestamp, expiry_dates, record_count,
                   quality_report, symbol
        """
        self._logger.info("FETCH_NSE_LIVE | symbol=%s | expiries=%s", symbol, expiries)

        if expiries is None or expiries == ["all"] or not expiries:
            fetch_result = self._nse_fetcher.fetch_all_expiries(
                symbol=symbol, max_expiries=max_expiries,
            )
        else:
            # Fetch single expiry
            fetch_result = self._nse_fetcher.fetch_single_expiry(
                symbol=symbol,
                expiry_date=expiries[0],
            )

        # Clean the data
        clean_result = self._nse_cleaner.clean(
            records=fetch_result.records,
            spot=fetch_result.spot,
        )

        # Generate cache key
        import time
        data_id = f"nse_{symbol.lower()}_{int(time.time())}"

        # Cache for pipeline use
        with _cache_lock:
            _live_data_cache[data_id] = {
                "fetch_result": fetch_result,
                "cleaned_records": clean_result.cleaned_records,
                "quality_report": clean_result.quality_report,
                "spot": fetch_result.spot,
                "symbol": symbol,
            }

        self._logger.info(
            "FETCH_NSE_LIVE | CACHED | data_id=%s | records=%d | spot=%.2f",
            data_id,
            len(clean_result.cleaned_records),
            fetch_result.spot,
        )

        return {
            "data_id": data_id,
            "spot": fetch_result.spot,
            "timestamp": fetch_result.timestamp,
            "expiry_dates": fetch_result.expiry_dates,
            "record_count": len(clean_result.cleaned_records),
            "raw_entry_count": fetch_result.raw_entry_count,
            "quality_report": clean_result.quality_report,
            "symbol": symbol,
        }

    def get_cached_nse_data(self, data_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve cached NSE data by data_id. Returns None if not found."""
        with _cache_lock:
            return _live_data_cache.get(data_id)

    # ------------------------------------------------------------------
    # Live Pipeline: Run analysis on cached NSE data
    # ------------------------------------------------------------------

    def run_live_pipeline(self, request: LivePipelineRequest) -> Dict[str, Any]:
        """
        Run the full static pipeline on cached live NSE data.

        This is identical to run_static_pipeline but uses pre-fetched
        NSE data instead of a CSV file. Spot comes from the NSE feed.
        """
        self._logger.info("START | run_live_pipeline | data_id=%s", request.data_id)

        cached = self.get_cached_nse_data(request.data_id)
        if cached is None:
            raise ValueError(
                f"No cached NSE data for data_id={request.data_id}. "
                "Fetch data first via /api/v1/data/fetch-live."
            )

        raw_records: List[OptionChainRawRecord] = cached["cleaned_records"]
        spot: float = cached["spot"]
        symbol: str = cached.get("symbol", "NIFTY")

        if not raw_records:
            raise ValueError("Cached NSE data contains no records after cleaning.")

        self._logger.info(
            "LIVE_PIPELINE | data_id=%s | records=%d | spot=%.2f",
            request.data_id,
            len(raw_records),
            spot,
        )

        # Upsert into SQLite (same as CSV path)
        repository = OptionChainRepository(db_path=Path(request.db_path))
        repository.ensure_schema()
        repository.upsert_raw_records(raw_records)

        # From here: IDENTICAL to run_static_pipeline
        filtered = self._liquidity_filter.filter_records(records=raw_records, spot=spot)
        surface = self._surface_builder.build_surface(records=filtered)

        calibration_result = self._calibrator.calibrate(
            market_surface=surface,
            filtered_records=filtered,
            spot=spot,
            rate=request.risk_free_rate,
            dividend_yield=request.dividend_yield,
        )

        maturity = float(np.max(surface.maturity_grid))
        simulation_result = self._monte_carlo.simulate(
            params=calibration_result.parameters,
            spot=spot,
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
            spot=spot,
        )
        strategies = self._generate_strategies(constraints=constraints, strike_set=strike_set)

        # Build model IV surface BEFORE evaluate so we can price legs with BS
        near_T = float(np.min(surface.maturity_grid))
        _near_idx = int(np.argmin(surface.maturity_grid))
        near_expiry_date = surface.expiry_list[_near_idx].isoformat() if _near_idx < len(surface.expiry_list) else None
        model_iv_for_pricing = self._build_model_surface_matrix(
            spot=spot,
            rate=request.risk_free_rate,
            dividend_yield=request.dividend_yield,
            maturity_grid=surface.maturity_grid,
            strike_grid=surface.strike_grid,
            params=calibration_result.parameters,
        )
        _strike_arr = surface.strike_grid
        _iv_row = model_iv_for_pricing[_near_idx]

        def iv_lookup(strike: float, option_type: str) -> float:
            idx = int(np.argmin(np.abs(_strike_arr - strike)))
            iv = float(_iv_row[idx])
            return max(iv, 0.01)

        market_mid = self._build_market_mid(filtered)
        market_bid_ask = self._build_market_bid_ask(filtered)

        metrics, pnl_distributions = self._static_eval.evaluate(
            strategies=strategies,
            terminal_prices=simulation_result.terminal_prices,
            spot=spot,
            T=near_T,
            r=request.risk_free_rate,
            iv_lookup=iv_lookup,
            market_mid=market_mid,
            market_bid_ask=market_bid_ask,
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

        model_iv_matrix = model_iv_for_pricing  # reuse – already computed above
        residual_iv_matrix = model_iv_matrix - surface.implied_vol_matrix
        oi_profile = self._build_open_interest_profile(
            filtered_records=filtered,
            expiry_list=surface.expiry_list,
            strike_grid=surface.strike_grid,
        )

        atm_index = int(np.argmin(np.abs(surface.strike_grid - spot)))
        # Pick the nearest maturity that has a non-zero market IV at ATM
        maturity_order = np.argsort(surface.maturity_grid)
        atm_market_iv = 0.0
        chosen_near_index = int(maturity_order[0])
        for mi in maturity_order:
            iv_val = float(surface.implied_vol_matrix[int(mi), atm_index])
            if iv_val > 1e-6:
                atm_market_iv = iv_val
                chosen_near_index = int(mi)
                break
        atm_model_iv = float(model_iv_matrix[chosen_near_index, atm_index])
        # Fallback: if still zero, use the model IV
        if atm_market_iv < 1e-6:
            atm_market_iv = atm_model_iv

        # Compute skew slope (25-delta put IV minus 25-delta call IV proxy)
        num_strikes = len(surface.strike_grid)
        otm_put_idx = max(0, atm_index - max(1, num_strikes // 8))
        otm_call_idx = min(num_strikes - 1, atm_index + max(1, num_strikes // 8))
        put_wing_iv = float(surface.implied_vol_matrix[chosen_near_index, otm_put_idx])
        call_wing_iv = float(surface.implied_vol_matrix[chosen_near_index, otm_call_idx])
        skew_slope = put_wing_iv - call_wing_iv  # positive = put-skew (normal)

        # Use symbol to determine yfinance ticker — pass symbol to _fetch_market_history_metrics
        # which will map it via _map_underlying_to_ticker (checks for NIFTY/BANKNIFTY in string)
        history_metrics = self._fetch_market_history_metrics(symbol, atm_market_iv)
        rv_reference = history_metrics["rv_20d"] if history_metrics["rv_20d"] is not None else atm_model_iv
        realized_implied_spread = float(atm_market_iv - rv_reference)
        strategy_margin_lookup = {
            (strategy.strategy_type, strategy.strikes): float(strategy.margin)
            for strategy in strategies
        }

        response = {
            "ingestion": self._ingestion.build_ingestion_report(raw_records),
            "market_overview": {
                "spot": spot,
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
                "data_source": "nse_live",
                "nse_timestamp": cached["fetch_result"].timestamp,
            },
            "surface": {
                "strike_grid": surface.strike_grid.tolist(),
                "maturity_grid": surface.maturity_grid.tolist(),
                "market_iv_matrix": surface.implied_vol_matrix.tolist(),
                "model_iv_matrix": model_iv_matrix.tolist(),
                "residual_iv_matrix": residual_iv_matrix.tolist(),
                "expiry_labels": oi_profile["expiry_labels"],
                "open_interest_matrix": oi_profile["open_interest_matrix"],
                "max_pain_by_expiry": oi_profile["max_pain_by_expiry"],
            },
            "calibration": {
                "parameters": asdict(calibration_result.parameters),
                "weighted_rmse": calibration_result.metrics.weighted_rmse,
                "iterations": calibration_result.iterations,
                "converged": calibration_result.converged,
            },
            "regime": {
                "label": regime.label,
                "confidence": regime.confidence,
                "volatility_regime_score": round(atm_market_iv / max(rv_reference, 1e-8), 4),
                "skew_regime_score": round(skew_slope, 6),
            },
            "top_strategies": self._build_top_strategies(ranked, pnl_distributions, simulation_result.terminal_prices, spot, near_expiry_date, near_T, strategy_margin_lookup, market_mid, market_bid_ask),
        }
        self._logger.info("END | run_live_pipeline")
        return response

    @staticmethod
    def _build_market_mid(filtered: List) -> Dict[tuple, float]:
        """Build market mid-price lookup: (strike, 'C'|'P') -> mid price in points."""
        _side_map = {"CALL": "C", "PUT": "P"}
        market_mid: Dict[tuple, float] = {}
        for rec in filtered:
            otype = _side_map.get(rec.side, rec.side)
            key = (rec.strike, otype)
            if rec.mid and rec.mid > 0:
                market_mid[key] = rec.mid
        return market_mid

    @staticmethod
    def _build_market_bid_ask(filtered: List) -> Dict[tuple, tuple]:
        """Build market bid/ask lookup: (strike, 'C'|'P') -> (bid, ask) in points."""
        _side_map = {"CALL": "C", "PUT": "P"}
        market_ba: Dict[tuple, tuple] = {}
        for rec in filtered:
            otype = _side_map.get(rec.side, rec.side)
            key = (rec.strike, otype)
            bid = getattr(rec, 'bid', 0.0) or 0.0
            ask = getattr(rec, 'ask', 0.0) or 0.0
            if bid > 0 or ask > 0:
                market_ba[key] = (bid, ask)
        return market_ba

    def _build_top_strategies(
        self,
        ranked: List,
        pnl_distributions: Dict[str, np.ndarray],
        terminal_prices: np.ndarray,
        spot: float,
        near_expiry_date: Optional[str],
        near_T: float,
        strategy_margin_lookup: Dict,
        market_mid: Dict[tuple, float],
        market_bid_ask: Optional[Dict[tuple, tuple]] = None,
    ) -> List[Dict[str, Any]]:
        """Build the top_strategies response list with market mid-prices for each leg."""
        result = []
        for item in ranked:
            legs_list = []
            max_spread_pct = 0.0
            any_missing_ba = False
            for leg in build_legs(item.metrics.strategy_type, item.metrics.strikes):
                mkt_price = market_mid.get((leg.strike, leg.option_type))
                ba = (market_bid_ask or {}).get((leg.strike, leg.option_type))
                leg_bid = ba[0] if ba else None
                leg_ask = ba[1] if ba else None
                if ba and ba[0] > 0 and ba[1] > 0:
                    mid_val = (ba[0] + ba[1]) / 2.0
                    spread_pct = (ba[1] - ba[0]) / mid_val if mid_val > 0 else 0.0
                    max_spread_pct = max(max_spread_pct, spread_pct)
                else:
                    any_missing_ba = True
                legs_list.append({
                    "strike": leg.strike,
                    "option_type": leg.option_type,
                    "direction": leg.direction,
                    "ratio": leg.ratio,
                    "price": round(mkt_price, 2) if mkt_price else None,
                    "bid": round(leg_bid, 2) if leg_bid else None,
                    "ask": round(leg_ask, 2) if leg_ask else None,
                })
            # Liquidity warning: spread > 5% or missing bid/ask data
            liquidity_warning = any_missing_ba or max_spread_pct > 0.05
            result.append({
                "strategy_type": item.metrics.strategy_type,
                "strikes": item.metrics.strikes,
                "legs_label": item.metrics.legs_label,
                "net_premium": item.metrics.net_premium,
                "overall_score": item.overall_score,
                "cost": abs(item.metrics.net_premium),
                "margin_required": max(
                    abs(item.metrics.net_premium),
                    strategy_margin_lookup.get((item.metrics.strategy_type, item.metrics.strikes), 0.0),
                ),
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
                "expiry_date": near_expiry_date,
                "maturity_T": near_T,
                "break_even_levels": self._static_eval._compute_break_evens(
                    terminal_prices,
                    pnl_distributions.get(f"{item.metrics.strategy_type}:{item.metrics.strikes}", np.array([], dtype=float)),
                    spot,
                ),
                "pnl_distribution": pnl_distributions.get(
                    f"{item.metrics.strategy_type}:{item.metrics.strikes}",
                    np.array([], dtype=float),
                )[:1200].tolist(),
                "fragility_score": item.fragility_score,
                "legs": legs_list,
                "liquidity_warning": liquidity_warning,
                "bid_ask_spread_pct": round(max_spread_pct * 100, 2),
            })
        return result

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
        supported = self._strategy_factory.supported()

        def _gen_one(key: str) -> List[StrategyObject]:
            strategy = self._strategy_factory.create(key, constraints=constraints)
            return strategy.generate_valid_combinations(strike_set=strike_set)

        strategies: List[StrategyObject] = []
        if len(supported) > 1:
            with ThreadPoolExecutor(max_workers=min(len(supported), 8)) as pool:
                for batch in pool.map(_gen_one, supported):
                    strategies.extend(batch)
        else:
            for key in supported:
                strategies.extend(_gen_one(key))
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

        def _compute_row(maturity_index: int) -> tuple:
            maturity = float(maturity_grid[maturity_index])
            prices = self._pricer.price_calls_fft(
                spot=spot,
                maturity=maturity,
                rate=rate,
                dividend_yield=dividend_yield,
                params=params,
                strikes=strike_grid,
            )
            model_ivs = self._pricer.implied_vol_from_call_prices(
                call_prices=prices,
                spot=spot,
                strikes=strike_grid,
                maturity=maturity,
                rate=rate,
                dividend_yield=dividend_yield,
            )

            sample_count = min(5, strike_grid.size)
            self._logger.info(
                "SURFACE_TRACE | maturity=%.6f | prices_first5=%s | ivs_first5=%s",
                maturity,
                np.array2string(prices[:sample_count], precision=6, separator=", "),
                np.array2string(model_ivs[:sample_count], precision=6, separator=", "),
            )

            iv_span = float(np.nanmax(model_ivs) - np.nanmin(model_ivs))
            if iv_span < 1e-4:
                self._logger.warning(
                    "SURFACE_IV_NEARLY_IDENTICAL | maturity=%.6f | iv_span=%.8f | params=%s",
                    maturity,
                    iv_span,
                    params,
                )
            return maturity_index, model_ivs

        n_mat = maturity_grid.size
        if n_mat > 1:
            with ThreadPoolExecutor(max_workers=min(n_mat, 8)) as pool:
                for idx, ivs in pool.map(_compute_row, range(n_mat)):
                    model_matrix[idx, :] = ivs
        else:
            for i in range(n_mat):
                idx, ivs = _compute_row(i)
                model_matrix[idx, :] = ivs

        if model_matrix.ndim != 2:
            raise ValueError(f"Model IV surface must be 2D, got shape {model_matrix.shape}")

        self._logger.info(
            "SURFACE_SHAPE | maturities=%d | strikes=%d | matrix_shape=%s",
            maturity_grid.size,
            strike_grid.size,
            model_matrix.shape,
        )
        return model_matrix

    def _build_open_interest_profile(
        self,
        filtered_records: List[Any],
        expiry_list: Any,
        strike_grid: np.ndarray,
    ) -> Dict[str, Any]:
        expiry_labels = [item.isoformat() for item in expiry_list]
        strike_to_index = {float(strike): index for index, strike in enumerate(strike_grid.tolist())}
        expiry_to_index = {expiry: index for index, expiry in enumerate(expiry_list)}

        oi_matrix = np.zeros((len(expiry_list), strike_grid.size), dtype=float)

        for record in filtered_records:
            if getattr(record, "side", None) != "CALL":
                continue
            expiry_index = expiry_to_index.get(record.expiry)
            strike_index = strike_to_index.get(float(record.strike))
            if expiry_index is None or strike_index is None:
                continue
            oi_matrix[expiry_index, strike_index] += float(record.open_interest)

        max_pain_by_expiry: List[float] = []
        for expiry_index in range(oi_matrix.shape[0]):
            weights = oi_matrix[expiry_index, :]
            if np.sum(weights) <= 0:
                max_pain_by_expiry.append(float(strike_grid[int(np.argmin(np.abs(strike_grid - strike_grid.mean())))]))
                continue
            payout = np.array([
                float(np.sum(weights * np.abs(strike_grid - strike_candidate)))
                for strike_candidate in strike_grid
            ])
            pain_index = int(np.argmin(payout))
            max_pain_by_expiry.append(float(strike_grid[pain_index]))

        return {
            "expiry_labels": expiry_labels,
            "open_interest_matrix": oi_matrix.tolist(),
            "max_pain_by_expiry": max_pain_by_expiry,
        }

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

        # Build IV lookup from model surface (nearest maturity for strategy pricing)
        near_maturity_idx = int(np.argmin(surface.maturity_grid))
        near_T = max(float(surface.maturity_grid[near_maturity_idx]), 1e-6)
        near_expiry_date = surface.expiry_list[near_maturity_idx].isoformat() if near_maturity_idx < len(surface.expiry_list) else None
        model_iv_for_pricing = self._build_model_surface_matrix(
            spot=request.spot,
            rate=request.risk_free_rate,
            dividend_yield=request.dividend_yield,
            maturity_grid=surface.maturity_grid,
            strike_grid=surface.strike_grid,
            params=calibration_result.parameters,
        )
        near_iv_row = model_iv_for_pricing[near_maturity_idx, :]
        strike_grid_list = surface.strike_grid.tolist()

        def iv_lookup(strike: float, option_type: str) -> float:
            """Interpolate model IV for a given strike from the near-term smile."""
            idx = int(np.argmin(np.abs(surface.strike_grid - strike)))
            base_iv = float(near_iv_row[idx])
            # Put IV typically slightly higher than call (put skew)
            if option_type == 'P' and strike < request.spot:
                base_iv *= 1.02  # mild skew adjustment
            return max(base_iv, 0.01)

        market_mid = self._build_market_mid(filtered)
        market_bid_ask = self._build_market_bid_ask(filtered)

        metrics, pnl_distributions = self._static_eval.evaluate(
            strategies=strategies,
            terminal_prices=simulation_result.terminal_prices,
            spot=request.spot,
            T=near_T,
            r=request.risk_free_rate,
            iv_lookup=iv_lookup,
            market_mid=market_mid,
            market_bid_ask=market_bid_ask,
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

        model_iv_matrix = model_iv_for_pricing  # already computed above
        residual_iv_matrix = model_iv_matrix - surface.implied_vol_matrix
        oi_profile = self._build_open_interest_profile(
            filtered_records=filtered,
            expiry_list=surface.expiry_list,
            strike_grid=surface.strike_grid,
        )
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
        # Pick the nearest maturity that has a non-zero market IV at ATM
        maturity_order = np.argsort(surface.maturity_grid)
        atm_market_iv = 0.0
        chosen_near_index = int(maturity_order[0])
        for mi in maturity_order:
            iv_val = float(surface.implied_vol_matrix[int(mi), atm_index])
            if iv_val > 1e-6:
                atm_market_iv = iv_val
                chosen_near_index = int(mi)
                break
        atm_model_iv = float(model_iv_matrix[chosen_near_index, atm_index])
        if atm_market_iv < 1e-6:
            atm_market_iv = atm_model_iv

        num_strikes = len(surface.strike_grid)
        otm_put_idx = max(0, atm_index - max(1, num_strikes // 8))
        otm_call_idx = min(num_strikes - 1, atm_index + max(1, num_strikes // 8))
        put_wing_iv = float(surface.implied_vol_matrix[chosen_near_index, otm_put_idx])
        call_wing_iv = float(surface.implied_vol_matrix[chosen_near_index, otm_call_idx])
        skew_slope = put_wing_iv - call_wing_iv

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
                "expiry_labels": oi_profile["expiry_labels"],
                "open_interest_matrix": oi_profile["open_interest_matrix"],
                "max_pain_by_expiry": oi_profile["max_pain_by_expiry"],
            },
            "calibration": {
                "parameters": asdict(calibration_result.parameters),
                "weighted_rmse": calibration_result.metrics.weighted_rmse,
                "iterations": calibration_result.iterations,
                "converged": calibration_result.converged,
            },
            "regime": {
                "label": regime.label,
                "confidence": regime.confidence,
                "volatility_regime_score": round(atm_market_iv / max(rv_reference, 1e-8), 4),
                "skew_regime_score": round(skew_slope, 6),
            },
            "top_strategies": self._build_top_strategies(ranked, pnl_distributions, simulation_result.terminal_prices, request.spot, near_expiry_date, near_T, strategy_margin_lookup, market_mid, market_bid_ask),
        }
        self._logger.info("END | run_static_pipeline")
        return response

    def recalibrate(
        self,
        data_id: Optional[str] = None,
        initial_guess: Optional[Dict[str, float]] = None,
        param_bounds: Optional[Dict[str, list]] = None,
        risk_free_rate: float = 0.065,
        dividend_yield: float = 0.012,
        capital_limit: float = 500000,
        strike_increment: int = 50,
        max_legs: int = 4,
        max_width: float = 1000,
        simulation_paths: int = 5000,
        simulation_steps: int = 32,
    ) -> Dict[str, Any]:
        """
        Re-run ONLY calibration (and downstream simulation/evaluation/ranking)
        on the same cached market data, with user-specified initial guess or bounds.

        This is the engine behind the AI Calibration Monitor's "Re-Calibrate" action.
        """
        self._logger.info(
            "START | recalibrate | data_id=%s | initial_guess=%s | bounds=%s",
            data_id, initial_guess, param_bounds,
        )

        # Resolve market data from cache
        if data_id:
            cached = self.get_cached_nse_data(data_id)
            if cached is None:
                raise ValueError(f"No cached NSE data for data_id={data_id}. Run pipeline first.")
            raw_records = cached["cleaned_records"]
            spot = cached["spot"]
            symbol = cached.get("symbol", "NIFTY")
        else:
            raise ValueError("data_id is required for recalibration.")

        if not raw_records:
            raise ValueError("Cached NSE data contains no records.")

        # Rebuild surface from cached records
        filtered = self._liquidity_filter.filter_records(records=raw_records, spot=spot)
        surface = self._surface_builder.build_surface(records=filtered)

        # Build initial guess tuple (kappa, theta, xi, rho, v0)
        ig = initial_guess or {}
        guess_tuple = (
            ig.get("kappa", 1.5),
            ig.get("theta", 0.04),
            ig.get("xi", 0.4),
            ig.get("rho", -0.6),
            ig.get("v0", 0.04),
        )

        # Override bounds if provided, otherwise auto-tighten around initial guess
        default_bounds = CONFIG.calibration.param_bounds
        if param_bounds:
            bounds_list = list(default_bounds)
            param_order = ["kappa", "theta", "xi", "rho", "v0"]
            for i, name in enumerate(param_order):
                if name in param_bounds:
                    bounds_list[i] = tuple(param_bounds[name])
            custom_bounds = tuple(bounds_list)
        elif initial_guess:
            # Auto-derive tighter bounds around the initial guess so the
            # L-BFGS-B optimizer cannot escape to unrealistic boundary extremes.
            auto_bounds = []
            param_configs = [
                # (name, guess_val, default_bound, lo_factor, hi_factor, abs_floor)
                ("kappa", guess_tuple[0], default_bounds[0], 0.20, 3.0, 0.3),
                ("theta", guess_tuple[1], default_bounds[1], 0.25, 3.0, 0.005),
                ("xi",    guess_tuple[2], default_bounds[2], 0.25, 3.0, 0.05),
                ("rho",   guess_tuple[3], default_bounds[3], None, None, None),  # special
                ("v0",    guess_tuple[4], default_bounds[4], 0.25, 3.0, 0.005),
            ]
            for name, gv, (d_lo, d_hi), lo_f, hi_f, floor in param_configs:
                if name == "rho":
                    # rho is negative: tighten to [guess-0.25, min(guess+0.25, 0.0)]
                    r_lo = max(d_lo, gv - 0.25)
                    r_hi = min(d_hi, gv + 0.25)
                    auto_bounds.append((r_lo, r_hi))
                else:
                    a_lo = max(d_lo, max(floor, gv * lo_f))
                    a_hi = min(d_hi, gv * hi_f)
                    if a_lo >= a_hi:
                        a_lo, a_hi = d_lo, d_hi
                    auto_bounds.append((a_lo, a_hi))
            custom_bounds = tuple(auto_bounds)
            self._logger.info(
                "RECALIBRATE | auto-tightened bounds: %s", custom_bounds,
            )
        else:
            custom_bounds = default_bounds

        # Temporarily override bounds in config for the calibrator
        original_bounds = CONFIG.calibration.param_bounds
        try:
            # Use object.__setattr__ since CalibrationConfig is frozen
            object.__setattr__(CONFIG.calibration, 'param_bounds', custom_bounds)

            calibration_result = self._calibrator.calibrate(
                market_surface=surface,
                filtered_records=filtered,
                spot=spot,
                rate=risk_free_rate,
                dividend_yield=dividend_yield,
                initial_guess=guess_tuple,
            )
        finally:
            object.__setattr__(CONFIG.calibration, 'param_bounds', original_bounds)

        # Run downstream: simulation → strategies → evaluation → ranking
        maturity = float(np.max(surface.maturity_grid))
        simulation_result = self._monte_carlo.simulate(
            params=calibration_result.parameters,
            spot=spot,
            maturity=maturity,
            risk_free_rate=risk_free_rate,
            path_count=simulation_paths,
            time_steps=simulation_steps,
            full_path=False,
        )

        constraints = StrategyConstraints(
            capital_limit=capital_limit,
            strike_increment=strike_increment,
            max_legs=max_legs,
            max_width=max_width,
            max_combinations_per_strategy=CONFIG.strategy.max_combinations_per_strategy,
        )
        strike_set = self._select_candidate_strikes(
            strikes=sorted({item.strike for item in filtered}),
            spot=spot,
        )
        strategies = self._generate_strategies(constraints=constraints, strike_set=strike_set)

        near_T = float(np.min(surface.maturity_grid))
        _near_idx = int(np.argmin(surface.maturity_grid))
        near_expiry_date = surface.expiry_list[_near_idx].isoformat() if _near_idx < len(surface.expiry_list) else None
        model_iv_for_pricing = self._build_model_surface_matrix(
            spot=spot,
            rate=risk_free_rate,
            dividend_yield=dividend_yield,
            maturity_grid=surface.maturity_grid,
            strike_grid=surface.strike_grid,
            params=calibration_result.parameters,
        )
        _strike_arr = surface.strike_grid
        _iv_row = model_iv_for_pricing[_near_idx]

        def iv_lookup(strike: float, option_type: str) -> float:
            idx = int(np.argmin(np.abs(_strike_arr - strike)))
            return max(float(_iv_row[idx]), 0.01)

        market_mid = self._build_market_mid(filtered)
        market_bid_ask = self._build_market_bid_ask(filtered)

        metrics, pnl_distributions = self._static_eval.evaluate(
            strategies=strategies,
            terminal_prices=simulation_result.terminal_prices,
            spot=spot,
            T=near_T,
            r=risk_free_rate,
            iv_lookup=iv_lookup,
            market_mid=market_mid,
            market_bid_ask=market_bid_ask,
        )

        fragility_scores: Dict[str, float] = {}
        for metric in metrics:
            key = f"{metric.strategy_type}:{metric.strikes}"
            fragility_input = pnl_distributions.get(key, np.array([], dtype=float))
            fragility_scores[key] = self._fragility.compute_fragility(fragility_input)

        returns_proxy = np.diff(np.log(np.sort(simulation_result.terminal_prices)))
        regime = self._regime.classify(returns_proxy)
        ranked = self._ranking.rank(
            metrics=metrics,
            fragility_scores=fragility_scores,
            regime_weights=regime.ranking_weights,
        )

        model_iv_matrix = model_iv_for_pricing
        residual_iv_matrix = model_iv_matrix - surface.implied_vol_matrix
        oi_profile = self._build_open_interest_profile(
            filtered_records=filtered,
            expiry_list=surface.expiry_list,
            strike_grid=surface.strike_grid,
        )

        atm_index = int(np.argmin(np.abs(surface.strike_grid - spot)))
        maturity_order = np.argsort(surface.maturity_grid)
        atm_market_iv = 0.0
        chosen_near_index = int(maturity_order[0])
        for mi in maturity_order:
            iv_val = float(surface.implied_vol_matrix[int(mi), atm_index])
            if iv_val > 1e-6:
                atm_market_iv = iv_val
                chosen_near_index = int(mi)
                break
        atm_model_iv = float(model_iv_matrix[chosen_near_index, atm_index])
        if atm_market_iv < 1e-6:
            atm_market_iv = atm_model_iv

        num_strikes = len(surface.strike_grid)
        otm_put_idx = max(0, atm_index - max(1, num_strikes // 8))
        otm_call_idx = min(num_strikes - 1, atm_index + max(1, num_strikes // 8))
        put_wing_iv = float(surface.implied_vol_matrix[chosen_near_index, otm_put_idx])
        call_wing_iv = float(surface.implied_vol_matrix[chosen_near_index, otm_call_idx])
        skew_slope = put_wing_iv - call_wing_iv

        history_metrics = self._fetch_market_history_metrics(symbol, atm_market_iv)
        rv_reference = history_metrics["rv_20d"] if history_metrics["rv_20d"] is not None else atm_model_iv
        realized_implied_spread = float(atm_market_iv - rv_reference)
        strategy_margin_lookup = {
            (strategy.strategy_type, strategy.strikes): float(strategy.margin)
            for strategy in strategies
        }

        response = {
            "recalibrated": True,
            "initial_guess_used": {"kappa": guess_tuple[0], "theta": guess_tuple[1], "xi": guess_tuple[2], "rho": guess_tuple[3], "v0": guess_tuple[4]},
            "bounds_used": {name: list(custom_bounds[i]) for i, name in enumerate(["kappa", "theta", "xi", "rho", "v0"])},
            "market_overview": {
                "spot": spot,
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
                "data_source": "nse_live",
            },
            "surface": {
                "strike_grid": surface.strike_grid.tolist(),
                "maturity_grid": surface.maturity_grid.tolist(),
                "market_iv_matrix": surface.implied_vol_matrix.tolist(),
                "model_iv_matrix": model_iv_matrix.tolist(),
                "residual_iv_matrix": residual_iv_matrix.tolist(),
                "expiry_labels": oi_profile["expiry_labels"],
                "open_interest_matrix": oi_profile["open_interest_matrix"],
                "max_pain_by_expiry": oi_profile["max_pain_by_expiry"],
            },
            "calibration": {
                "parameters": asdict(calibration_result.parameters),
                "weighted_rmse": calibration_result.metrics.weighted_rmse,
                "iterations": calibration_result.iterations,
                "converged": calibration_result.converged,
            },
            "regime": {
                "label": regime.label,
                "confidence": regime.confidence,
                "volatility_regime_score": round(atm_market_iv / max(rv_reference, 1e-8), 4),
                "skew_regime_score": round(skew_slope, 6),
            },
            "top_strategies": self._build_top_strategies(ranked, pnl_distributions, simulation_result.terminal_prices, spot, near_expiry_date, near_T, strategy_margin_lookup, market_mid, market_bid_ask),
        }
        self._logger.info("END | recalibrate | rmse=%.6f | converged=%s", calibration_result.metrics.weighted_rmse, calibration_result.converged)
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
