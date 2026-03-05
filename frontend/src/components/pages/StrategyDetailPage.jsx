import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber, formatRs, formatPctVal } from './shared.jsx';

/* ── KDE builder (Gaussian kernel density estimate) ── */
function buildKde(values, steps = 160) {
  if (!Array.isArray(values) || values.length < 2) return { x: [], y: [] };
  const n = values.length;
  const mean = values.reduce((a, v) => a + v, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(n - 1, 1);
  const std = Math.sqrt(Math.max(variance, 1e-12));
  const h = Math.max(1.06 * std * (n ** (-1 / 5)), 1e-6);
  const pad = Math.max(std * 1.5, h * 3);
  const xMin = Math.min(...values) - pad;
  const xMax = Math.max(...values) + pad;
  const dx = (xMax - xMin) / steps;
  const invSqrt2Pi = 1 / Math.sqrt(2 * Math.PI);
  const invNh = 1 / (n * h);
  const x = [], y = [];
  for (let i = 0; i <= steps; i++) {
    const xi = xMin + dx * i;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const u = (xi - values[j]) / h;
      sum += Math.exp(-0.5 * u * u) * invSqrt2Pi;
    }
    x.push(xi);
    y.push(invNh * sum);
  }
  return { x, y };
}

// ─── Helper: compute multi-leg intrinsic payoff at expiry ─────────────────
function computeIntrinsicPayoff(spotAtExpiry, legs, netPremium) {
  let payoff = 0;
  for (const leg of legs) {
    const intrinsic =
      leg.option_type === 'C'
        ? Math.max(spotAtExpiry - leg.strike, 0)
        : Math.max(leg.strike - spotAtExpiry, 0);
    payoff += leg.direction * (leg.ratio || 1) * intrinsic;
  }
  return payoff - netPremium; // subtract cost
}

// ─── Helper: generate Brownian-bridge MC PnL paths ────────────────────────
function generateMCPaths(pnlDist, numPaths, numSteps) {
  if (!pnlDist.length) return [];
  // Sort PnL distribution and sample evenly across the range for diversity
  const sorted = [...pnlDist].sort((a, b) => a - b);
  const step = Math.max(1, Math.floor(sorted.length / numPaths));
  const terminals = [];
  for (let i = 0; i < sorted.length && terminals.length < numPaths; i += step) {
    terminals.push(sorted[i]);
  }
  // Simple seeded pseudo-random for reproducibility
  const seededRand = (seed) => {
    let s = seed;
    return () => {
      s = (s * 16807 + 0) % 2147483647;
      return s / 2147483647;
    };
  };

  return terminals.map((terminal, pathIdx) => {
    const rand = seededRand(pathIdx * 31337 + 42);
    const path = [0];
    // Brownian bridge: linearly drift toward terminal + scaled noise
    for (let t = 1; t <= numSteps; t++) {
      const frac = t / numSteps;
      const drift = terminal * frac;
      const vol = Math.abs(terminal) * 0.5 * Math.sqrt(frac * (1 - frac + 0.02));
      const noise = (rand() - 0.5) * 2 * vol;
      path.push(drift + noise);
    }
    path[numSteps] = terminal; // force exact endpoint
    return path;
  });
}

// ─── Helper: compute numeric Greeks across spot range ─────────────────────
function computeGreeksProfile(legs, netPremium, spot, spotRange) {
  const ds = spot * 0.001;
  const deltas = [];
  const gammas = [];
  for (const s of spotRange) {
    const pnlUp = computeIntrinsicPayoff(s + ds, legs, netPremium);
    const pnlMid = computeIntrinsicPayoff(s, legs, netPremium);
    const pnlDn = computeIntrinsicPayoff(s - ds, legs, netPremium);
    deltas.push((pnlUp - pnlDn) / (2 * ds));
    gammas.push((pnlUp - 2 * pnlMid + pnlDn) / (ds * ds));
  }
  return { deltas, gammas };
}

const MC_COLORS = [
  '#38bdf8', '#22c55e', '#f59e0b', '#f43f5e', '#a855f7',
  '#ec4899', '#06b6d4', '#84cc16', '#fb923c', '#8b5cf6',
  '#14b8a6', '#e879f9', '#facc15', '#4ade80', '#f97316',
];

