from __future__ import annotations

import numpy as np
from typing import Any, Dict, List, Tuple
from ..data.models import OptionChainRawRecord

def build_liquidity_matrices(
    records: List[OptionChainRawRecord],
    expiry_list: List[Any],
    strike_grid: np.ndarray,
) -> Dict[str, List[List[float]]]:
    """Build volume and open interest matrices aligned to the surface grid."""
    num_expiries = len(expiry_list)
    num_strikes = strike_grid.size
    
    vol_matrix = np.zeros((num_expiries, num_strikes), dtype=float)
    oi_matrix = np.zeros((num_expiries, num_strikes), dtype=float)
    
    expiry_to_idx = {exp: i for i, exp in enumerate(expiry_list)}
    strike_to_idx = {round(float(s), 6): i for i, s in enumerate(strike_grid)}
    
    for rec in records:
        e_idx = expiry_to_idx.get(rec.expiry)
        s_idx = strike_to_idx.get(round(float(rec.strike), 6))
        if e_idx is not None and s_idx is not None:
            vol_matrix[e_idx, s_idx] += float(rec.volume)
            oi_matrix[e_idx, s_idx] += float(rec.open_interest)
            
    return {
        "volume_matrix": vol_matrix.tolist(),
        "open_interest_matrix": oi_matrix.tolist(),
    }

def build_liquidity_stress_matrix(
    records: List[OptionChainRawRecord],
    expiry_list: List[Any],
    strike_grid: np.ndarray,
) -> List[List[float]]:
    """
    Calculate Liquidity Stress = Volume / (Ask - Bid).
    High values = Better liquidity relative to spread.
    Low values (near 0) = High execution risk / wide spreads.
    """
    num_expiries = len(expiry_list)
    num_strikes = strike_grid.size
    
    stress_matrix = np.zeros((num_expiries, num_strikes), dtype=float)
    
    # We aggregate by strike/expiry
    expiry_to_idx = {exp: i for i, exp in enumerate(expiry_list)}
    strike_to_idx = {round(float(s), 6): i for i, s in enumerate(strike_grid)}
    
    # Intermediate storage for aggregation
    # (e_idx, s_idx) -> [total_vol, total_weighted_spread]
    agg = {}
    
    for rec in records:
        e_idx = expiry_to_idx.get(rec.expiry)
        s_idx = strike_to_idx.get(round(float(rec.strike), 6))
        if e_idx is None or s_idx is None:
            continue
            
        # Determine spread
        # For raw records, we have call_bid, call_ask, etc.
        # We'll average the spreads if both sides present
        c_spread = max(0.01, rec.call_ask - rec.call_bid) if rec.call_ask > 0 and rec.call_bid > 0 else None
        p_spread = max(0.01, rec.put_ask - rec.put_bid) if rec.put_ask > 0 and rec.put_bid > 0 else None
        
        spread = 1.0
        if c_spread is not None and p_spread is not None:
            spread = (c_spread + p_spread) / 2.0
        elif c_spread is not None:
            spread = c_spread
        elif p_spread is not None:
            spread = p_spread
        else:
            # No spread data, assume very wide to penalize stress score
            spread = 100.0
            
        vol = float(rec.volume)
        key = (e_idx, s_idx)
        if key not in agg:
            agg[key] = [0.0, 0.0]
        agg[key][0] += vol
        agg[key][1] += spread # Simple sum/avg for surface
        
    for (e_idx, s_idx), (vol, spread) in agg.items():
        # Stress = Volume / Spread
        # If spread is 0, we've clamped it to 0.01
        stress_matrix[e_idx, s_idx] = vol / max(0.01, spread)
        
    return stress_matrix.tolist()
