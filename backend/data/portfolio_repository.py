"""Portfolio persistence layer – SQLite backed.

Stores portfolio positions with their original/expected metrics at the time
of addition.  Live/actual metrics are computed on-the-fly at revaluation time
and returned alongside the stored expected values for comparison.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..logger import get_logger

_logger = get_logger("PortfolioRepository")

DB_PATH = Path("backend/portfolio.db")


def _connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def ensure_schema(db_path: Path = DB_PATH) -> None:
    """Create the portfolio table if it doesn't exist."""
    ddl = """
    CREATE TABLE IF NOT EXISTS portfolio_positions (
        id              TEXT PRIMARY KEY,
        added_at        TEXT NOT NULL,
        strategy_type   TEXT NOT NULL,
        strikes         TEXT NOT NULL,
        legs_label      TEXT,
        expiry_date     TEXT,
        maturity_T      REAL,
        spot_at_entry   REAL NOT NULL,
        net_premium     REAL,
        cost            REAL,
        margin_required REAL,
        expected_value  REAL,
        var_95          REAL,
        var_99          REAL,
        expected_shortfall REAL,
        return_on_margin   REAL,
        probability_of_loss REAL,
        pnl_kurtosis    REAL,
        max_loss        REAL,
        delta_exposure  REAL,
        gamma_exposure  REAL,
        vega_exposure   REAL,
        theta_exposure  REAL,
        skew_exposure   REAL,
        fragility_score REAL,
        overall_score   REAL,
        break_even_levels TEXT,
        pnl_distribution TEXT,
        legs            TEXT,
        notes           TEXT DEFAULT '',
        status          TEXT DEFAULT 'open'
    );
    """
    with _connect(db_path) as conn:
        conn.execute(ddl)
        conn.commit()
    _logger.info("Portfolio schema ensured at %s", db_path)


def add_position(strategy: Dict[str, Any], spot: float, db_path: Path = DB_PATH) -> Dict[str, Any]:
    """Insert a strategy into the portfolio. Returns the stored row."""
    ensure_schema(db_path)
    pos_id = str(uuid.uuid4())[:12]
    now = datetime.utcnow().isoformat()

    strikes_json = json.dumps(strategy.get("strikes", []))
    be_json = json.dumps(strategy.get("break_even_levels", []))
    pnl_json = json.dumps(strategy.get("pnl_distribution", [])[:500])  # cap storage
    legs_json = json.dumps(strategy.get("legs", []))

    with _connect(db_path) as conn:
        conn.execute(
            """INSERT INTO portfolio_positions (
                id, added_at, strategy_type, strikes, legs_label, expiry_date, maturity_T,
                spot_at_entry, net_premium, cost, margin_required,
                expected_value, var_95, var_99, expected_shortfall, return_on_margin,
                probability_of_loss, pnl_kurtosis, max_loss,
                delta_exposure, gamma_exposure, vega_exposure, theta_exposure, skew_exposure,
                fragility_score, overall_score, break_even_levels, pnl_distribution, legs, status
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                pos_id, now, strategy.get("strategy_type", ""),
                strikes_json, strategy.get("legs_label", ""),
                strategy.get("expiry_date"), strategy.get("maturity_T"),
                spot,
                strategy.get("net_premium"), strategy.get("cost"),
                strategy.get("margin_required"),
                strategy.get("expected_value"),
                strategy.get("var_95"), strategy.get("var_99"),
                strategy.get("expected_shortfall"),
                strategy.get("return_on_margin"),
                strategy.get("probability_of_loss"),
                strategy.get("pnl_kurtosis"), strategy.get("max_loss"),
                strategy.get("delta_exposure"), strategy.get("gamma_exposure"),
                strategy.get("vega_exposure"), strategy.get("theta_exposure"),
                strategy.get("skew_exposure"),
                strategy.get("fragility_score"), strategy.get("overall_score"),
                be_json, pnl_json, legs_json, "open",
            ),
        )
        conn.commit()
    _logger.info("Added position %s | %s | strikes=%s", pos_id, strategy.get("strategy_type"), strikes_json)
    return get_position(pos_id, db_path)


def get_position(pos_id: str, db_path: Path = DB_PATH) -> Optional[Dict[str, Any]]:
    """Fetch a single position by ID."""
    ensure_schema(db_path)
    with _connect(db_path) as conn:
        row = conn.execute("SELECT * FROM portfolio_positions WHERE id = ?", (pos_id,)).fetchone()
    if row is None:
        return None
    return _row_to_dict(row)


def list_positions(status: str = "open", db_path: Path = DB_PATH) -> List[Dict[str, Any]]:
    """Fetch all positions with given status."""
    ensure_schema(db_path)
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM portfolio_positions WHERE status = ? ORDER BY added_at DESC", (status,)
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def delete_position(pos_id: str, db_path: Path = DB_PATH) -> bool:
    """Hard-delete a position from the portfolio."""
    ensure_schema(db_path)
    with _connect(db_path) as conn:
        cursor = conn.execute("DELETE FROM portfolio_positions WHERE id = ?", (pos_id,))
        conn.commit()
    deleted = cursor.rowcount > 0
    _logger.info("Delete position %s -> %s", pos_id, "ok" if deleted else "not found")
    return deleted


def close_position(pos_id: str, db_path: Path = DB_PATH) -> bool:
    """Mark a position as closed (soft-delete)."""
    ensure_schema(db_path)
    with _connect(db_path) as conn:
        cursor = conn.execute(
            "UPDATE portfolio_positions SET status = 'closed' WHERE id = ?", (pos_id,)
        )
        conn.commit()
    return cursor.rowcount > 0


def clear_all(db_path: Path = DB_PATH) -> int:
    """Delete ALL positions. Returns count deleted."""
    ensure_schema(db_path)
    with _connect(db_path) as conn:
        cursor = conn.execute("DELETE FROM portfolio_positions")
        conn.commit()
    _logger.info("Cleared all portfolio positions: %d", cursor.rowcount)
    return cursor.rowcount


def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    """Convert a DB row into a rich dict with parsed JSON fields."""
    d = dict(row)
    for key in ("strikes", "break_even_levels", "pnl_distribution", "legs"):
        val = d.get(key)
        if isinstance(val, str):
            try:
                d[key] = json.loads(val)
            except (json.JSONDecodeError, TypeError):
                pass
    return d
