from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException

from ..config import CONFIG
from ..exceptions import CalibrationError, DataIngestionError, EngineError, SimulationError, StrategyError
from ..logger import get_logger
from ..services.engine_service import PipelineRequest, StrategyEngineService
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
