from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional

from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..config import CONFIG
from ..exceptions import CalibrationError, DataIngestionError, EngineError, SimulationError, StrategyError
from ..logger import get_logger
from ..services.engine_service import LivePipelineRequest, PipelineRequest, StrategyEngineService
from ..services.job_service import AsyncJobService
from ..services.live_refresh_service import LiveRefreshService
from ..simulation.dynamic_hedge import HedgeMode
from ..ai.orchestrator_agent import OrchestratorAgent
from ..ai.strategy_picker import StrategyPickerAgent
from ..data import portfolio_repository as portfolio_db
from ..services.positioning_service import PositioningService


class PositioningPayload(BaseModel):
    data_id: str = Field(description="Cache key returned by /api/v1/data/fetch-live")
    risk_free_rate: float = Field(default=0.065)


class MonteCarloVariantPayload(BaseModel):
    data_id: str = Field(description="Cache key returned by /api/v1/data/fetch-live")
    risk_free_rate: float = Field(default=0.065)
    dividend_yield: float = Field(default=0.012)
    path_count: int = Field(default=2500, ge=500, le=10000)
    time_steps: int = Field(default=96, ge=16, le=256)


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
    model_selection: str = Field(default="SABR", description="Default surface comparison model: Heston or SABR")


class DynamicPipelinePayload(StaticPipelinePayload):
    hedge_mode: HedgeMode
    transaction_cost_rate: float = Field(default=0.0005, ge=0.0)


class LiveFetchPayload(BaseModel):
    symbol: str = Field(default="NIFTY", description="Index symbol: NIFTY or BANKNIFTY")
    expiries: Optional[List[str]] = Field(
        default=None,
        description='List of expiry date strings, or null/["all"] for all',
    )
    max_expiries: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Maximum number of near-term expiries to fetch (default 5)",
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
    model_selection: str = Field(default="SABR", description="Default surface comparison model: Heston or SABR")


class LiveRefreshPayload(BaseModel):
    symbol: str = Field(default="NIFTY", description="Index symbol: NIFTY or BANKNIFTY")
    max_expiries: int = Field(default=5, ge=1, le=20)
    refresh_interval_seconds: int = Field(default=240, ge=120, le=1800)
    auto_refresh_enabled: bool = True
    risk_free_rate: float = 0.065
    dividend_yield: float = 0.012
    capital_limit: float = Field(default=500000.0, gt=0.0)
    strike_increment: int = Field(default=50, gt=0)
    max_legs: int = Field(default=4, ge=1, le=6)
    max_width: float = Field(default=1000.0, gt=0.0)
    simulation_paths: int = Field(default=5000, ge=500)
    simulation_steps: int = Field(default=32, ge=8)
    model_selection: str = Field(default="SABR")
    force: bool = False


class AIChatPayload(BaseModel):
    query: str = Field(description="User question or command for the AI agents")
    agent: Optional[str] = Field(
        default=None,
        description="Force a specific agent: market_intel, strategy_advisor, risk_analyst, calibration_monitor, trade_execution, pre_trade, vol_surface",
    )
    pipeline_data: Optional[dict] = Field(
        default=None,
        description="Pipeline response to use as context (optional, uses last cached)",
    )
    model_id: Optional[str] = Field(
        default=None,
        description="Optional Ollama model id override (e.g., gemma:2b, gemma3:4b)",
    )


class AIBriefingPayload(BaseModel):
    pipeline_data: Optional[dict] = Field(
        default=None,
        description="Pipeline response to generate briefing from",
    )
    model_id: Optional[str] = Field(
        default=None,
        description="Optional Ollama model id override for all briefing agents",
    )


class AIStrategyPickPayload(BaseModel):
    pipeline_data: Optional[dict] = Field(
        default=None,
        description="Pipeline response context; if omitted uses last synced pipeline data",
    )
    model_id: str = Field(
        default="gemma3:1b",
        description="Ollama model id for compact strategy-pick explanation",
    )
    max_candidates: int = Field(
        default=3,
        ge=1,
        le=5,
        description="Number of shortlisted candidates to evaluate",
    )


