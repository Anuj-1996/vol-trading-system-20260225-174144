"""
NSE India API client with session management, cookie handling, and rate limiting.

Based on the proven approach from NSE-Option-Chain-Analyzer:
  - Hit /option-chain page to acquire cookies
  - Pass cookies EXPLICITLY on every API call (not session-level)
  - Use the v3 API endpoint (option-chain-v3) which is current
  - Reset session on 401 errors
  - Minimal headers to avoid bot detection
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import requests

from ..decorators import log_execution_time
from ..exceptions import DataIngestionError
from ..logger import get_logger

_logger = get_logger(__name__)

_BASE_URL = "https://www.nseindia.com"
_OPTION_CHAIN_PAGE = f"{_BASE_URL}/option-chain"

# V3 API endpoints (current, used by NSE-Option-Chain-Analyzer)
_OC_CONTRACT_INFO_URL = f"{_BASE_URL}/api/option-chain-contract-info"
_OC_V3_INDEX_URL = f"{_BASE_URL}/api/option-chain-v3"

# Legacy endpoint (fallback)
_OC_LEGACY_URL = f"{_BASE_URL}/api/option-chain-indices"

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
}

# Minimum seconds between consecutive API calls
_MIN_REQUEST_GAP_SECONDS = 1.5

# Session cookie TTL in seconds
_SESSION_TTL_SECONDS = 90

# Retry configuration
_MAX_RETRIES = 3
_RETRY_BACKOFF_BASE = 2.0

# Request timeout in seconds
_REQUEST_TIMEOUT = 15


@dataclass
class NSEClient:
    """Persistent session client for NSE India delayed option chain API.

    Key design choice (matching NSE-Option-Chain-Analyzer):
    Cookies are captured from the /option-chain page visit and then passed
    EXPLICITLY on every API call rather than relying on session cookies.
    """

    _session: requests.Session = field(default_factory=requests.Session, init=False, repr=False)
    _cookies: Dict[str, str] = field(default_factory=dict, init=False, repr=False)
    _session_init_time: float = field(default=0.0, init=False, repr=False)
    _last_request_time: float = field(default=0.0, init=False, repr=False)

    def __post_init__(self) -> None:
        self._session.headers.update(_HEADERS)

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    def _init_session(self) -> None:
        """Hit NSE option-chain page to acquire cookies, then store them
        for explicit passing on API calls (matching Varun's pattern)."""
        _logger.info("NSE_SESSION_INIT | acquiring cookies from %s", _OPTION_CHAIN_PAGE)

        # Recreate session for clean state
        self._session.close()
        self._session = requests.Session()
        self._session.headers.update(_HEADERS)

        try:
            response = self._session.get(
                _OPTION_CHAIN_PAGE,
                timeout=_REQUEST_TIMEOUT,
            )
            response.raise_for_status()

            # Extract cookies as plain dict for explicit passing
            self._cookies = dict(response.cookies)
            self._session_init_time = time.monotonic()

            _logger.info(
                "NSE_SESSION_INIT | success | cookies=%s",
                list(self._cookies.keys()),
            )
        except requests.RequestException as exc:
            _logger.error("NSE_SESSION_INIT | failed | error=%s", exc)
            raise DataIngestionError(
                message="Failed to initialize NSE session (site may be down or blocking)",
                context={"url": _OPTION_CHAIN_PAGE, "error": str(exc)},
            ) from exc

    def _ensure_session(self) -> None:
        """Re-initialize session if cookies are stale or missing."""
        elapsed = time.monotonic() - self._session_init_time
        if self._session_init_time == 0.0 or elapsed > _SESSION_TTL_SECONDS or not self._cookies:
            self._init_session()

    def _reset_session(self) -> None:
        """Force a full session reset (e.g. after 401)."""
        _logger.info("NSE_SESSION_RESET | forcing full re-init")
        self._session_init_time = 0.0
        self._cookies = {}
        self._init_session()

    def _rate_limit(self) -> None:
        """Enforce minimum gap between consecutive API requests."""
        if self._last_request_time > 0.0:
            gap = time.monotonic() - self._last_request_time
            if gap < _MIN_REQUEST_GAP_SECONDS:
                sleep_time = _MIN_REQUEST_GAP_SECONDS - gap
                _logger.debug("NSE_RATE_LIMIT | sleeping %.2fs", sleep_time)
                time.sleep(sleep_time)

    # ------------------------------------------------------------------
    # Core request with retry
    # ------------------------------------------------------------------

    def _get_json(self, url: str, params: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        """
        GET request with explicit cookie passing, retry, and rate limiting.
        Resets session on 401 (matching NSE-OCA pattern).
        """
        last_error: Optional[Exception] = None

        for attempt in range(1, _MAX_RETRIES + 1):
            self._ensure_session()
            self._rate_limit()

            try:
                _logger.info(
                    "NSE_REQUEST | attempt=%d | url=%s | params=%s",
                    attempt, url, params,
                )
                response = self._session.get(
                    url,
                    params=params,
                    timeout=_REQUEST_TIMEOUT,
                    cookies=self._cookies,  # Explicit cookie passing
                )
                self._last_request_time = time.monotonic()

                # 401 → full session reset (NSE-OCA pattern)
                if response.status_code == 401:
                    _logger.warning("NSE_REQUEST | 401 | resetting session")
                    self._reset_session()
                    continue

                # 403 → retry with session refresh
                if response.status_code == 403:
                    _logger.warning("NSE_REQUEST | 403 | attempt=%d", attempt)
                    self._reset_session()
                    time.sleep(_RETRY_BACKOFF_BASE ** attempt)
                    continue

                if response.status_code >= 500:
                    _logger.warning("NSE_REQUEST | server_error=%d", response.status_code)
                    time.sleep(_RETRY_BACKOFF_BASE ** attempt)
                    continue

                response.raise_for_status()
                data = response.json()

                # NSE returns empty {} when bot-detected — treat as retry
                if isinstance(data, dict) and not data:
                    _logger.warning("NSE_REQUEST | empty_response | attempt=%d | resetting", attempt)
                    self._reset_session()
                    time.sleep(_RETRY_BACKOFF_BASE ** attempt)
                    continue

                _logger.info(
                    "NSE_REQUEST | success | keys=%s",
                    list(data.keys()) if isinstance(data, dict) else type(data).__name__,
                )
                return data

            except requests.RequestException as exc:
                last_error = exc
                _logger.warning("NSE_REQUEST | exception=%s | attempt=%d", exc, attempt)
                self._reset_session()
                if attempt < _MAX_RETRIES:
                    time.sleep(_RETRY_BACKOFF_BASE ** attempt)

        raise DataIngestionError(
            message="NSE API request failed after all retries",
            context={
                "url": url,
                "params": params,
                "retries": _MAX_RETRIES,
                "last_error": str(last_error),
            },
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @log_execution_time
    def get_option_chain(self, symbol: str = "NIFTY") -> Dict[str, Any]:
        """
        Fetch option chain metadata (expiry dates + available strikes).

        Uses contract-info endpoint which reliably returns metadata.
        For actual chain data with prices/IV/OI, use get_option_chain_for_expiry().
        """
        return self._get_json(
            _OC_CONTRACT_INFO_URL,
            params={"symbol": symbol},
        )

    @log_execution_time
    def get_option_chain_v3(
        self,
        symbol: str = "NIFTY",
        expiry_date: Optional[str] = None,
        oc_type: str = "Indices",
    ) -> Dict[str, Any]:
        """
        Fetch option chain via the V3 API.

        Parameters
        ----------
        symbol : str
            Index or stock symbol
        expiry_date : str or None
            If provided, filter to this expiry (e.g., "05-Mar-2026")
        oc_type : str
            "Indices" or "Equity"
        """
        params: Dict[str, str] = {"type": oc_type, "symbol": symbol}
        if expiry_date:
            params["expiry"] = expiry_date

        return self._get_json(_OC_V3_INDEX_URL, params=params)

    @log_execution_time
    def get_expiry_dates(self, symbol: str = "NIFTY") -> List[str]:
        """Fetch available expiry dates for a symbol."""
        data = self.get_option_chain(symbol=symbol)

        # Try multiple locations for expiry dates
        expiry_dates = data.get("expiryDates", [])
        if not expiry_dates:
            records = data.get("records", {})
            expiry_dates = records.get("expiryDates", [])

        if not expiry_dates:
            # Extract from data entries
            entries = data.get("records", {}).get("data", data.get("data", []))
            if isinstance(entries, list):
                seen: set = set()
                for entry in entries:
                    exp = entry.get("expiryDate", "")
                    if exp and exp not in seen:
                        seen.add(exp)
                        expiry_dates.append(exp)

        _logger.info("NSE_EXPIRIES | symbol=%s | count=%d | dates=%s", symbol, len(expiry_dates), expiry_dates[:6])
        return expiry_dates

    @log_execution_time
    def get_option_chain_for_expiry(self, symbol: str, expiry_date: str) -> Dict[str, Any]:
        """
        Fetch option chain data for a specific expiry.

        Uses V3 API with expiry parameter. Falls back to fetching all and
        filtering client-side.
        """
        # Try V3 with expiry filter first
        try:
            data = self.get_option_chain_v3(
                symbol=symbol,
                expiry_date=expiry_date,
                oc_type="Indices",
            )
            records = data.get("records", data)
            entries = records.get("data", [])
            underlying_value = records.get("underlyingValue", 0.0)
            timestamp = records.get("timestamp", "")

            if entries:
                _logger.info(
                    "NSE_CHAIN_V3 | symbol=%s | expiry=%s | entries=%d | spot=%.2f",
                    symbol, expiry_date, len(entries), underlying_value,
                )
                return {
                    "data": entries,
                    "underlyingValue": underlying_value,
                    "timestamp": timestamp,
                    "expiryDate": expiry_date,
                }
        except DataIngestionError:
            _logger.info("NSE_V3_EXPIRY | failed, falling back to full fetch + filter")

        # Fallback: fetch all, filter client-side
        full_data = self.get_option_chain(symbol=symbol)
        records = full_data.get("records", {})
        all_entries = records.get("data", [])
        underlying_value = records.get("underlyingValue", 0.0)
        timestamp = records.get("timestamp", "")

        filtered = [
            entry for entry in all_entries
            if entry.get("expiryDate", "") == expiry_date
        ]

        _logger.info(
            "NSE_CHAIN_FILTER | symbol=%s | expiry=%s | total=%d | filtered=%d | spot=%.2f",
            symbol, expiry_date, len(all_entries), len(filtered), underlying_value,
        )

        return {
            "data": filtered,
            "underlyingValue": underlying_value,
            "timestamp": timestamp,
            "expiryDate": expiry_date,
        }

    def close(self) -> None:
        """Close the underlying requests session."""
        self._session.close()
        _logger.info("NSE_SESSION_CLOSED")
