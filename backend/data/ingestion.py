from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple

import pandas as pd

from ..decorators import log_execution_time
from ..exceptions import DataIngestionError
from ..logger import get_logger
from .models import OptionChainRawRecord


class OptionChainIngestionService:
    REQUIRED_COLUMNS = (
        "Strike",
        "Call LTP",
        "Put LTP",
        "Call OI",
        "Put OI",
        "Call Volume",
        "Put Volume",
        "Call Bid Price",
        "Call Offer Price",
        "Put Bid Price",
        "Put Offer Price",
    )

    CALL_IV_CANDIDATES = ("Call IV", "Call IV %", "call_iv")
    PUT_IV_CANDIDATES = ("Put IV", "Put IV %", "put_iv")
    SHARED_IV_CANDIDATES = ("IV", "IV %", "iv")

    FILENAME_REGEX = re.compile(r"NIFTY_(\d{4}-\d{2}-\d{2})_option_chain_(\d{4}-\d{2}-\d{2})")

    def __init__(self) -> None:
        self._logger = get_logger(self.__class__.__name__)

    @staticmethod
    def _to_float(value: object) -> float:
        if value is None:
            return 0.0
        text = str(value).strip()
        if text in {"", "--", "nan", "NaN", "None"}:
            return 0.0
        return float(text.replace(",", ""))

    def _extract_dates_from_filename(self, file_path: Path) -> Tuple[datetime, datetime]:
        match = self.FILENAME_REGEX.search(file_path.name)
        if match is None:
            raise DataIngestionError(
                message="Unable to parse expiry/trade date from filename",
                context={"file": str(file_path)},
            )

        expiry_dt = datetime.strptime(match.group(1), "%Y-%m-%d")
        trade_dt = datetime.strptime(match.group(2), "%Y-%m-%d")
        return expiry_dt, trade_dt

    def _validate_schema(self, frame: pd.DataFrame, file_path: Path) -> None:
        missing = [column for column in self.REQUIRED_COLUMNS if column not in frame.columns]
        if missing:
            raise DataIngestionError(
                message="CSV schema validation failed",
                context={"file": str(file_path), "missing_columns": missing},
            )

    @staticmethod
    def _find_first_existing(candidates: Tuple[str, ...], columns: List[str]) -> str | None:
        for candidate in candidates:
            if candidate in columns:
                return candidate
        return None

    def _resolve_iv_columns(self, frame: pd.DataFrame, file_path: Path) -> Tuple[str, str, bool]:
        columns = frame.columns.tolist()
        call_iv_column = self._find_first_existing(self.CALL_IV_CANDIDATES, columns)
        put_iv_column = self._find_first_existing(self.PUT_IV_CANDIDATES, columns)

        if call_iv_column is not None and put_iv_column is not None:
            return call_iv_column, put_iv_column, False

        shared_iv_column = self._find_first_existing(self.SHARED_IV_CANDIDATES, columns)
        if shared_iv_column is not None:
            self._logger.warning(
                "IV_FALLBACK | file=%s | using_shared_column=%s for call_iv and put_iv",
                file_path,
                shared_iv_column,
            )
            return shared_iv_column, shared_iv_column, True

        raise DataIngestionError(
            message="IV schema validation failed",
            context={
                "file": str(file_path),
                "required": {
                    "separate": [self.CALL_IV_CANDIDATES, self.PUT_IV_CANDIDATES],
                    "fallback": self.SHARED_IV_CANDIDATES,
                },
            },
        )

    @staticmethod
    def _read_frame(file_path: Path) -> pd.DataFrame:
        suffix = file_path.suffix.lower()
        if suffix == ".csv":
            return pd.read_csv(file_path)
        if suffix in {".xls", ".xlsx"}:
            return pd.read_excel(file_path)
        raise DataIngestionError(
            message="Unsupported file format",
            context={"file": str(file_path), "suffix": suffix, "supported": [".csv", ".xls", ".xlsx"]},
        )

    @log_execution_time
    def parse_file(self, file_path: Path) -> List[OptionChainRawRecord]:
        self._logger.info("START | parse_file | file=%s", file_path)
        try:
            frame = self._read_frame(file_path)
            self._validate_schema(frame=frame, file_path=file_path)
            expiry_dt, trade_dt = self._extract_dates_from_filename(file_path=file_path)
            call_iv_column, put_iv_column, is_shared_iv = self._resolve_iv_columns(frame=frame, file_path=file_path)

            records: List[OptionChainRawRecord] = []
            for row in frame.to_dict(orient="records"):
                strike = self._to_float(row["Strike"])
                call_volume = self._to_float(row["Call Volume"])
                put_volume = self._to_float(row["Put Volume"])
                call_oi = self._to_float(row["Call OI"])
                put_oi = self._to_float(row["Put OI"])

                record = OptionChainRawRecord(
                    trade_date=trade_dt.date(),
                    expiry=expiry_dt.date(),
                    strike=strike,
                    call_price=self._to_float(row["Call LTP"]),
                    put_price=self._to_float(row["Put LTP"]),
                    call_iv=self._to_float(row[call_iv_column]),
                    put_iv=self._to_float(row[put_iv_column]),
                    volume=call_volume + put_volume,
                    open_interest=call_oi + put_oi,
                    call_bid=self._to_float(row["Call Bid Price"]),
                    call_ask=self._to_float(row["Call Offer Price"]),
                    put_bid=self._to_float(row["Put Bid Price"]),
                    put_ask=self._to_float(row["Put Offer Price"]),
                    call_oi=call_oi,
                    put_oi=put_oi,
                    call_volume=call_volume,
                    put_volume=put_volume,
                )
                records.append(record)

            self._logger.info(
                "END | parse_file | file=%s | records=%d | trade_date=%s | expiry=%s",
                file_path,
                len(records),
                trade_dt.date().isoformat(),
                expiry_dt.date().isoformat(),
            )
            self._logger.info(
                "IV_MAPPING | file=%s | call_iv_column=%s | put_iv_column=%s | shared=%s",
                file_path,
                call_iv_column,
                put_iv_column,
                is_shared_iv,
            )
            return records
        except DataIngestionError:
            self._logger.exception("ERROR | parse_file | file=%s", file_path)
            raise
        except Exception as exc:
            self._logger.exception("ERROR | parse_file | file=%s", file_path)
            raise DataIngestionError(
                message="Unexpected ingestion parse failure",
                context={"file": str(file_path), "error": str(exc)},
            ) from exc

    @log_execution_time
    def discover_files(self, root_path: Path, pattern: str) -> List[Path]:
        self._logger.info("START | discover_files | root=%s | pattern=%s", root_path, pattern)
        files = sorted(root_path.glob(pattern))
        self._logger.info("END | discover_files | discovered=%d", len(files))
        return files

    @log_execution_time
    def build_ingestion_report(self, records: List[OptionChainRawRecord]) -> Dict[str, float]:
        self._logger.info("START | build_ingestion_report")
        if not records:
            return {"record_count": 0.0, "min_strike": 0.0, "max_strike": 0.0}

        strikes = [item.strike for item in records]
        report = {
            "record_count": float(len(records)),
            "min_strike": float(min(strikes)),
            "max_strike": float(max(strikes)),
        }
        self._logger.info("END | build_ingestion_report | report=%s", report)
        return report
