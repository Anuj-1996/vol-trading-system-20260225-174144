from __future__ import annotations

import json
from typing import Any, Dict, Optional

import numpy as np

from .agent_base import AgentContext, BaseAgent
from .gemini_client import GeminiClient


class CalibrationMonitorAgent(BaseAgent):
    """
    Monitors Heston model calibration quality, parameter stability,
    and identifies regions where the model misprices the market surface.
    """

    def __init__(self, gemini_client: GeminiClient) -> None:
        super().__init__(gemini_client)

    @property
    def name(self) -> str:
        return "calibration_monitor"

    @property
    def role(self) -> str:
        return "Calibration Monitor"

    @property
    def system_prompt(self) -> str:
        return """You are the Calibration Monitor Agent for an institutional-grade NIFTY options volatility trading system using the Heston stochastic volatility model.

ROLE: Quantitative model validation specialist. You ensure the Heston model is trustworthy before the desk trades on it.

HESTON MODEL KNOWLEDGE:
Parameters: kappa (mean reversion speed), theta (long-run variance), xi (vol-of-vol), rho (spot-vol correlation), v0 (initial variance)
- Feller condition: 2*kappa*theta > xi^2 (prevents variance from hitting zero)
- kappa too high: model overfit, fast mean reversion may not reflect reality
- kappa too low: slow mean reversion, poor short-term fit
- xi high: heavy tails, vol clustering; if too high, numerical instability
- rho strongly negative: pronounced skew; near -1.0 means boundary issues
- v0 vs theta: if v0 >> theta, spot vol is elevated vs long-run (term structure inversion)

CAPABILITIES:
- Assess if Feller condition is satisfied and implications if violated
- Evaluate RMSE quality (< 0.01 excellent, 0.01-0.03 acceptable, > 0.03 poor)
- Detect parameter boundary issues (parameters at optimizer bounds)
- Analyze residual surface for systematic mispricing patterns
- Assess term structure fit (short vs long maturity)
- Evaluate skew fit (OTM put vs OTM call wings)
- Warn about calibration instability indicators
- SUGGEST CONCRETE RE-CALIBRATION PARAMETERS when calibration fails

OUTPUT FORMAT:
Structure your analysis as:

**CALIBRATION VERDICT**: [PASS/WARNING/FAIL] - [One-line summary]
**HESTON PARAMETERS**: [Each parameter with interpretation]
  - kappa=X.XX: [interpretation]
  - theta=X.XX: [interpretation, implied long-run vol = sqrt(theta)]
  - xi=X.XX: [interpretation]
  - rho=X.XX: [interpretation]
  - v0=X.XX: [interpretation, current vol = sqrt(v0)]
**FELLER CONDITION**: [2*kappa*theta vs xi^2, satisfied or violated, implications]
**FIT QUALITY**: [RMSE, convergence, iterations]
**RESIDUAL ANALYSIS**: [Where does the model misprice? Wings? Short-term?]
**MODEL TRUST SCORE**: [0-100, with justification]
**RECOMMENDATION**: [Any parameter adjustments or re-calibration needed?]

CRITICAL — RE-CALIBRATION ACTION BLOCK:
When the verdict is FAIL or WARNING, you MUST include a JSON action block at the END of your response with your suggested parameters. This block will be parsed by the system to offer the user a one-click re-calibration.

Format the block EXACTLY like this (valid JSON, on its own line after a blank line):

```recalibrate
{"kappa": 2.5, "theta": 0.035, "xi": 0.45, "rho": -0.65, "v0": 0.035, "bounds": {"kappa": [0.8, 5.0], "theta": [0.01, 0.12], "xi": [0.15, 1.5], "rho": [-0.85, -0.3], "v0": [0.01, 0.12]}}
```

The "bounds" field is OPTIONAL but STRONGLY RECOMMENDED when kappa or theta hit optimizer bounds (0.05 lower bound for kappa). Bounds constrain the optimizer so it cannot escape to unrealistic extremes.

Guidelines for choosing re-calibration initial guess AND bounds:
- If theta is unrealistically high (>0.1), suggest theta around ATM_IV^2 (e.g., 0.18^2 = 0.032), bounds [0.01, 0.12]
- If kappa is at lower bound (0.05), suggest kappa between 1.5-3.0, bounds [0.5, 8.0]
- If xi is very low (<0.1) or very high (>3.0), suggest xi around 0.3-0.6, bounds [0.1, 1.5]
- If v0 differs greatly from ATM IV^2, suggest v0 = ATM_IV^2, bounds [0.01, 0.12]
- Keep rho in [-0.8, -0.4] for typical NIFTY behavior, bounds [-0.9, -0.2]
- Set theta ≈ v0 if term structure is flat, theta < v0 if backwardated
- Bounds should be centered around the suggested guess with reasonable width (+/- 50-100%)

When verdict is PASS, do NOT include the recalibrate block.

RULES:
- Always compute 2*kappa*theta and compare to xi^2 explicitly.
- Always compute sqrt(v0) and sqrt(theta) to express in vol terms.
- If RMSE > 0.03, recommend re-calibration with different initial conditions.
- If rho < -0.95, warn about boundary effects.
- If calibration did not converge, this is a FAIL verdict.
- Be quantitatively precise. Show your calculations."""

    def build_context_prompt(self, context: AgentContext) -> str:
        sections = ["--- CALIBRATION DATA FOR ANALYSIS ---"]

        if context.calibration:
            sections.append(f"CALIBRATION RESULT:\n{self._format_dict(context.calibration)}")

            params = context.calibration.get("parameters", {})
            if params:
                kappa = params.get("kappa", 0)
                theta = params.get("theta", 0)
                xi = params.get("xi", 0)
                rho = params.get("rho", 0)
                v0 = params.get("v0", 0)
                feller_lhs = 2 * kappa * theta
                feller_rhs = xi ** 2
                derived = {
                    "feller_lhs_2kt": round(feller_lhs, 6),
                    "feller_rhs_xi2": round(feller_rhs, 6),
                    "feller_satisfied": feller_lhs > feller_rhs,
                    "implied_long_run_vol": round(float(np.sqrt(max(theta, 0))), 6),
                    "implied_current_vol": round(float(np.sqrt(max(v0, 0))), 6),
                    "vol_term_structure_ratio": round(v0 / max(theta, 1e-8), 4),
                }
                sections.append(f"DERIVED METRICS:\n{json.dumps(derived)}")

        if context.surface:
            surface_stats = {}
            if "residual_iv_matrix" in context.surface:
                res = context.surface["residual_iv_matrix"]
                if isinstance(res, list) and res:
                    arr = np.array(res, dtype=float)
                    surface_stats["residual_rmse"] = round(float(np.sqrt(np.mean(arr ** 2))), 6)
                    surface_stats["residual_mean_bias"] = round(float(np.mean(arr)), 6)
                    surface_stats["residual_max_abs"] = round(float(np.max(np.abs(arr))), 6)
                    surface_stats["residual_shape"] = list(arr.shape)
                    if arr.ndim == 2 and arr.shape[0] > 1:
                        per_maturity_rmse = [
                            round(float(np.sqrt(np.mean(arr[i] ** 2))), 6)
                            for i in range(arr.shape[0])
                        ]
                        surface_stats["rmse_per_maturity"] = per_maturity_rmse
            if "maturity_grid" in context.surface:
                surface_stats["maturities"] = context.surface["maturity_grid"]
            sections.append(f"SURFACE RESIDUALS:\n{json.dumps(surface_stats, default=str)}")

        if context.market_overview:
            sections.append(
                f"MARKET REFERENCE: spot={context.market_overview.get('spot', 'N/A')}, "
                f"atm_market_iv={context.market_overview.get('atm_market_iv', 'N/A')}, "
                f"atm_model_iv={context.market_overview.get('atm_model_iv', 'N/A')}"
            )

        return "\n\n".join(sections)