class RecalibratePayload(BaseModel):
    data_id: str = Field(description="Cache key returned by /api/v1/data/fetch-live")
    initial_guess: Optional[dict] = Field(
        default=None,
        description="Custom Heston initial guess: {kappa, theta, xi, rho, v0}",
    )
    param_bounds: Optional[dict] = Field(
        default=None,
        description="Custom bounds: {kappa: [lo, hi], theta: [lo, hi], ...}",
    )
    risk_free_rate: float = 0.065
    dividend_yield: float = 0.012
    capital_limit: float = Field(default=500000.0, gt=0.0)
    strike_increment: int = Field(default=50, gt=0)
    max_legs: int = Field(default=4, ge=1, le=6)
    max_width: float = Field(default=1000.0, gt=0.0)
    simulation_paths: int = Field(default=5000, ge=500)
    simulation_steps: int = Field(default=32, ge=8)
    model_selection: str = Field(default="SABR", description="Default surface comparison model after recalibration")


router = APIRouter()
_logger = get_logger("APIRouter")
_engine = StrategyEngineService()
_jobs = AsyncJobService()
_live_refresh = LiveRefreshService(_engine)
_orchestrator = OrchestratorAgent()
_strategy_picker = StrategyPickerAgent()
_positioning = PositioningService()


@router.post("/positioning/calculate")
def calculate_dealer_positioning(payload: PositioningPayload) -> dict:
    """Calculate GEX, VEX, CEX and Gamma walls from cached NSE option chain."""
    _logger.info("START | calculate_dealer_positioning | data_id=%s", payload.data_id)
    try:
        result = _positioning.get_dealer_positioning(
            data_id=payload.data_id,
            risk_free_rate=payload.risk_free_rate
        )
        _logger.info("END | calculate_dealer_positioning")
        return {"status": "ok", "data": result}
    except ValueError as exc:
        _logger.warning("WARN | calculate_dealer_positioning | %s", exc)
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        _logger.exception("ERROR | calculate_dealer_positioning")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/surface/monte-carlo-variant")
def calculate_monte_carlo_variant(payload: MonteCarloVariantPayload) -> dict:
    _logger.info("START | calculate_monte_carlo_variant | data_id=%s", payload.data_id)
    try:
        result = _engine.build_monte_carlo_surface_variant(
            data_id=payload.data_id,
            risk_free_rate=payload.risk_free_rate,
            dividend_yield=payload.dividend_yield,
            path_count=payload.path_count,
            time_steps=payload.time_steps,
        )
        _logger.info("END | calculate_monte_carlo_variant")
        return {"status": "ok", "data": result}
    except ValueError as exc:
        _logger.warning("WARN | calculate_monte_carlo_variant | %s", exc)
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        _logger.exception("ERROR | calculate_monte_carlo_variant")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


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
            max_expiries=payload.max_expiries,
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
        cached = _engine.get_cached_nse_data(payload.data_id) or {}
        _live_refresh.seed_from_manual_pipeline(
            data_id=payload.data_id,
            pipeline_params=payload.model_dump(),
            max_expiries=len(getattr(cached.get("fetch_result"), "expiry_dates", []) or []) or 5,
            pipeline_result=response,
        )
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


@router.post("/live/refresh")
def trigger_live_refresh(payload: LiveRefreshPayload) -> dict:
    _logger.info("START | trigger_live_refresh | symbol=%s", payload.symbol)
    try:
        status = _live_refresh.trigger_refresh(
            symbol=payload.symbol,
            pipeline_params=payload.model_dump(exclude={"symbol", "max_expiries", "refresh_interval_seconds", "auto_refresh_enabled", "force"}),
            max_expiries=payload.max_expiries,
            refresh_interval_seconds=payload.refresh_interval_seconds,
            auto_refresh_enabled=payload.auto_refresh_enabled,
            force=payload.force,
        )
        _logger.info("END | trigger_live_refresh | symbol=%s", payload.symbol)
        return {"status": "ok", "data": status}
    except Exception as exc:
        _logger.exception("ERROR | trigger_live_refresh")
        raise HTTPException(status_code=500, detail=f"Unable to start live refresh: {exc}") from exc


@router.get("/live/status")
def get_live_refresh_status(symbol: str = "NIFTY") -> dict:
    _logger.info("START | get_live_refresh_status | symbol=%s", symbol)
    try:
        return {"status": "ok", "data": _live_refresh.get_status(symbol)}
    except Exception as exc:
        _logger.exception("ERROR | get_live_refresh_status")
        raise HTTPException(status_code=500, detail=f"Unable to read live status: {exc}") from exc


