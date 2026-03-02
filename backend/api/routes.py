from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException

from ..config import CONFIG
from ..exceptions import CalibrationError, DataIngestionError, EngineError, SimulationError, StrategyError
from ..logger import get_logger
from ..services.engine_service import LivePipelineRequest, PipelineRequest, StrategyEngineService
from ..services.job_service import AsyncJobService
from ..simulation.dynamic_hedge import HedgeMode


class StaticPipelinePayload(BaseModel):
    file_path: str
    db_path: str = "backend/vol_engine.db"
    spot: float = Field(gt=0.0)
    risk_free_rate: float
    dividend_yield: float
    capital_limit: float = Field(gt=0.0)
    strike_increment: int = Field(default=50, gt=0)
    max_legs: int = Field(default=4, ge=1, le=6)
    max_width: float = Field(default=1000.0, gt=0.0)
    simulation_paths: int = Field(default=30000, ge=1000)
    simulation_steps: int = Field(default=64, ge=8)


class DynamicPipelinePayload(StaticPipelinePayload):
    hedge_mode: HedgeMode
    transaction_cost_rate: float = Field(default=0.0005, ge=0.0)


class LiveFetchPayload(BaseModel):
    symbol: str = Field(default="NIFTY", description="Index symbol: NIFTY or BANKNIFTY")
    expiries: Optional[List[str]] = Field(
        default=None,
        description='List of expiry date strings, or null/["all"] for all',
    )


class LiveStaticPipelinePayload(BaseModel):
    data_id: str = Field(description="Cache key returned by /api/v1/data/fetch-live")
    db_path: str = "backend/vol_engine.db"
    risk_free_rate: float = 0.065
    dividend_yield: float = 0.012
    capital_limit: float = Field(default=500000.0, gt=0.0)
    strike_increment: int = Field(default=50, gt=0)
    max_legs: int = Field(default=4, ge=1, le=6)
    max_width: float = Field(default=1000.0, gt=0.0)
    simulation_paths: int = Field(default=30000, ge=1000)
    simulation_steps: int = Field(default=64, ge=8)


router = APIRouter()
_logger = get_logger("APIRouter")
_engine = StrategyEngineService()
_jobs = AsyncJobService()


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}


@router.get("/logs/recent")
def get_recent_logs(lines: int = 120) -> dict:
    safe_lines = max(10, min(lines, 1000))
    log_path: Path = CONFIG.logging.directory / CONFIG.logging.filename

    if not log_path.exists():
        return {"path": str(log_path), "lines": []}

    with log_path.open("r", encoding="utf-8", errors="replace") as handle:
        content = handle.readlines()
    return {"path": str(log_path), "lines": [line.rstrip("\n") for line in content[-safe_lines:]]}


@router.post("/pipeline/static")
def run_static_pipeline(payload: StaticPipelinePayload) -> dict:
    _logger.info("START | api_static_pipeline")
    try:
        request = PipelineRequest(**payload.model_dump())
        response = _engine.run_static_pipeline(request=request)
        _logger.info("END | api_static_pipeline")
        return {"status": "ok", "data": response}
    except (DataIngestionError, CalibrationError, SimulationError, StrategyError, EngineError) as exc:
        _logger.exception("ERROR | api_static_pipeline")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        _logger.exception("ERROR | api_static_pipeline")
        raise HTTPException(status_code=500, detail=f"Internal error: {exc}") from exc


@router.post("/pipeline/dynamic/submit")
def submit_dynamic_pipeline(payload: DynamicPipelinePayload) -> dict:
    _logger.info("START | api_dynamic_submit")
    try:
        request = PipelineRequest(**payload.model_dump(exclude={"hedge_mode", "transaction_cost_rate"}))

        def task() -> dict:
            return _engine.run_dynamic_hedge(
                request=request,
                hedge_mode=payload.hedge_mode,
                transaction_cost_rate=payload.transaction_cost_rate,
            )

        job_id = _jobs.submit(task=task)
        _logger.info("END | api_dynamic_submit | job_id=%s", job_id)
        return {"status": "accepted", "job_id": job_id}
    except Exception as exc:
        _logger.exception("ERROR | api_dynamic_submit")
        raise HTTPException(status_code=500, detail=f"Unable to submit dynamic job: {exc}") from exc


