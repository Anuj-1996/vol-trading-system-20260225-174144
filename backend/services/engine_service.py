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

NIFTY50_TICKERS = [
    "ADANIENT.NS", "ADANIPORTS.NS", "APOLLOHOSP.NS", "ASIANPAINT.NS", "AXISBANK.NS",
    "BAJAJ-AUTO.NS", "BAJFINANCE.NS", "BAJAJFINSV.NS", "BEL.NS", "BHARTIARTL.NS",
    "BPCL.NS", "BRITANNIA.NS", "CIPLA.NS", "COALINDIA.NS", "DRREDDY.NS",
    "EICHERMOT.NS", "ETERNAL.NS", "GRASIM.NS", "HCLTECH.NS", "HDFCBANK.NS",
    "HDFCLIFE.NS", "HEROMOTOCO.NS", "HINDALCO.NS", "HINDUNILVR.NS", "ICICIBANK.NS",
    "INDUSINDBK.NS", "INFY.NS", "ITC.NS", "JIOFIN.NS", "JSWSTEEL.NS",
    "KOTAKBANK.NS", "LT.NS", "M&M.NS", "MARUTI.NS", "NESTLEIND.NS",
    "NTPC.NS", "ONGC.NS", "POWERGRID.NS", "RELIANCE.NS", "SBILIFE.NS",
    "SBIN.NS", "SHRIRAMFIN.NS", "SUNPHARMA.NS", "TATACONSUM.NS", "TATAMOTORS.NS",
    "TATASTEEL.NS", "TCS.NS", "TECHM.NS", "TITAN.NS", "TRENT.NS", "ULTRACEMCO.NS",
    "WIPRO.NS",
]


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
                "vol_model_forecasts": history_metrics["vol_model_forecasts"],
                "mmi_yf": history_metrics.get("mmi_yf"),
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

    @staticmethod
    def _variance_to_annual_vol(sigma2: np.ndarray) -> np.ndarray:
        safe = np.maximum(sigma2, 1e-12)
        return np.sqrt(safe * 252.0)

    @staticmethod
    def _rolling_normalize_100(series: pd.Series, window: int = 45) -> pd.Series:
        values = pd.to_numeric(series, errors="coerce")
        mean = values.rolling(window, min_periods=10).mean()
        std = values.rolling(window, min_periods=10).std(ddof=0)
        z = (values - mean) / std.replace(0.0, np.nan)
        score = (50.0 + 15.0 * z).clip(lower=0.0, upper=100.0)
        return score

    def _fetch_tradingview_iv_proxy_latest(self) -> Optional[float]:
        """
        Fetch latest India VIX close from TradingView TA (if installed).
        Returns annualized IV in decimal terms (e.g., 0.165 for 16.5%).
        """
        try:
            from tradingview_ta import Interval, TA_Handler

            handler = TA_Handler(
                symbol="INDIAVIX",
                screener="india",
                exchange="NSE",
                interval=Interval.INTERVAL_1_DAY,
            )
            analysis = handler.get_analysis()
            close_value = None
            if analysis is not None and isinstance(getattr(analysis, "indicators", None), dict):
                close_value = analysis.indicators.get("close")
            close_numeric = float(close_value) if close_value is not None else np.nan
            if np.isfinite(close_numeric):
                return close_numeric / 100.0
        except Exception as exc:
            self._logger.info("TRADINGVIEW_IV_PROXY_UNAVAILABLE | error=%s", exc)
        return None

    def _build_mmi_from_yfinance(self, index_close: pd.Series, period: str = "18mo") -> Optional[Dict[str, Any]]:
        try:
            import yfinance as yf
        except Exception:
            return None

        base_close = pd.to_numeric(index_close, errors="coerce").dropna()
        if base_close.empty or base_close.shape[0] < 60:
            return None

        idx = base_close.index
        component_scores: Dict[str, pd.Series] = {}
        component_meta: Dict[str, Dict[str, str]] = {
            "volatility_skew": {"label": "Volatility & Skew (VIX)", "source": "^INDIAVIX"},
            "momentum": {"label": "Momentum (EMA30-EMA90)", "source": "Index OHLC"},
            "breadth": {"label": "Market Breadth (Modified Arms)", "source": "NIFTY 50 constituents"},
            "price_strength": {"label": "Price Strength (Near 52W H/L)", "source": "NIFTY 50 constituents"},
            "gold_demand": {"label": "Demand for Gold (2W rel)", "source": "GC=F vs Index"},
        }

        # Volatility and skew proxy from India VIX level.
        try:
            vix = yf.download("^INDIAVIX", period=period, interval="1d", auto_adjust=False, progress=False, threads=False)
            if vix is not None and not vix.empty:
                if isinstance(vix.columns, pd.MultiIndex):
                    vix.columns = [col[0] for col in vix.columns]
                if "Close" in vix.columns:
                    vix_close = pd.to_numeric(vix["Close"], errors="coerce").reindex(idx)
                    component_scores["volatility_skew"] = self._rolling_normalize_100(vix_close, 45)
        except Exception as exc:
            self._logger.warning("MMI_VIX_FETCH_FAIL | error=%s", exc)

        # Momentum component.
        ema30 = base_close.ewm(span=30, adjust=False).mean()
        ema90 = base_close.ewm(span=90, adjust=False).mean()
        momentum_raw = ((ema30 - ema90) / ema90.replace(0.0, np.nan)) * 100.0
        component_scores["momentum"] = self._rolling_normalize_100(momentum_raw, 45)

        # Gold demand component: 2-week relative return (gold - index).
        try:
            gold = yf.download("GC=F", period=period, interval="1d", auto_adjust=False, progress=False, threads=False)
            if gold is not None and not gold.empty:
                if isinstance(gold.columns, pd.MultiIndex):
                    gold.columns = [col[0] for col in gold.columns]
                if "Close" in gold.columns:
                    gold_close = pd.to_numeric(gold["Close"], errors="coerce").reindex(idx)
                    gold_ret_2w = gold_close.pct_change(10)
                    idx_ret_2w = base_close.pct_change(10)
                    gold_rel = (gold_ret_2w - idx_ret_2w) * 100.0
                    component_scores["gold_demand"] = self._rolling_normalize_100(gold_rel, 45)
        except Exception as exc:
            self._logger.warning("MMI_GOLD_FETCH_FAIL | error=%s", exc)

        # Breadth + price strength from NIFTY constituents.
        try:
            basket = yf.download(
                NIFTY50_TICKERS,
                period=period,
                interval="1d",
                auto_adjust=False,
                progress=False,
                threads=False,
            )
            close_df = pd.DataFrame(index=idx)
            volume_df = pd.DataFrame(index=idx)
            if basket is not None and not basket.empty and isinstance(basket.columns, pd.MultiIndex):
                cols = basket.columns
                # Try shape: (field, ticker)
                for ticker in NIFTY50_TICKERS:
                    if ("Close", ticker) in cols:
                        close_df[ticker] = pd.to_numeric(basket[("Close", ticker)], errors="coerce").reindex(idx)
                    if ("Volume", ticker) in cols:
                        volume_df[ticker] = pd.to_numeric(basket[("Volume", ticker)], errors="coerce").reindex(idx)
                    # Alternate shape: (ticker, field)
                    if (ticker, "Close") in cols and ticker not in close_df.columns:
                        close_df[ticker] = pd.to_numeric(basket[(ticker, "Close")], errors="coerce").reindex(idx)
                    if (ticker, "Volume") in cols and ticker not in volume_df.columns:
                        volume_df[ticker] = pd.to_numeric(basket[(ticker, "Volume")], errors="coerce").reindex(idx)

            if not close_df.empty:
                returns = close_df.pct_change()
                adv = (returns > 0).sum(axis=1).astype(float)
                dec = (returns < 0).sum(axis=1).astype(float).replace(0.0, np.nan)
                ad_ratio = adv / dec

                up_vol = volume_df.where(returns > 0).sum(axis=1) if not volume_df.empty else pd.Series(index=idx, dtype=float)
                down_vol = volume_df.where(returns < 0).sum(axis=1).replace(0.0, np.nan) if not volume_df.empty else pd.Series(index=idx, dtype=float)
                ad_vol_ratio = up_vol / down_vol
                breadth_raw = -(ad_ratio / ad_vol_ratio.replace(0.0, np.nan))
                component_scores["breadth"] = self._rolling_normalize_100(breadth_raw, 45)

                rolling_hi = close_df.rolling(252, min_periods=60).max()
                rolling_lo = close_df.rolling(252, min_periods=60).min()
                near_hi = (close_df >= (rolling_hi * 0.95)).sum(axis=1).astype(float)
                near_lo = (close_df <= (rolling_lo * 1.05)).sum(axis=1).astype(float)
                universe = close_df.notna().sum(axis=1).replace(0.0, np.nan).astype(float)
                price_strength_raw = ((near_hi / universe) - (near_lo / universe)) * 100.0
                component_scores["price_strength"] = self._rolling_normalize_100(price_strength_raw, 45)
        except Exception as exc:
            self._logger.warning("MMI_BREADTH_FETCH_FAIL | error=%s", exc)

        if not component_scores:
            return None

        score_frame = pd.DataFrame(component_scores, index=idx).reindex(idx)
        final = score_frame.mean(axis=1, skipna=True)
        final[score_frame.notna().sum(axis=1) == 0] = np.nan

        tail_len = min(180, len(idx))
        tail_idx = idx[-tail_len:]
        tail_final = final.reindex(tail_idx)
        latest = float(tail_final.dropna().iloc[-1]) if not tail_final.dropna().empty else None
        avg5 = float(tail_final.dropna().tail(5).mean()) if not tail_final.dropna().empty else None
        missing_components = [name for name in ["fii_activity"] if name not in component_scores]

        components_payload = []
        for key, meta in component_meta.items():
            values = score_frame.get(key)
            components_payload.append({
                "key": key,
                "label": meta["label"],
                "source": meta["source"],
                "score": [
                    float(value) if np.isfinite(value) else None
                    for value in (values.reindex(tail_idx) if values is not None else pd.Series(index=tail_idx, dtype=float))
                ],
                "available": key in component_scores,
            })

        return {
            "dates": [item.strftime("%Y-%m-%d") for item in tail_idx],
            "final": [float(value) if np.isfinite(value) else None for value in tail_final.to_numpy(dtype=float)],
            "components": components_payload,
            "latest": latest,
            "avg5": avg5,
            "coverage": int(len(component_scores)),
            "missing_components": missing_components,
            "methodology_window_days": 45,
            "normalization": "z-score mapped to 0-100 (50 + 15*z, clipped)",
            "weighting": "equal",
            "source": "yfinance",
        }

    @staticmethod
    def _fit_vol_models(log_returns: pd.Series, atm_market_iv: float, rv_20d: Optional[float]) -> Dict[str, Any]:
        if log_returns is None or log_returns.empty:
            return {"dates": [], "hv20": [], "rv20": [], "iv_proxy": [], "models": {}}

        eps = log_returns.to_numpy(dtype=float)
        eps = eps - float(np.nanmean(eps))
        n = eps.size
        if n < 30:
            return {"dates": [], "hv20": [], "rv20": [], "iv_proxy": [], "models": {}}

        target_var = float(np.nanvar(eps, ddof=1))
        target_var = max(target_var, 1e-8)

        def garch_family_series(alpha: float, beta: float, omega: float, gamma: float = 0.0) -> np.ndarray:
            sigma2 = np.full(n, target_var, dtype=float)
            for idx in range(1, n):
                shock2 = eps[idx - 1] ** 2
                leverage = gamma * shock2 if eps[idx - 1] < 0 else 0.0
                sigma2[idx] = max(1e-12, omega + alpha * shock2 + leverage + beta * sigma2[idx - 1])
            return sigma2

        def egarch_series(alpha: float, beta: float, omega: float, gamma: float = 0.0) -> np.ndarray:
            log_sigma2 = np.full(n, np.log(target_var), dtype=float)
            e_abs = np.sqrt(2.0 / np.pi)
            for idx in range(1, n):
                prev_sigma = np.sqrt(max(np.exp(log_sigma2[idx - 1]), 1e-12))
                z_prev = eps[idx - 1] / prev_sigma
                log_sigma2[idx] = omega + beta * log_sigma2[idx - 1] + alpha * (abs(z_prev) - e_abs) + gamma * z_prev
            return np.exp(log_sigma2)

        params = {
            "ARCH": {"alpha": 0.25, "beta": 0.0, "gamma": 0.0},
            "GARCH": {"alpha": 0.08, "beta": 0.90, "gamma": 0.0},
            "GARCH_EPOW": {"alpha": 0.12, "beta": 0.92, "gamma": -0.08},  # EGARCH-style proxy
            "GJR_GARCH": {"alpha": 0.05, "beta": 0.88, "gamma": 0.10},
        }
        params["ARCH"]["omega"] = target_var * (1.0 - params["ARCH"]["alpha"])
        params["GARCH"]["omega"] = target_var * (1.0 - params["GARCH"]["alpha"] - params["GARCH"]["beta"])
        params["GJR_GARCH"]["omega"] = target_var * (
            1.0 - params["GJR_GARCH"]["alpha"] - params["GJR_GARCH"]["beta"] - 0.5 * params["GJR_GARCH"]["gamma"]
        )
        params["GARCH_EPOW"]["omega"] = (1.0 - params["GARCH_EPOW"]["beta"]) * np.log(target_var)
        for model_key in params:
            params[model_key]["omega"] = max(float(params[model_key]["omega"]), 1e-12)

        hv20 = log_returns.rolling(20).std(ddof=1) * np.sqrt(252.0)
        hv20_np = hv20.to_numpy(dtype=float)

        iv_scale = 1.15
        if rv_20d is not None and rv_20d > 1e-9:
            iv_scale = float(np.clip(atm_market_iv / rv_20d, 0.5, 2.5))

        model_series: Dict[str, Dict[str, Any]] = {}
        horizon = 20
        for model_name, p in params.items():
            if model_name == "GARCH_EPOW":
                sigma2 = egarch_series(alpha=p["alpha"], beta=p["beta"], omega=p["omega"], gamma=p["gamma"])
            else:
                sigma2 = garch_family_series(alpha=p["alpha"], beta=p["beta"], omega=p["omega"], gamma=p["gamma"])

            rv_series = StrategyEngineService._variance_to_annual_vol(sigma2)
            iv_series = rv_series * iv_scale
            rv_forecast = float(rv_series[-1])
            iv_forecast = float(iv_series[-1])

            if model_name == "GARCH_EPOW":
                log_var = np.log(max(sigma2[-1], 1e-12))
                for _ in range(horizon):
                    log_var = p["omega"] + p["beta"] * log_var
                rv_forecast = float(np.sqrt(np.exp(log_var) * 252.0))
                iv_forecast = float(rv_forecast * iv_scale)
            else:
                next_var = sigma2[-1]
                prev_shock2 = eps[-1] ** 2
                for step in range(horizon):
                    shock_input = prev_shock2 if step == 0 else next_var
                    leverage = p["gamma"] * shock_input if eps[-1] < 0 and model_name == "GJR_GARCH" else 0.0
                    next_var = max(1e-12, p["omega"] + p["alpha"] * shock_input + leverage + p["beta"] * next_var)
                rv_forecast = float(np.sqrt(next_var * 252.0))
                iv_forecast = float(rv_forecast * iv_scale)

            model_series[model_name] = {
                "rv_series": [float(value) if np.isfinite(value) else None for value in rv_series],
                "iv_series": [float(value) if np.isfinite(value) else None for value in iv_series],
                "rv_forecast_20d": rv_forecast,
                "iv_forecast_20d": iv_forecast,
            }

        # Alias for UI naming request ("GTR GARCH")
        if "GJR_GARCH" in model_series:
            model_series["GTR_GARCH"] = dict(model_series["GJR_GARCH"])

        return {
            "dates": [idx.strftime("%Y-%m-%d") for idx in log_returns.index],
            "hv20": [float(value) if np.isfinite(value) else None for value in hv20_np],
            "rv20": [float(value) if np.isfinite(value) else None for value in hv20_np],
            "iv_proxy": [],
            "models": model_series,
        }

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
                "vol_model_forecasts": None,
                "mmi_yf": None,
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
                "vol_model_forecasts": None,
                "mmi_yf": None,
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
                    "vol_model_forecasts": None,
                    "mmi_yf": None,
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
        vol_model_forecasts = self._fit_vol_models(log_returns=log_returns, atm_market_iv=atm_market_iv, rv_20d=rv_20d)
        iv_proxy_source = None

        # Add a proxy IV time-series using India VIX from Yahoo when available.
        try:
            vix_history = yf.download(
                "^INDIAVIX",
                period="18mo",
                interval="1d",
                auto_adjust=False,
                progress=False,
                threads=False,
            )
            if vix_history is not None and not vix_history.empty:
                if isinstance(vix_history.columns, pd.MultiIndex):
                    vix_history.columns = [col[0] for col in vix_history.columns]
                if "Close" in vix_history.columns:
                    vix_series = (vix_history["Close"].astype(float) / 100.0).reindex(log_returns.index)
                    vol_model_forecasts["iv_proxy"] = [
                        float(value) if np.isfinite(value) else None
                        for value in vix_series.to_numpy(dtype=float)
                    ]
                    iv_proxy_source = "yfinance_^INDIAVIX"
        except Exception:
            pass

        # Prefer TradingView latest print when available (python-tradingview-ta).
        tv_latest_iv = self._fetch_tradingview_iv_proxy_latest()
        if tv_latest_iv is not None:
            iv_proxy = list(vol_model_forecasts.get("iv_proxy", []))
            if not iv_proxy:
                iv_proxy = [None] * len(log_returns.index)
            if iv_proxy:
                iv_proxy[-1] = float(tv_latest_iv)
            vol_model_forecasts["iv_proxy"] = iv_proxy
            iv_proxy_source = "tradingview_ta_NSE_INDIAVIX_latest"
        vol_model_forecasts["iv_proxy_source"] = iv_proxy_source

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
        mmi_yf = self._build_mmi_from_yfinance(close, period="18mo")

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
            "vol_model_forecasts": vol_model_forecasts,
            "mmi_yf": mmi_yf,
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
                "vol_model_forecasts": history_metrics["vol_model_forecasts"],
                "mmi_yf": history_metrics.get("mmi_yf"),
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
                "vol_model_forecasts": history_metrics["vol_model_forecasts"],
                "mmi_yf": history_metrics.get("mmi_yf"),
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