@router.get("/live/latest")
def get_live_latest_snapshot(symbol: str = "NIFTY") -> dict:
    _logger.info("START | get_live_latest_snapshot | symbol=%s", symbol)
    try:
        latest = _live_refresh.get_latest_snapshot(symbol)
        if latest is None:
            raise HTTPException(status_code=404, detail=f"No cached live snapshot for {symbol}")
        return {"status": "ok", "data": latest}
    except HTTPException:
        raise
    except Exception as exc:
        _logger.exception("ERROR | get_live_latest_snapshot")
        raise HTTPException(status_code=500, detail=f"Unable to read latest live snapshot: {exc}") from exc


# ──────────────────────────────────────────────────────────────────────
# AI Agent Endpoints
# ──────────────────────────────────────────────────────────────────────


@router.post("/ai/chat")
def ai_chat(payload: AIChatPayload) -> dict:
    """Send a query to the AI agent system. Auto-routes to the best agent."""
    _logger.info("START | ai_chat | query=%s | agent=%s", payload.query[:80], payload.agent)
    try:
        result = _orchestrator.chat(
            query=payload.query,
            agent_name=payload.agent,
            pipeline_data=payload.pipeline_data,
            model_id=payload.model_id,
        )
        _logger.info("END | ai_chat | agent=%s", result.get("agent"))
        return {"status": "ok", "data": result}
    except Exception as exc:
        _logger.exception("ERROR | ai_chat")
        raise HTTPException(status_code=500, detail=f"AI agent error: {exc}") from exc


@router.post("/ai/chat/stream")
def ai_chat_stream(payload: AIChatPayload):
    """Streaming chat endpoint. Returns SSE stream of agent response chunks."""
    _logger.info("START | ai_chat_stream | query=%s", payload.query[:80])

    def event_stream():
        try:
            for chunk_data in _orchestrator.chat_streaming(
                query=payload.query,
                agent_name=payload.agent,
                pipeline_data=payload.pipeline_data,
                model_id=payload.model_id,
            ):
                yield f"data: {json.dumps(chunk_data)}\n\n"
        except Exception as exc:
            _logger.exception("ERROR | ai_chat_stream")
            yield f"data: {json.dumps({'error': str(exc), 'done': True})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/ai/briefing")
def ai_briefing(payload: AIBriefingPayload) -> dict:
    """Generate a comprehensive market briefing from all agents."""
    _logger.info("START | ai_briefing")
    try:
        result = _orchestrator.generate_briefing(
            pipeline_data=payload.pipeline_data,
            model_id=payload.model_id,
        )
        _logger.info("END | ai_briefing")
        return {"status": "ok", "data": result}
    except Exception as exc:
        _logger.exception("ERROR | ai_briefing")
        raise HTTPException(status_code=500, detail=f"AI briefing error: {exc}") from exc


@router.post("/ai/strategy-pick")
def ai_strategy_pick(payload: AIStrategyPickPayload) -> dict:
    """Select best strategy for current market condition (separate from chat copilot)."""
    _logger.info("START | ai_strategy_pick | model=%s", payload.model_id)
    try:
        context_data = payload.pipeline_data or _orchestrator.get_pipeline_data()
        if not context_data:
            raise ValueError("No pipeline data available. Run Fetch Live & Analyse first.")
        result = _strategy_picker.pick(
            pipeline_data=context_data,
            model_id=payload.model_id,
            max_candidates=payload.max_candidates,
        )
        _logger.info("END | ai_strategy_pick | strategy=%s", result.get("primary", {}).get("strategy_type"))
        return {"status": "ok", "data": result}
    except ValueError as exc:
        _logger.exception("ERROR | ai_strategy_pick")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        _logger.exception("ERROR | ai_strategy_pick")
        raise HTTPException(status_code=500, detail=f"Strategy picker error: {exc}") from exc


@router.get("/ai/agents")
def ai_list_agents() -> dict:
    """List all available AI agents and their roles."""
    return {
        "status": "ok",
        "data": _orchestrator.get_available_agents(),
    }


@router.post("/ai/pipeline-sync")
def ai_sync_pipeline(payload: dict) -> dict:
    """Push pipeline data to the AI orchestrator for context."""
    _logger.info("START | ai_pipeline_sync")
    try:
        _orchestrator.set_pipeline_data(payload)
        return {"status": "ok", "message": "Pipeline data synced to AI agents."}
    except Exception as exc:
        _logger.exception("ERROR | ai_pipeline_sync")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/ai/recalibrate")
