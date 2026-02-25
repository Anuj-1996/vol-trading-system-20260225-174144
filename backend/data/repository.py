from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable

from ..decorators import log_execution_time
from ..logger import get_logger
from .models import OptionChainRawRecord


class OptionChainRepository:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._logger = get_logger(self.__class__.__name__)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self._db_path)

    @log_execution_time
    def ensure_schema(self) -> None:
        self._logger.info("START | ensure_schema")
        ddl = """
        CREATE TABLE IF NOT EXISTS option_chain_raw (
            trade_date TEXT NOT NULL,
            expiry TEXT NOT NULL,
            strike REAL NOT NULL,
            call_price REAL NOT NULL,
            put_price REAL NOT NULL,
            call_iv REAL NOT NULL,
            put_iv REAL NOT NULL,
            volume REAL NOT NULL,
            open_interest REAL NOT NULL,
            call_bid REAL NOT NULL,
            call_ask REAL NOT NULL,
            put_bid REAL NOT NULL,
            put_ask REAL NOT NULL,
            PRIMARY KEY (trade_date, expiry, strike)
        );
        """
        with self._connect() as connection:
            connection.execute(ddl)
            connection.commit()
        self._logger.info("END | ensure_schema")

    @log_execution_time
    def upsert_raw_records(self, records: Iterable[OptionChainRawRecord]) -> int:
        payload = [
            (
                item.trade_date.isoformat(),
                item.expiry.isoformat(),
                item.strike,
                item.call_price,
                item.put_price,
                item.call_iv,
                item.put_iv,
                item.volume,
                item.open_interest,
                item.call_bid,
                item.call_ask,
                item.put_bid,
                item.put_ask,
            )
            for item in records
        ]
        self._logger.info("START | upsert_raw_records | record_count=%d", len(payload))
        if not payload:
            self._logger.info("END | upsert_raw_records | record_count=0")
            return 0

        dml = """
        INSERT INTO option_chain_raw (
            trade_date, expiry, strike, call_price, put_price, call_iv, put_iv,
            volume, open_interest, call_bid, call_ask, put_bid, put_ask
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(trade_date, expiry, strike) DO UPDATE SET
            call_price=excluded.call_price,
            put_price=excluded.put_price,
            call_iv=excluded.call_iv,
            put_iv=excluded.put_iv,
            volume=excluded.volume,
            open_interest=excluded.open_interest,
            call_bid=excluded.call_bid,
            call_ask=excluded.call_ask,
            put_bid=excluded.put_bid,
            put_ask=excluded.put_ask;
        """
        with self._connect() as connection:
            connection.executemany(dml, payload)
            connection.commit()
        self._logger.info("END | upsert_raw_records | inserted_or_updated=%d", len(payload))
        return len(payload)
