"""Benchmark: C++ vol_core vs Python baseline."""
import sys, os, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import vol_core

from backend.simulation.heston_mc import HestonMonteCarloEngine
from backend.calibration.heston_fft import JointHestonParameters, HestonFFTPricer

params = (2.0, 0.04, 0.5, -0.7, 0.04)
spot, T, r = 22000.0, 0.02, 0.065

# ── MC Benchmark: 50000 paths × 96 steps ──
t0 = time.perf_counter()
for _ in range(3):
    t_cpp, _, _ = vol_core.heston_mc(*params, spot, T, r, 50000, 96, 42, False)
cpp_mc = (time.perf_counter() - t0) / 3

hp = JointHestonParameters(*params)
engine = HestonMonteCarloEngine()
t0 = time.perf_counter()
for _ in range(3):
    res = engine.simulate(hp, spot, T, r, 50000, 96, 42, False)
py_mc = (time.perf_counter() - t0) / 3

print(f"C++ MC  (50k x 96): {cpp_mc*1000:.1f} ms  mean={np.mean(t_cpp):.2f}")
print(f"Py  MC  (50k x 96): {py_mc*1000:.1f} ms  mean={np.mean(res.terminal_prices):.2f}")
print(f"MC speedup: {py_mc/cpp_mc:.1f}x\n")

# ── FFT Benchmark ──
strikes = np.linspace(20000, 24000, 50)
t0 = time.perf_counter()
for _ in range(20):
    cp = vol_core.heston_fft_prices(spot, T, r, 0.012, *params, strikes, 4096, 0.20, 1.5)
cpp_fft = (time.perf_counter() - t0) / 20

pricer = HestonFFTPricer()
t0 = time.perf_counter()
for _ in range(20):
    cp2 = pricer.price_calls_fft(spot, T, r, 0.012, hp, strikes)
py_fft = (time.perf_counter() - t0) / 20

print(f"C++ FFT (4096): {cpp_fft*1000:.2f} ms")
print(f"Py  FFT (4096): {py_fft*1000:.2f} ms")
print(f"FFT speedup: {py_fft/cpp_fft:.1f}x\n")

# ── Implied Vol Benchmark ──
t0 = time.perf_counter()
for _ in range(20):
    ivs_cpp = vol_core.implied_vols_from_calls(cp, spot, strikes, T, r, 0.012)
cpp_iv = (time.perf_counter() - t0) / 20

t0 = time.perf_counter()
for _ in range(20):
    ivs_py = pricer.implied_vol_from_call_prices(cp2, spot, strikes, T, r, 0.012)
py_iv = (time.perf_counter() - t0) / 20

print(f"C++ IV  (50 strikes): {cpp_iv*1000:.2f} ms")
print(f"Py  IV  (50 strikes): {py_iv*1000:.2f} ms")
print(f"IV speedup: {py_iv/cpp_iv:.1f}x\n")

# ── Strategy evaluation ──
terminal = t_cpp
legs = [
    {"strike": 21800, "option_type": "P", "direction": 1, "ratio": 1},
    {"strike": 21900, "option_type": "P", "direction": -1, "ratio": 1},
    {"strike": 22100, "option_type": "C", "direction": -1, "ratio": 1},
    {"strike": 22200, "option_type": "C", "direction": 1, "ratio": 1},
]

t0 = time.perf_counter()
for _ in range(200):
    r1 = vol_core.evaluate_strategy(terminal, legs, 15.0, False, spot)
cpp_eval = (time.perf_counter() - t0) / 200

print(f"C++ eval per-strategy (50k paths): {cpp_eval*1000:.3f} ms")
print(f"C++ 500 strategies: {cpp_eval*500*1000:.0f} ms")

# Batch evaluation
batch = [{"legs": legs, "net_premium": 15.0, "has_underlying": False, "margin": 10000.0}] * 500
t0 = time.perf_counter()
results = vol_core.batch_evaluate_strategies(terminal, batch, spot)
cpp_batch = time.perf_counter() - t0
print(f"C++ batch 500 strategies: {cpp_batch*1000:.0f} ms")
print(f"\n=== SUMMARY ===")
print(f"MC:  {py_mc/cpp_mc:.0f}x faster")
print(f"FFT: {py_fft/cpp_fft:.0f}x faster")
print(f"IV:  {py_iv/cpp_iv:.0f}x faster")