def ai_recalibrate(payload: RecalibratePayload) -> dict:
    """Re-run Heston calibration with custom initial guess / bounds on cached data."""
    _logger.info(
        "START | ai_recalibrate | data_id=%s | guess=%s",
        payload.data_id, payload.initial_guess,
    )
    try:
        result = _engine.recalibrate(
            data_id=payload.data_id,
            initial_guess=payload.initial_guess,
            param_bounds=payload.param_bounds,
            model_selection=payload.model_selection,
            risk_free_rate=payload.risk_free_rate,
            dividend_yield=payload.dividend_yield,
            capital_limit=payload.capital_limit,
            strike_increment=payload.strike_increment,
            max_legs=payload.max_legs,
            max_width=payload.max_width,
            simulation_paths=payload.simulation_paths,
            simulation_steps=payload.simulation_steps,
        )
        # Auto-sync updated pipeline data to AI agents
        _orchestrator.set_pipeline_data(result)
        _logger.info("END | ai_recalibrate | rmse=%.6f", result["calibration"]["weighted_rmse"])
        return {"status": "ok", "data": result}
    except (CalibrationError, ValueError) as exc:
        _logger.exception("ERROR | ai_recalibrate")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        _logger.exception("ERROR | ai_recalibrate")
        raise HTTPException(status_code=500, detail=f"Recalibration error: {exc}") from exc


@router.post("/ai/clear")
def ai_clear_conversation() -> dict:
    """Clear AI conversation history for a fresh session."""
    _orchestrator.clear_conversation()
    return {"status": "ok", "message": "Conversation cleared."}


# ──────────────────────────────────────────────────────────────────────
# Portfolio Endpoints
# ──────────────────────────────────────────────────────────────────────


class PortfolioAddPayload(BaseModel):
    strategy: dict = Field(description="Full strategy object from the screener")
    spot: float = Field(gt=0.0, description="Spot price at time of adding")


@router.post("/portfolio/add")
def portfolio_add(payload: PortfolioAddPayload) -> dict:
    """Add a strategy to the persistent portfolio."""
    _logger.info("START | portfolio_add | type=%s", payload.strategy.get("strategy_type"))
    try:
        position = portfolio_db.add_position(payload.strategy, payload.spot)
        return {"status": "ok", "data": position}
    except Exception as exc:
        _logger.exception("ERROR | portfolio_add")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/portfolio/positions")
def portfolio_list(status: str = "open") -> dict:
    """List all portfolio positions."""
    positions = portfolio_db.list_positions(status=status)
    # Compute portfolio-level totals
    totals = {"pnl": 0.0, "delta": 0.0, "gamma": 0.0, "vega": 0.0, "theta": 0.0, "margin": 0.0}
    for pos in positions:
        totals["pnl"] += float(pos.get("expected_value") or 0)
        totals["delta"] += float(pos.get("delta_exposure") or 0)
        totals["gamma"] += float(pos.get("gamma_exposure") or 0)
        totals["vega"] += float(pos.get("vega_exposure") or 0)
        totals["theta"] += float(pos.get("theta_exposure") or 0)
        totals["margin"] += float(pos.get("margin_required") or 0)
    return {"status": "ok", "data": {"positions": positions, "totals": totals}}


@router.get("/portfolio/positions/{pos_id}")
def portfolio_get(pos_id: str) -> dict:
    """Get a single portfolio position by ID."""
    position = portfolio_db.get_position(pos_id)
    if position is None:
        raise HTTPException(status_code=404, detail=f"Position {pos_id} not found")
    return {"status": "ok", "data": position}