@router.get("/jobs/{job_id}")
def get_job_status(job_id: str) -> dict:
    _logger.info("START | api_job_status | job_id=%s", job_id)
    status = _jobs.status(job_id=job_id)
    _logger.info("END | api_job_status | job_id=%s | state=%s", job_id, status.state)
    return {
        "job_id": status.job_id,
        "state": status.state,
        "result": status.result,
        "error": status.error,
    }


@router.delete("/jobs/{job_id}")
def cancel_job(job_id: str) -> dict:
    _logger.info("START | api_job_cancel | job_id=%s", job_id)
    status = _jobs.cancel(job_id=job_id)
    _logger.info("END | api_job_cancel | job_id=%s | state=%s", job_id, status.state)
    return {
        "job_id": status.job_id,
        "state": status.state,
        "result": status.result,
        "error": status.error,
    }


# ──────────────────────────────────────────────────────────────────────
# NSE Live Data Endpoints
# ──────────────────────────────────────────────────────────────────────


@router.post("/data/fetch-live")
def fetch_live_nse_data(payload: LiveFetchPayload) -> dict:
    """Fetch option-chain data from NSE, clean it, and cache for analysis."""
    _logger.info("START | fetch_live_nse_data | symbol=%s", payload.symbol)
    try:
        result = _engine.fetch_nse_live_data(
            symbol=payload.symbol,
            expiries=payload.expiries,
        )
        _logger.info("END | fetch_live_nse_data | data_id=%s", result["data_id"])
        return {"status": "ok", "data": result}
    except DataIngestionError as exc:
        _logger.exception("ERROR | fetch_live_nse_data")
        raise HTTPException(status_code=502, detail=f"NSE fetch failed: {exc}") from exc
    except Exception as exc:
        _logger.exception("ERROR | fetch_live_nse_data")
        raise HTTPException(status_code=500, detail=f"Internal error: {exc}") from exc


@router.get("/data/expiries")
def get_nse_expiries(symbol: str = "NIFTY") -> dict:
    """Return available expiry dates from NSE (fast, metadata-only call)."""
    _logger.info("START | get_nse_expiries | symbol=%s", symbol)
    try:
        expiry_dates = _engine._nse_client.get_expiry_dates(symbol=symbol)
        return {
            "status": "ok",
            "data": {
                "expiry_dates": expiry_dates,
                "symbol": symbol,
            },
        }
    except DataIngestionError as exc:
        _logger.exception("ERROR | get_nse_expiries")
        raise HTTPException(status_code=502, detail=f"NSE fetch failed: {exc}") from exc
    except Exception as exc:
        _logger.exception("ERROR | get_nse_expiries")
        raise HTTPException(status_code=500, detail=f"Internal error: {exc}") from exc


@router.post("/pipeline/live-static")
def run_live_static_pipeline(payload: LiveStaticPipelinePayload) -> dict:
    """Run the full static analysis pipeline on cached live NSE data."""
    _logger.info("START | run_live_static_pipeline | data_id=%s", payload.data_id)
    try:
        request = LivePipelineRequest(**payload.model_dump())
        response = _engine.run_live_pipeline(request=request)
        _logger.info("END | run_live_static_pipeline")
        return {"status": "ok", "data": response}
    except ValueError as exc:
        _logger.exception("ERROR | run_live_static_pipeline")
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (DataIngestionError, CalibrationError, SimulationError, StrategyError, EngineError) as exc:
        _logger.exception("ERROR | run_live_static_pipeline")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        _logger.exception("ERROR | run_live_static_pipeline")
        raise HTTPException(status_code=500, detail=f"Internal error: {exc}") from exc
