from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

from ..logger import get_logger
from .gemini_client import GeminiClient


class StrategyPickerAgent:
    """
    Deterministic strategy selector with optional LLM explanation.
    Uses current pipeline snapshot (market/regime/top strategies) and returns
    a compact recommendation packet suitable for UI rendering.
    """

    def __init__(self, llm_client: Optional[GeminiClient] = None) -> None:
        self._logger = get_logger(self.__class__.__name__)
        self._client = llm_client or GeminiClient()

    @staticmethod
    def _to_num(value: Any, default: float = 0.0) -> float:
        try:
            out = float(value)
            if out != out:  # NaN
                return default
            return out
        except Exception:
            return default

    @staticmethod
    def _safe_strategy_view(item: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": item.get("id"),
            "strategy_type": item.get("strategy_type"),
            "legs_label": item.get("legs_label"),
            "expiry_date": item.get("expiry_date"),
            "expected_value": item.get("expected_value"),
            "return_on_margin": item.get("return_on_margin"),
            "probability_of_loss": item.get("probability_of_loss"),
            "var_95": item.get("var_95"),
            "var_99": item.get("var_99"),
            "expected_shortfall": item.get("expected_shortfall"),
            "max_loss": item.get("max_loss"),
            "fragility_score": item.get("fragility_score"),
            "overall_score": item.get("overall_score"),
            "bid_ask_spread_pct": item.get("bid_ask_spread_pct"),
            "liquidity_warning": item.get("liquidity_warning"),
        }

    @staticmethod
    def _preferred_families(regime_label: str, iv_rank: float, iv_rv_spread: float) -> List[str]:
        high_iv = iv_rank >= 70 or iv_rv_spread > 0
        low_iv = iv_rank <= 40 or iv_rv_spread < 0
        if regime_label == "high_vol" or high_iv:
            return [
                "Iron Condor",
                "Iron Butterfly",
                "Bear Call Spread",
                "Bull Put Spread",
                "Protective Collar",
                "Covered Call",
                "Cash Secured Put",
            ]
        if regime_label == "low_vol" and low_iv:
            return [
                "Long Straddle",
                "Long Strangle",
                "Bull Call Spread",
                "Bear Put Spread",
                "Long Call",
                "Long Put",
            ]
        return [
            "Bull Call Spread",
            "Bear Put Spread",
            "Iron Condor",
            "Protective Put",
            "Protective Collar",
        ]

    def _score_one(self, item: Dict[str, Any], preferred_families: List[str]) -> Tuple[float, List[str]]:
        reasons: List[str] = []
        score = self._to_num(item.get("overall_score"), 0.0)

        stype = str(item.get("strategy_type") or "")
        if any(stype.startswith(fam) for fam in preferred_families):
            score += 0.15
            reasons.append("Fits current volatility regime template")

        p_loss = self._to_num(item.get("probability_of_loss"), 1.0)
        if p_loss > 0.65:
            score -= 0.20
            reasons.append("High probability of loss")
        else:
            reasons.append("Loss probability is within acceptable band")

        frag = self._to_num(item.get("fragility_score"), 1e9)
        if frag > 120:
            score -= 0.20
            reasons.append("Fragility is elevated")
        else:
            reasons.append("Fragility is controlled")

        spread = self._to_num(item.get("bid_ask_spread_pct"), 999.0)
        if spread > 2.0 or bool(item.get("liquidity_warning")):
            score -= 0.15
            reasons.append("Liquidity/spread warning")
        else:
            reasons.append("Liquidity appears tradable")

        ev = self._to_num(item.get("expected_value"), -1e9)
        if ev <= 0:
            score -= 0.30
            reasons.append("Negative expected value")
        else:
            reasons.append("Positive expected value")

        rom = self._to_num(item.get("return_on_margin"), -1e9)
        if rom < 0:
            score -= 0.15
            reasons.append("Negative return on margin")
        else:
            reasons.append("Return on margin is supportive")

        return score, reasons

    @staticmethod
    def _extract_json_payload(text: str) -> Optional[Dict[str, Any]]:
        if not text:
            return None
        fenced = re.search(r"```json\s*([\s\S]*?)```", text, flags=re.IGNORECASE)
        candidate = fenced.group(1).strip() if fenced else text.strip()
        try:
            data = json.loads(candidate)
            if isinstance(data, dict):
                return data
        except Exception:
            return None
        return None

    def pick(
        self,
        pipeline_data: Dict[str, Any],
        model_id: str = "gemma3:1b",
        max_candidates: int = 3,
    ) -> Dict[str, Any]:
        strategies = list(pipeline_data.get("top_strategies") or [])
        market = dict(pipeline_data.get("market_overview") or {})
        regime = dict(pipeline_data.get("regime") or {})

        if not strategies:
            raise ValueError("No strategies available in pipeline data.")

        regime_label = str(regime.get("label") or "unknown")
        iv_rank = self._to_num(market.get("iv_rank"), 50.0)
        iv_rv_spread = self._to_num(market.get("realized_implied_spread"), 0.0)
        preferred = self._preferred_families(regime_label, iv_rank, iv_rv_spread)

        ranked: List[Tuple[float, Dict[str, Any], List[str]]] = []
        rejected: List[Dict[str, Any]] = []

        for raw in strategies:
            score, reasons = self._score_one(raw, preferred)
            row = self._safe_strategy_view(raw)
            row["agent_score"] = round(score, 6)
            ranked.append((score, row, reasons))

            if score < -0.20:
                rejected.append({
                    "strategy_type": row.get("strategy_type"),
                    "legs_label": row.get("legs_label"),
                    "agent_score": row.get("agent_score"),
                    "reason": "; ".join(reasons[:2]),
                })

        ranked.sort(key=lambda x: x[0], reverse=True)
        top = ranked[: max(1, int(max_candidates))]
        primary = top[0][1]
        primary_reasons = top[0][2][:3]
        alternatives = [entry[1] for entry in top[1:]]

        llm_summary = ""
        llm_bullets: List[str] = []
        llm_risks: List[str] = []
        compact_payload = {
            "regime": {
                "label": regime_label,
                "confidence": self._to_num(regime.get("confidence"), 0.0),
            },
            "market": {
                "spot": self._to_num(market.get("spot"), 0.0),
                "atm_market_iv": self._to_num(market.get("atm_market_iv"), 0.0),
                "rv_20d": self._to_num(market.get("rv_20d"), 0.0),
                "iv_rank": iv_rank,
                "iv_percentile": self._to_num(market.get("iv_percentile"), 0.0),
                "iv_rv_spread": iv_rv_spread,
            },
            "preferred_families": preferred,
            "candidates": [item[1] for item in top[:3]],
        }

        system_prompt = (
            "You are a strict options strategy selector. Return only JSON with keys: "
            "summary, why_bullets (list), risk_flags (list), confidence (0-100). "
            "Keep output factual, concise, and execution-focused."
        )
        user_prompt = (
            "Select the best strategy for current market context from these shortlisted candidates.\n"
            "Explain why in simple language.\n"
            f"DATA:\n{json.dumps(compact_payload, separators=(',', ':'))}"
        )

        try:
            llm_text = self._client.generate(
                system_instruction=system_prompt,
                user_prompt=user_prompt,
                temperature=0.15,
                max_output_tokens=512,
                history=None,
                model_id=model_id,
            )
            parsed = self._extract_json_payload(llm_text) or {}
            llm_summary = str(parsed.get("summary") or "").strip()
            llm_bullets = [str(x) for x in (parsed.get("why_bullets") or [])][:4]
            llm_risks = [str(x) for x in (parsed.get("risk_flags") or [])][:4]
            llm_conf = self._to_num(parsed.get("confidence"), 70.0)
        except Exception as exc:
            self._logger.warning("STRATEGY_PICKER_LLM_FALLBACK | error=%s", exc)
            llm_conf = 70.0

        if not llm_summary:
            llm_summary = "Rule-based engine selected the highest regime-fit strategy after risk and liquidity penalties."
        if not llm_bullets:
            llm_bullets = primary_reasons

        confidence = max(1.0, min(99.0, llm_conf))

        return {
            "model_used": model_id,
            "regime_view": {
                "label": regime_label,
                "iv_rank": iv_rank,
                "iv_rv_spread": iv_rv_spread,
                "preferred_families": preferred,
            },
            "primary": primary,
            "alternatives": alternatives,
            "why_bullets": llm_bullets,
            "risk_flags": llm_risks,
            "rejected": rejected[:5],
            "summary": llm_summary,
            "confidence": round(confidence, 1),
        }