@router.delete("/portfolio/positions/{pos_id}")
def portfolio_delete(pos_id: str) -> dict:
    """Delete a position from the portfolio (hard delete)."""
    deleted = portfolio_db.delete_position(pos_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Position {pos_id} not found")
    return {"status": "ok", "message": f"Position {pos_id} deleted"}


@router.delete("/portfolio/clear")
def portfolio_clear() -> dict:
    """Delete ALL positions from the portfolio."""
    count = portfolio_db.clear_all()
    return {"status": "ok", "message": f"Cleared {count} positions"}


@router.post("/portfolio/revalue")
def portfolio_revalue() -> dict:
    """
    Revalue all open portfolio positions using the latest cached live data.

    For each position, computes actual/live metrics (current spot, updated greeks,
    live PnL) from the most recent NSE data and returns them alongside the
    original expected metrics stored at entry time.
    """
    _logger.info("START | portfolio_revalue")
    try:
        positions = portfolio_db.list_positions(status="open")
        if not positions:
            return {"status": "ok", "data": {"positions": [], "totals": {
                "expected_pnl": 0, "actual_pnl": 0, "delta": 0, "gamma": 0, "vega": 0, "theta": 0, "margin": 0,
            }}}

        # Try to get latest cached data for revaluation
        from ..services.engine_service import _live_data_cache, _cache_lock
        current_spot = None
        with _cache_lock:
            if _live_data_cache:
                latest_key = max(_live_data_cache.keys(), key=lambda k: _live_data_cache[k].get("timestamp", ""))
                cached = _live_data_cache[latest_key]
                current_spot = cached.get("spot")

        revalued = []
        totals = {
            "expected_pnl": 0.0, "actual_pnl": 0.0,
            "delta": 0.0, "gamma": 0.0, "vega": 0.0, "theta": 0.0, "margin": 0.0,
        }

        for pos in positions:
            spot_entry = float(pos.get("spot_at_entry") or 0)
            expected_ev = float(pos.get("expected_value") or 0)
            delta = float(pos.get("delta_exposure") or 0)
            gamma = float(pos.get("gamma_exposure") or 0)
            vega = float(pos.get("vega_exposure") or 0)
            theta = float(pos.get("theta_exposure") or 0)
            margin = float(pos.get("margin_required") or 0)
            premium = float(pos.get("net_premium") or 0)
            max_loss = float(pos.get("max_loss") or 0)

            # Compute live/actual PnL using Greeks approximation
            live_spot = current_spot if current_spot else spot_entry
            spot_move = live_spot - spot_entry
            spot_move_pct = spot_move / max(spot_entry, 1e-8)

            # Taylor expansion: PnL ≈ delta * dS + 0.5 * gamma * dS^2 + theta * dt
            # For simplicity, use spot_move as dS (normalised by lot)
            actual_pnl = delta * spot_move_pct * spot_entry + 0.5 * gamma * (spot_move_pct ** 2) * spot_entry
            # Cap loss at max_loss
            actual_pnl = max(-abs(max_loss), actual_pnl + premium)

            # Recompute VaR/ES from stored PnL distribution shifted by spot move
            pnl_dist = pos.get("pnl_distribution", [])
            if isinstance(pnl_dist, list) and len(pnl_dist) > 10:
                import numpy as np
                arr = np.array(pnl_dist, dtype=float)
                shifted = arr + delta * spot_move_pct * spot_entry
                actual_var95 = float(np.percentile(shifted, 5))
                actual_var99 = float(np.percentile(shifted, 1))
                actual_es = float(np.mean(shifted[shifted <= actual_var99])) if np.sum(shifted <= actual_var99) > 0 else actual_var99
                actual_ev = float(np.mean(shifted))
                actual_prob_loss = float(np.mean(shifted < 0))
            else:
                actual_var95 = float(pos.get("var_95") or 0)
                actual_var99 = float(pos.get("var_99") or 0)
                actual_es = float(pos.get("expected_shortfall") or 0)
                actual_ev = actual_pnl
                actual_prob_loss = float(pos.get("probability_of_loss") or 0)

            revalued_pos = {
                **pos,
                "live_spot": live_spot,
                "spot_change": spot_move,
                "spot_change_pct": round(spot_move_pct * 100, 4),
                "actual_pnl": round(actual_pnl, 4),
                "actual_ev": round(actual_ev, 4),
                "actual_var95": round(actual_var95, 4),
                "actual_var99": round(actual_var99, 4),
                "actual_es": round(actual_es, 4),
                "actual_prob_loss": round(actual_prob_loss, 4),
                "expected_pnl": expected_ev,
            }
            revalued.append(revalued_pos)

            totals["expected_pnl"] += expected_ev
            totals["actual_pnl"] += actual_pnl
            totals["delta"] += delta
            totals["gamma"] += gamma
            totals["vega"] += vega
            totals["theta"] += theta
            totals["margin"] += margin

        _logger.info("END | portfolio_revalue | positions=%d", len(revalued))
        return {"status": "ok", "data": {"positions": revalued, "totals": totals, "live_spot": current_spot}}
    except Exception as exc:
        _logger.exception("ERROR | portfolio_revalue")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
