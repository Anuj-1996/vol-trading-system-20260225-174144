from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from .config import CONFIG


_HANDLER_NAME_FILE = "vol_engine_file"
_HANDLER_NAME_CONSOLE = "vol_engine_console"


def _build_formatter() -> logging.Formatter:
    return logging.Formatter(CONFIG.logging.format)


def _build_file_handler() -> logging.FileHandler:
    log_dir: Path = CONFIG.logging.directory
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / CONFIG.logging.filename
    handler = logging.FileHandler(log_file)
    handler.set_name(_HANDLER_NAME_FILE)
    handler.setFormatter(_build_formatter())
    return handler


def _build_console_handler() -> logging.StreamHandler:
    handler = logging.StreamHandler()
    handler.set_name(_HANDLER_NAME_CONSOLE)
    handler.setFormatter(_build_formatter())
    return handler


def _ensure_logger_handlers(logger: logging.Logger, level: int) -> None:
    logger.setLevel(level)
    logger.propagate = False

    handler_names = {handler.get_name() for handler in logger.handlers}
    if _HANDLER_NAME_CONSOLE not in handler_names:
        console_handler = _build_console_handler()
        console_handler.setLevel(level)
        logger.addHandler(console_handler)
    if _HANDLER_NAME_FILE not in handler_names:
        file_handler = _build_file_handler()
        file_handler.setLevel(level)
        logger.addHandler(file_handler)


def configure_logging(level: Optional[str] = None) -> None:
    log_level = getattr(logging, (level or CONFIG.logging.level).upper(), logging.INFO)
    app_logger = logging.getLogger("vol_engine")
    _ensure_logger_handlers(app_logger, log_level)
    app_logger.info("LOGGER_READY | level=%s | file=%s", logging.getLevelName(log_level), CONFIG.logging.directory / CONFIG.logging.filename)


def get_logger(name: str) -> logging.Logger:
    log_level = getattr(logging, CONFIG.logging.level.upper(), logging.INFO)
    logger = logging.getLogger(name)
    _ensure_logger_handlers(logger, log_level)
    return logger
