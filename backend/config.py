from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Tuple


def _load_local_env_files() -> None:
    for candidate in (Path(".env.local"), Path("backend/.env.local")):
        if not candidate.exists():
            continue
        for raw_line in candidate.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


_load_local_env_files()
# Force data source to ZERODHA (Kite), disabling NSE
DATA_SOURCE = "ZERODHA"


@dataclass(frozen=True)
class LoggingConfig:
    level: str = "INFO"
    format: str = "%(asctime)s | %(levelname)s | %(name)s | %(message)s"
    directory: Path = Path("backend/logs")
    filename: str = "logger.log"


@dataclass(frozen=True)
class DataConfig:
    data_root: Path = Path("data")
    file_pattern: str = "NIFTY_*_option_chain_*.csv"
    strike_increment_allowed: Tuple[int, int] = (50, 100)
    source: str = DATA_SOURCE


@dataclass(frozen=True)
class ZerodhaConfig:
    api_key: str = field(default_factory=lambda: os.getenv("KITE_API_KEY", ""))
    api_secret: str = field(default_factory=lambda: os.getenv("KITE_API_SECRET", ""))
    access_token: str = field(default_factory=lambda: os.getenv("KITE_ACCESS_TOKEN", ""))
    request_token: str = field(default_factory=lambda: os.getenv("KITE_REQUEST_TOKEN", ""))
    redirect_url: str = field(
        default_factory=lambda: os.getenv("KITE_REDIRECT_URL", "http://127.0.0.1:8000/api/v1/auth/kite/callback")
    )
    risk_free_rate: float = field(default_factory=lambda: float(os.getenv("KITE_RISK_FREE_RATE", "0.065")))
    underlying_symbol: str = field(default_factory=lambda: os.getenv("KITE_UNDERLYING_SYMBOL", "NSE:NIFTY 50"))
    underlying_name: str = field(default_factory=lambda: os.getenv("KITE_UNDERLYING_NAME", "NIFTY 50"))
    snapshot_timeout_seconds: float = field(
        default_factory=lambda: float(os.getenv("KITE_SNAPSHOT_TIMEOUT_SECONDS", "15.0"))
    )
    max_instruments_per_subscription: int = field(
        default_factory=lambda: int(os.getenv("KITE_MAX_INSTRUMENTS_PER_SUBSCRIPTION", "500"))
    )


@dataclass(frozen=True)
class LiquidityConfig:
    min_open_interest: float = 5_000.0
    min_volume: float = 100.0
    max_bid_ask_spread_pct: float = 0.10
    moneyness_window_pct: float = 0.20


@dataclass(frozen=True)
class CalibrationConfig:
    max_iterations: int = 120
    tolerance: float = 1e-6
    fft_grid_size: int = 4096
    fft_eta: float = 0.20
    alpha_damp: float = 1.5
    short_maturity_weight_multiplier: float = 1.5
    feller_penalty_weight: float = 10_000.0
    param_bounds: Tuple[Tuple[float, float], ...] = (
        (0.05, 15.0),
        (0.005, 2.0),
        (0.05, 5.0),
        (-0.999, 0.0),
        (0.005, 2.0),
    )


@dataclass(frozen=True)
class SimulationConfig:
    default_paths: int = 50_000
    default_steps: int = 96
    random_seed: int = 42
    enable_numba: bool = True


@dataclass(frozen=True)
class RankingConfig:
    top_n: int = 10
    lambda_es99: float = 0.35
    lambda_fragility: float = 0.30
    lambda_rom: float = 0.20


@dataclass(frozen=True)
class StrategyConfig:
    max_candidate_strikes: int = 15
    max_combinations_per_strategy: int = 3000


@dataclass(frozen=True)
class AppConfig:
    logging: LoggingConfig = field(default_factory=LoggingConfig)
    data: DataConfig = field(default_factory=DataConfig)
    zerodha: ZerodhaConfig = field(default_factory=ZerodhaConfig)
    liquidity: LiquidityConfig = field(default_factory=LiquidityConfig)
    calibration: CalibrationConfig = field(default_factory=CalibrationConfig)
    simulation: SimulationConfig = field(default_factory=SimulationConfig)
    ranking: RankingConfig = field(default_factory=RankingConfig)
    strategy: StrategyConfig = field(default_factory=StrategyConfig)


CONFIG = AppConfig()
