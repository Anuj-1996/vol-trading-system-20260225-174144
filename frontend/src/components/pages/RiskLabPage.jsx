import React, { useMemo, useState } from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';

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

/**
 * Compute PnL change via Taylor expansion using actual Greeks:
 *   ΔPnL ≈ Δ·ΔS + ½Γ·(ΔS)² + V·Δσ + Θ·Δt
 * where ΔS = spot * spotPct, Δσ = volAbs (in IV terms), Δt = days/365
 */
function taylorPnL(delta, gamma, vega, theta, spot, spotPct, volAbs, days) {
  const dS = spot * (spotPct / 100);
  const dt = days / 365;
  return delta * dS + 0.5 * gamma * dS * dS + vega * volAbs + theta * dt;
}

const SPOT_AXIS = [-15, -10, -5, -2, 0, 2, 5, 10, 15];
const VOL_AXIS = [-0.10, -0.05, -0.02, 0, 0.02, 0.05, 0.10];
const HEAT_SPOT = [-15, -10, -5, -2, 0, 2, 5, 10, 15];
const HEAT_VOL = [-0.10, -0.07, -0.04, -0.02, 0, 0.02, 0.04, 0.07, 0.10];

export default function RiskLabPage({ loading, activeSnapshotId, risk }) {
  const [spotShift, setSpotShift] = useState(0);
  const [volShift, setVolShift] = useState(0);
  const [timeForward, setTimeForward] = useState(0);

  const spot = Number(risk?.spot ?? 0);
  const delta = Number(risk?.delta ?? 0);
  const gamma = Number(risk?.gamma ?? 0);
  const vega = Number(risk?.vega ?? 0);
  const theta = Number(risk?.theta ?? 0);
  const basePnl = Number(risk?.base_pnl ?? 0);
  const baseVar95 = Number(risk?.var_95 ?? 0);
  const baseVar99 = Number(risk?.var_99 ?? 0);
  const baseEs = Number(risk?.expected_shortfall ?? 0);

  // Scenario PnL from sliders
  const scenarioPnl = useMemo(
    () => basePnl + taylorPnL(delta, gamma, vega, theta, spot, spotShift, volShift / 100, timeForward),
    [basePnl, delta, gamma, vega, theta, spot, spotShift, volShift, timeForward],
  );

  // Updated Greeks under spot shift (Δ → Δ + Γ·ΔS)
  const scenarioDelta = delta + gamma * spot * (spotShift / 100);

  // Spot sensitivity curve (fix vol shift from slider, sweep spot)
  const spotCurve = useMemo(
    () => SPOT_AXIS.map((s) => basePnl + taylorPnL(delta, gamma, vega, theta, spot, s, volShift / 100, timeForward)),
    [basePnl, delta, gamma, vega, theta, spot, volShift, timeForward],
  );

  // Vol sensitivity curve (fix spot shift from slider, sweep vol)
  const volCurve = useMemo(
    () => VOL_AXIS.map((v) => basePnl + taylorPnL(delta, gamma, vega, theta, spot, spotShift, v, timeForward)),
    [basePnl, delta, gamma, vega, theta, spot, spotShift, timeForward],
  );

  // 2D PnL heatmap: rows = vol shifts, cols = spot shifts
  const heatmapZ = useMemo(
    () => HEAT_VOL.map((v) => HEAT_SPOT.map((s) => basePnl + taylorPnL(delta, gamma, vega, theta, spot, s, v, timeForward))),
    [basePnl, delta, gamma, vega, theta, spot, timeForward],
  );

  // PnL distribution histogram (if available)
  const pnlDist = risk?.pnl_distribution || [];

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-risk-grid">
        <Panel title="Scenario Controls">
          <div className="control-stack">
            <label>Spot shift ({spotShift > 0 ? '+' : ''}{spotShift}%)
              <input type="range" min={-20} max={20} step={0.5} value={spotShift} onChange={(e) => setSpotShift(Number(e.target.value))} />
            </label>
            <label>IV shift ({volShift > 0 ? '+' : ''}{volShift}%)
              <input type="range" min={-30} max={30} step={0.5} value={volShift} onChange={(e) => setVolShift(Number(e.target.value))} />
            </label>
            <label>Time decay ({timeForward} days)
              <input type="range" min={0} max={30} step={1} value={timeForward} onChange={(e) => setTimeForward(Number(e.target.value))} />
            </label>
            <button type="button" style={{ marginTop: 6, padding: '4px 12px', background: '#1f2937', color: '#d1d5db', border: '1px solid #374151', borderRadius: 4, cursor: 'pointer', fontSize: 11, width: 'fit-content' }} onClick={() => { setSpotShift(0); setVolShift(0); setTimeForward(0); }}>Reset All</button>
          </div>
        </Panel>

        <Panel title="Scenario Output">
          <div className="kv-grid two-col">
            <div><span>Strategy</span><strong style={{ color: '#a5b4fc' }}>{risk?.strategy_type || '-'}</strong></div>
            <div><span>Spot</span><strong>{formatNumber(spot, 2)}</strong></div>
            <div><span>Base PnL</span><strong>{formatNumber(basePnl, 2)}</strong></div>
            <div><span>Scenario PnL</span><strong style={{ color: scenarioPnl >= 0 ? '#22c55e' : '#ef4444' }}>{formatNumber(scenarioPnl, 2)}</strong></div>
            <div><span>Δ (base)</span><strong>{formatNumber(delta, 4)}</strong></div>
            <div><span>Δ (scenario)</span><strong style={{ color: '#60a5fa' }}>{formatNumber(scenarioDelta, 4)}</strong></div>
            <div><span>Γ</span><strong>{formatNumber(gamma, 6)}</strong></div>
            <div><span>V (Vega)</span><strong>{formatNumber(vega, 4)}</strong></div>
            <div><span>Θ /day</span><strong>{formatNumber(theta, 4)}</strong></div>
            <div><span>Base VaR 95</span><strong style={{ color: '#f59e0b' }}>{formatNumber(baseVar95, 2)}</strong></div>
            <div><span>Base VaR 99</span><strong style={{ color: '#f43f5e' }}>{formatNumber(baseVar99, 2)}</strong></div>
            <div><span>Expected Shortfall</span><strong style={{ color: '#f43f5e' }}>{formatNumber(baseEs, 2)}</strong></div>
          </div>
        </Panel>

        <Panel title="Spot Sensitivity (PnL vs Spot Shift)">
          <Plot
            data={[
              {
                type: 'scatter',
                mode: 'lines+markers',
                x: SPOT_AXIS.map((s) => `${s > 0 ? '+' : ''}${s}%`),
                y: spotCurve,
                line: { color: '#38bdf8', width: 2 },
                marker: { size: 5 },
                name: 'PnL',
              },
              {
                type: 'scatter',
                mode: 'lines',
                x: SPOT_AXIS.map((s) => `${s > 0 ? '+' : ''}${s}%`),
                y: SPOT_AXIS.map(() => 0),
                line: { color: '#6b7280', width: 1, dash: 'dash' },
                showlegend: false,
              },
            ]}
            layout={{
              height: 200,
              margin: { l: 50, r: 20, b: 36, t: 10 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Spot Shift', gridcolor: '#1f2937' },
              yaxis: { title: 'PnL', gridcolor: '#1f2937' },
              legend: { orientation: 'h', y: 1.15, font: { size: 9 } },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="Vol Sensitivity (PnL vs IV Shift)">
          <Plot
            data={[
              {
                type: 'scatter',
                mode: 'lines+markers',
                x: VOL_AXIS.map((v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%`),
                y: volCurve,
                line: { color: '#a78bfa', width: 2 },
                marker: { size: 5 },
                name: 'PnL',
              },
              {
                type: 'scatter',
                mode: 'lines',
                x: VOL_AXIS.map((v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%`),
                y: VOL_AXIS.map(() => 0),
                line: { color: '#6b7280', width: 1, dash: 'dash' },
                showlegend: false,
              },
            ]}
            layout={{
              height: 200,
              margin: { l: 50, r: 20, b: 36, t: 10 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'IV Shift', gridcolor: '#1f2937' },
              yaxis: { title: 'PnL', gridcolor: '#1f2937' },
              legend: { orientation: 'h', y: 1.15, font: { size: 9 } },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="PnL Heatmap (Spot × IV Shift)">
          <Plot
            data={[{
              type: 'heatmap',
              x: HEAT_SPOT.map((s) => `${s > 0 ? '+' : ''}${s}%`),
              y: HEAT_VOL.map((v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%`),
              z: heatmapZ,
              colorscale: [[0, '#ef4444'], [0.5, '#111827'], [1, '#22c55e']],
              zmid: basePnl,
              colorbar: { title: 'PnL', tickformat: '.0f' },
              hovertemplate: 'Spot: %{x}<br>IV: %{y}<br>PnL: %{z:.2f}<extra></extra>',
            }]}
            layout={{
              height: 320,
              margin: { l: 55, r: 20, b: 40, t: 10 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Spot Shift', gridcolor: '#1f2937' },
              yaxis: { title: 'IV Shift', gridcolor: '#1f2937' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        {pnlDist.length > 0 && (() => {
          const kde = buildKde(pnlDist);
          const yMax = Math.max(...kde.y) * 1.1;
          const varShapes = [];
          const varAnnotations = [];
          if (baseVar95) {
            varShapes.push({ type: 'line', x0: -baseVar95, x1: -baseVar95, y0: 0, y1: yMax, line: { color: '#f59e0b', width: 2, dash: 'dash' } });
            varAnnotations.push({ x: -baseVar95, y: yMax * 0.92, text: `VaR 95<br>${formatNumber(-baseVar95, 1)}`, showarrow: false, font: { color: '#f59e0b', size: 10 }, xanchor: 'right', xshift: -4 });
          }
          if (baseVar99) {
            varShapes.push({ type: 'line', x0: -baseVar99, x1: -baseVar99, y0: 0, y1: yMax, line: { color: '#ef4444', width: 2, dash: 'dash' } });
            varAnnotations.push({ x: -baseVar99, y: yMax * 0.78, text: `VaR 99<br>${formatNumber(-baseVar99, 1)}`, showarrow: false, font: { color: '#ef4444', size: 10 }, xanchor: 'right', xshift: -4 });
          }
          // Zero-line shape
          varShapes.push({ type: 'line', x0: 0, x1: 0, y0: 0, y1: yMax, line: { color: '#6b7280', width: 1, dash: 'dot' } });

          return (
            <Panel title="Base PnL Distribution">
              <Plot
                data={[
                  {
                    type: 'scatter', mode: 'lines',
                    x: kde.x, y: kde.y,
                    line: { color: '#38bdf8', width: 2.5 },
                    fill: 'tozeroy',
                    fillcolor: 'rgba(56, 189, 248, 0.25)',
                    name: 'PnL Density',
                    hovertemplate: 'PnL: %{x:.1f}<br>Density: %{y:.6f}<extra></extra>',
                  },
                ]}
                layout={{
                  height: 240,
                  margin: { l: 50, r: 20, b: 36, t: 10 },
                  paper_bgcolor: '#0a0f19',
                  plot_bgcolor: '#0a0f19',
                  font: { color: '#d1d5db', size: 11 },
                  xaxis: { title: 'PnL', gridcolor: '#1f2937', zerolinecolor: '#334155' },
                  yaxis: { title: 'Density', gridcolor: '#1f2937', rangemode: 'tozero' },
                  shapes: varShapes,
                  annotations: varAnnotations,
                  showlegend: true,
                  legend: { orientation: 'h', y: 1.15, font: { size: 9 } },
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            </Panel>
          );
        })()}
      </div>
    </SnapshotGuard>
  );
}
