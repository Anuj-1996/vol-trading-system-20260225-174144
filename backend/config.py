from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Tuple


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
    liquidity: LiquidityConfig = field(default_factory=LiquidityConfig)
    calibration: CalibrationConfig = field(default_factory=CalibrationConfig)
    simulation: SimulationConfig = field(default_factory=SimulationConfig)
    ranking: RankingConfig = field(default_factory=RankingConfig)
    strategy: StrategyConfig = field(default_factory=StrategyConfig)


CONFIG = AppConfig()