const DARK_LAYOUT = {
  paper_bgcolor: '#0a0f19',
  plot_bgcolor: '#0a0f19',
  font: { color: '#d1d5db', size: 11 },
};

export default function StrategyDetailPage({ loading, activeSnapshotId, strategies, selectedStrategyId, risk, market, surface }) {
  const items = Array.isArray(strategies?.items) ? strategies.items : [];
  const selected = items.find((item) => item.id === selectedStrategyId) || items[0] || null;
  const spot = Number(market?.spot ?? 0);
  const legs = Array.isArray(selected?.legs) ? selected.legs : [];
  const netPremium = Number(selected?.net_premium ?? selected?.cost ?? 0);
  const calibration = surface?.calibration || null;

  const pnlDist = useMemo(() => {
    if (Array.isArray(selected?.pnl_distribution) && selected.pnl_distribution.length) {
      return selected.pnl_distribution;
    }
    return [];
  }, [selected]);

  const var95 = Number(selected?.var_95 ?? 0);
  const var99 = Number(selected?.var_99 ?? 0);
  const breakEvens = Array.isArray(selected?.break_even_levels) ? selected.break_even_levels.map(Number) : [];

  // ── Payoff at Expiry (from actual legs) ──
  const payoffData = useMemo(() => {
    if (!spot || legs.length === 0) {
      const axis = Array.from({ length: 61 }, (_, i) => spot * (0.85 + i * 0.005));
      const delta = Number(selected?.delta_exposure ?? 0);
      const gamma = Number(selected?.gamma_exposure ?? 0);
      const ev = Number(selected?.expected_value ?? 0);
      const vals = axis.map((s) => {
        const d = (s - spot) / Math.max(spot, 1);
        return ev + delta * d * spot + 0.5 * gamma * d * d * spot;
      });
      return { axis, vals };
    }
    const lo = spot * 0.85;
    const hi = spot * 1.15;
    const count = 120;
    const axis = Array.from({ length: count }, (_, i) => lo + (i * (hi - lo)) / (count - 1));
    const vals = axis.map((s) => computeIntrinsicPayoff(s, legs, netPremium));
    return { axis, vals };
  }, [spot, legs, netPremium, selected]);

  // ── Monte Carlo Paths ──
  const mcPaths = useMemo(() => generateMCPaths(pnlDist, 50, 24), [pnlDist]);
  const mcTimeAxis = useMemo(() => (mcPaths.length ? Array.from({ length: mcPaths[0].length }, (_, i) => i) : []), [mcPaths]);

  const mcCone = useMemo(() => {
    if (!mcPaths.length) return null;
    const steps = mcPaths[0].length;
    const p5 = [], p25 = [], p50 = [], p75 = [], p95 = [];
    for (let t = 0; t < steps; t++) {
      const vals = mcPaths.map((p) => p[t]).sort((a, b) => a - b);
      const pct = (q) => vals[Math.min(Math.floor(q * vals.length), vals.length - 1)];
      p5.push(pct(0.05)); p25.push(pct(0.25)); p50.push(pct(0.5)); p75.push(pct(0.75)); p95.push(pct(0.95));
    }
    return { p5, p25, p50, p75, p95 };
  }, [mcPaths]);

  // ── Greeks vs Spot ──
  const greeksProfile = useMemo(() => {
    if (!spot) return null;
    const lo = spot * 0.88, hi = spot * 1.12, count = 80;
    const range = Array.from({ length: count }, (_, i) => lo + (i * (hi - lo)) / (count - 1));
    if (legs.length > 0) {
      const { deltas, gammas } = computeGreeksProfile(legs, netPremium, spot, range);
      return { range, deltas, gammas };
    }
    const d = Number(selected?.delta_exposure ?? 0);
    const g = Number(selected?.gamma_exposure ?? 0);
    return { range, deltas: range.map((s) => d + g * (s - spot)), gammas: range.map(() => g) };
  }, [spot, legs, netPremium, selected]);

  // ── Vol Sensitivity ──
  const volShiftProfile = useMemo(() => {
    const vega = Number(selected?.vega_exposure ?? 0);
    const shifts = Array.from({ length: 21 }, (_, i) => -20 + i * 2);
    const pnlImpact = shifts.map((s) => {
      const linear = vega * (s / 100);
      const curve = Math.abs(vega) * 0.1 * (s / 100) ** 2;
      return linear + (s < 0 ? -curve : curve) * 0.5;
    });
    return { shifts, pnlImpact };
  }, [selected]);

  // ── Stress Scenarios ──
  const stressRows = useMemo(() => {
    const ev = Number(selected?.expected_value ?? 0);
    if (legs.length > 0 && spot > 0) {
      return [
        { name: 'Spot −5%', value: computeIntrinsicPayoff(spot * 0.95, legs, netPremium) - ev },
        { name: 'Spot +5%', value: computeIntrinsicPayoff(spot * 1.05, legs, netPremium) - ev },
        { name: 'Spot −10%', value: computeIntrinsicPayoff(spot * 0.90, legs, netPremium) - ev },
        { name: 'Spot +10%', value: computeIntrinsicPayoff(spot * 1.10, legs, netPremium) - ev },
        { name: 'Crash −15%', value: computeIntrinsicPayoff(spot * 0.85, legs, netPremium) - ev },
        { name: 'Vol +10pt', value: Number(selected?.vega_exposure ?? 0) * 0.10 },
        { name: 'Vol −10pt', value: Number(selected?.vega_exposure ?? 0) * (-0.10) },
        { name: 'Theta 1W', value: Number(selected?.theta_exposure ?? 0) * 7 },
      ];
    }
    return [
      { name: 'Spot −5%', value: Number(risk?.stress?.spot_down_5 ?? 0) },
      { name: 'Spot +5%', value: Number(risk?.stress?.spot_up_5 ?? 0) },
      { name: 'Vol +10pt', value: Number(risk?.stress?.vol_up_10 ?? 0) },
      { name: 'Vol Crush', value: Number(risk?.stress?.vol_crush ?? 0) },
      { name: 'Theta 1W', value: Number(risk?.stress?.time_decay_1w ?? 0) },
    ];
  }, [selected, legs, netPremium, spot, risk]);

  // ── Distribution stats ──
  const distStats = useMemo(() => {
    if (!pnlDist.length) return null;
    const sorted = [...pnlDist].sort((a, b) => a - b);
    const mean = pnlDist.reduce((a, b) => a + b, 0) / pnlDist.length;
    const std = Math.sqrt(pnlDist.reduce((a, v) => a + (v - mean) ** 2, 0) / pnlDist.length);
    const median = sorted[Math.floor(sorted.length / 2)];
    const pctWin = pnlDist.filter((v) => v > 0).length / pnlDist.length;
    return { mean, std, median, pctWin, count: pnlDist.length };
  }, [pnlDist]);

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-detail-grid">
        {/* ── Key Metrics ── */}
        <Panel title="Key Metrics">
          <div className="kv-grid two-col compact">
            <div><span>Strategy</span><strong>{selected?.strategy_type || '-'}</strong></div>
            <div><span>Legs</span><strong>{selected?.legs_label || (Array.isArray(selected?.strikes) ? selected.strikes.join(', ') : '-')}</strong></div>
            <div><span>Net Premium</span><strong>{formatRs(netPremium)}</strong></div>
            <div><span>Expected Value</span><strong style={{ color: Number(selected?.expected_value ?? 0) >= 0 ? '#22c55e' : '#f43f5e' }}>{formatNumber(selected?.expected_value, 4)}</strong></div>
            <div><span>Return on Margin</span><strong>{formatNumber(selected?.return_on_margin, 6)}</strong></div>
            <div><span>Overall Score</span><strong style={{ color: '#38bdf8' }}>{formatPctVal(selected?.overall_score)}</strong></div>
            <div><span>P(Loss)</span><strong style={{ color: Number(selected?.probability_of_loss ?? 0) > 0.5 ? '#f43f5e' : '#22c55e' }}>{(Number(selected?.probability_of_loss ?? 0) * 100).toFixed(1)}%</strong></div>
            <div><span>Max Loss</span><strong style={{ color: '#f43f5e' }}>{formatRs(selected?.max_loss)}</strong></div>
            <div><span>VaR 95%</span><strong>{formatRs(selected?.var_95)}</strong></div>
            <div><span>VaR 99%</span><strong>{formatRs(selected?.var_99)}</strong></div>
            <div><span>Exp. Shortfall</span><strong>{formatRs(selected?.expected_shortfall)}</strong></div>
            <div><span>Fragility</span><strong>{formatNumber(selected?.fragility_score, 6)}</strong></div>
            <div><span>Delta</span><strong>{formatNumber(selected?.delta_exposure, 4)}</strong></div>
            <div><span>Gamma</span><strong>{formatNumber(selected?.gamma_exposure, 6)}</strong></div>
            <div><span>Vega</span><strong>{formatNumber(selected?.vega_exposure, 4)}</strong></div>
            <div><span>Theta</span><strong>{formatNumber(selected?.theta_exposure, 4)}</strong></div>
          </div>
          {calibration && (
            <div style={{ marginTop: 8, fontSize: 10, color: '#6b7280' }}>
              Model: Heston | RMSE: {formatNumber(calibration.weighted_rmse, 6)} | {calibration.converged ? 'Converged' : 'Not Converged'}
            </div>
          )}
        </Panel>

        {/* ── Payoff At Expiry ── */}
        <Panel title={`Payoff at Expiry${legs.length ? ` (${legs.length}-leg)` : ''}`}>
          <Plot
            data={[
              {
                type: 'scatter', mode: 'lines', x: payoffData.axis, y: payoffData.vals,
                line: { color: '#38bdf8', width: 2.5 }, name: 'Payoff',
                fill: 'tozeroy', fillcolor: 'rgba(56,189,248,0.08)',
              },
              {
                type: 'scatter', mode: 'lines',
                x: [payoffData.axis[0], payoffData.axis[payoffData.axis.length - 1]], y: [0, 0],
                line: { color: '#4b5563', width: 1, dash: 'dot' }, showlegend: false,
              },
              ...(spot ? [{
                type: 'scatter', mode: 'lines',
                x: [spot, spot], y: [Math.min(...payoffData.vals), Math.max(...payoffData.vals)],
                line: { color: '#9ca3af', width: 1, dash: 'dash' }, name: 'Spot',
              }] : []),
              ...breakEvens.filter((be) => be > payoffData.axis[0] && be < payoffData.axis[payoffData.axis.length - 1]).map((be, i) => ({
                type: 'scatter', mode: 'lines',
                x: [be, be], y: [Math.min(...payoffData.vals), Math.max(...payoffData.vals)],
                line: { color: '#f59e0b', width: 1.5, dash: 'dash' }, name: i === 0 ? 'Break-even' : undefined, showlegend: i === 0,
              })),
            ]}
            layout={{
              height: 260, margin: { l: 40, r: 12, b: 30, t: 18 },
              ...DARK_LAYOUT,
              xaxis: { title: 'Spot at Expiry', gridcolor: '#1f2937', tickformat: ',.0f' },
              yaxis: { title: 'PnL', gridcolor: '#1f2937', zeroline: true, zerolinecolor: '#374151' },
              legend: { orientation: 'h', y: 1.12, font: { size: 9 } },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        {/* ── PnL Distribution ── */}
        <Panel title={`PnL Distribution${distStats ? ` (${distStats.count} paths)` : ''}`}>
          {(() => {
            const kde = buildKde(pnlDist);
            const yMax = kde.y.length ? Math.max(...kde.y) * 1.1 : 1;
            const varShapes = [];
            const varAnnotations = [];
            if (var95) {
              varShapes.push({ type: 'line', x0: -var95, x1: -var95, y0: 0, y1: yMax, line: { color: '#fb923c', width: 2, dash: 'dash' } });
              varAnnotations.push({ x: -var95, y: yMax * 0.92, text: `VaR 95<br>${formatNumber(-var95, 1)}`, showarrow: false, font: { color: '#fb923c', size: 10 }, xanchor: 'right', xshift: -4 });
            }
            if (var99) {
              varShapes.push({ type: 'line', x0: -var99, x1: -var99, y0: 0, y1: yMax, line: { color: '#f43f5e', width: 2, dash: 'dash' } });
              varAnnotations.push({ x: -var99, y: yMax * 0.78, text: `VaR 99<br>${formatNumber(-var99, 1)}`, showarrow: false, font: { color: '#f43f5e', size: 10 }, xanchor: 'right', xshift: -4 });
            }
            varShapes.push({ type: 'line', x0: 0, x1: 0, y0: 0, y1: yMax, line: { color: '#6b7280', width: 1, dash: 'dot' } });
            return (
              <Plot
                data={[
                  {
                    type: 'scatter', mode: 'lines',
                    x: kde.x, y: kde.y,
                    line: { color: '#f59e0b', width: 2.5 },
                    fill: 'tozeroy',
                    fillcolor: 'rgba(245, 158, 11, 0.25)',
                    name: 'PnL Density',
                    hovertemplate: 'PnL: %{x:.1f}<br>Density: %{y:.6f}<extra></extra>',
                  },
                ]}
                layout={{
                  height: 260, margin: { l: 40, r: 12, b: 30, t: 18 },
                  ...DARK_LAYOUT,
                  xaxis: { title: 'PnL', gridcolor: '#1f2937', zerolinecolor: '#334155' },
                  yaxis: { title: 'Density', gridcolor: '#1f2937', rangemode: 'tozero' },
                  shapes: varShapes,
                  annotations: varAnnotations,
                  showlegend: true,
                  legend: { orientation: 'h', y: 1.12, font: { size: 9 } },
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            );
          })()}
          {distStats && (
            <div style={{ display: 'flex', gap: 16, fontSize: 10, color: '#9ca3af', marginTop: 4, flexWrap: 'wrap' }}>
              <span>Mean: {formatNumber(distStats.mean, 2)}</span>
              <span>Median: {formatNumber(distStats.median, 2)}</span>
              <span>Std: {formatNumber(distStats.std, 2)}</span>
              <span>Win Rate: {(distStats.pctWin * 100).toFixed(1)}%</span>
            </div>
          )}
        </Panel>

        {/* ── Monte Carlo Paths ── */}
        <Panel title={`Monte Carlo Simulation (${mcPaths.length} of ${pnlDist.length} paths)`}>
          <Plot
            data={[
              ...mcPaths.map((path, i) => ({
                type: 'scatter', mode: 'lines', x: mcTimeAxis, y: path,
                line: { color: MC_COLORS[i % MC_COLORS.length], width: 0.8 },
                opacity: 0.35, showlegend: false, hoverinfo: 'skip',
              })),
              ...(mcCone ? [
                {
                  type: 'scatter', mode: 'lines', x: mcTimeAxis, y: mcCone.p95,
                  line: { color: '#22c55e', width: 0 }, showlegend: false, hoverinfo: 'skip',
                },
                {
                  type: 'scatter', mode: 'lines', x: mcTimeAxis, y: mcCone.p5,
                  fill: 'tonexty', fillcolor: 'rgba(34,197,94,0.08)',
                  line: { color: '#22c55e', width: 0 }, name: '5th–95th pctl',
                },
                {
                  type: 'scatter', mode: 'lines', x: mcTimeAxis, y: mcCone.p75,
                  line: { color: '#38bdf8', width: 0 }, showlegend: false, hoverinfo: 'skip',
                },
                {
                  type: 'scatter', mode: 'lines', x: mcTimeAxis, y: mcCone.p25,
                  fill: 'tonexty', fillcolor: 'rgba(56,189,248,0.12)',
                  line: { color: '#38bdf8', width: 0 }, name: '25th–75th pctl',
                },
                {
                  type: 'scatter', mode: 'lines', x: mcTimeAxis, y: mcCone.p50,
                  line: { color: '#facc15', width: 2.5 }, name: 'Median',
                },
              ] : []),
            ]}
            layout={{
              height: 280, margin: { l: 40, r: 12, b: 30, t: 18 },
              ...DARK_LAYOUT,
              xaxis: { title: 'Time Step', gridcolor: '#1f2937' },
              yaxis: { title: 'PnL Path', gridcolor: '#1f2937', zeroline: true, zerolinecolor: '#374151' },
              legend: { orientation: 'h', y: 1.14, font: { size: 9 } },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        {/* ── Greeks vs Spot ── */}
        <Panel title="Greeks vs Spot">
          {greeksProfile && (
            <Plot
              data={[
                {
                  type: 'scatter', mode: 'lines', x: greeksProfile.range, y: greeksProfile.deltas,
                  name: 'Delta', line: { color: '#22c55e', width: 2 },
                },
                {
                  type: 'scatter', mode: 'lines', x: greeksProfile.range, y: greeksProfile.gammas,
                  name: 'Gamma', line: { color: '#38bdf8', width: 2 }, yaxis: 'y2',
                },
                ...(spot ? [{
                  type: 'scatter', mode: 'lines', x: [spot, spot],
                  y: [Math.min(...greeksProfile.deltas), Math.max(...greeksProfile.deltas)],
                  line: { color: '#9ca3af', width: 1, dash: 'dash' }, showlegend: false,
                }] : []),
              ]}
              layout={{
                height: 260, margin: { l: 40, r: 50, b: 30, t: 18 },
                ...DARK_LAYOUT,
                xaxis: { title: 'Spot', gridcolor: '#1f2937', tickformat: ',.0f' },
                yaxis: { title: 'Delta', gridcolor: '#1f2937', titlefont: { color: '#22c55e' } },
                yaxis2: { title: 'Gamma', overlaying: 'y', side: 'right', gridcolor: '#1f293700', titlefont: { color: '#38bdf8' } },
                legend: { orientation: 'h', y: 1.12, font: { size: 9 } },
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          )}
        </Panel>

        {/* ── PnL Sensitivity to Vol Shift ── */}
        <Panel title="PnL Sensitivity to Vol Shift">
          <Plot
            data={[
              {
                type: 'scatter', mode: 'lines+markers', x: volShiftProfile.shifts, y: volShiftProfile.pnlImpact,
                line: { color: '#a855f7', width: 2 }, marker: { size: 4, color: '#a855f7' },
                name: 'PnL Impact', fill: 'tozeroy', fillcolor: 'rgba(168,85,247,0.08)',
              },
              {
                type: 'scatter', mode: 'lines',
                x: [volShiftProfile.shifts[0], volShiftProfile.shifts[volShiftProfile.shifts.length - 1]], y: [0, 0],
                line: { color: '#4b5563', width: 1, dash: 'dot' }, showlegend: false,
              },
            ]}
            layout={{
              height: 260, margin: { l: 40, r: 12, b: 30, t: 18 },
              ...DARK_LAYOUT,
              xaxis: { title: 'Vol Shift (%)', gridcolor: '#1f2937' },
              yaxis: { title: 'PnL Impact', gridcolor: '#1f2937' },
              showlegend: false,
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        {/* ── Stress Scenarios ── */}
        <Panel title="Stress Scenario Analysis">
          <Plot
            data={[{
              type: 'bar',
              x: stressRows.map((r) => r.name),
              y: stressRows.map((r) => r.value),
              marker: {
                color: stressRows.map((r) => (r.value >= 0 ? '#22c55e' : '#ef4444')),
                line: { color: stressRows.map((r) => (r.value >= 0 ? '#16a34a' : '#dc2626')), width: 1 },
              },
              text: stressRows.map((r) => formatNumber(r.value, 2)),
              textposition: 'outside',
              textfont: { size: 9, color: '#d1d5db' },
            }]}
            layout={{
              height: 260, margin: { l: 40, r: 12, b: 50, t: 18 },
              ...DARK_LAYOUT,
              xaxis: { gridcolor: '#1f2937', tickangle: -30 },
              yaxis: { title: 'PnL Impact', gridcolor: '#1f2937', zeroline: true, zerolinecolor: '#374151' },
              showlegend: false,
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        {/* ── Risk Decomposition ── */}
        <Panel title="Risk Decomposition">
          <Plot
            data={[{
              type: 'pie',
              labels: ['Delta Risk', 'Gamma Risk', 'Vega Risk', 'Theta Decay', 'Skew Risk'],
              values: [
                Math.abs(Number(selected?.delta_exposure ?? 0)) * spot * 0.01,
                Math.abs(Number(selected?.gamma_exposure ?? 0)) * spot * 0.01 * spot * 0.01 * 0.5,
                Math.abs(Number(selected?.vega_exposure ?? 0)) * 0.01,
                Math.abs(Number(selected?.theta_exposure ?? 0)) * 7,
                Math.abs(Number(selected?.skew_exposure ?? 0)),
              ],
              hole: 0.4,
              marker: { colors: ['#22c55e', '#38bdf8', '#a855f7', '#f59e0b', '#ec4899'] },
              textinfo: 'label+percent',
              textfont: { size: 10, color: '#d1d5db' },
              hovertemplate: '%{label}: %{value:.2f}<extra></extra>',
            }]}
            layout={{
              height: 260, margin: { l: 12, r: 12, b: 12, t: 12 },
              ...DARK_LAYOUT,
              showlegend: false,
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
      </div>
    </SnapshotGuard>
  );
}
