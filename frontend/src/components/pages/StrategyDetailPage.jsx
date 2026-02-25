import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';

export default function StrategyDetailPage({ loading, activeSnapshotId, strategies, selectedStrategyId, risk, market }) {
  const items = Array.isArray(strategies?.items) ? strategies.items : [];
  const selected = items.find((item) => item.id === selectedStrategyId) || items[0] || null;

  const pnlDist = useMemo(() => {
    if (Array.isArray(selected?.pnl_distribution) && selected.pnl_distribution.length) {
      return selected.pnl_distribution;
    }
    return [];
  }, [selected]);

  const stressRows = [
    { name: 'Spot -5%', value: Number(risk?.stress?.spot_down_5 ?? 0) },
    { name: 'Spot +5%', value: Number(risk?.stress?.spot_up_5 ?? 0) },
    { name: 'Vol +10%', value: Number(risk?.stress?.vol_up_10 ?? 0) },
    { name: 'Vol Crush', value: Number(risk?.stress?.vol_crush ?? 0) },
    { name: 'Time Decay 1W', value: Number(risk?.stress?.time_decay_1w ?? 0) },
  ];

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-detail-grid">
        <Panel title="Payoff At Expiry">
          <Plot
            data={[{ type: 'scatter', mode: 'lines+markers', x: selected?.strikes || [], y: (selected?.strikes || []).map((strike) => (Number(strike) - Number(market?.spot || 0)) * Number(selected?.delta_exposure || 0)), line: { color: '#38bdf8', width: 2 } }]}
            layout={{
              height: 220,
              margin: { l: 32, r: 12, b: 24, t: 18 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Spot at Expiry', gridcolor: '#1f2937' },
              yaxis: { title: 'PnL', gridcolor: '#1f2937' },
              showlegend: false,
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="PnL Distribution Histogram">
          <Plot
            data={[{ type: 'histogram', x: pnlDist, marker: { color: '#f59e0b' }, nbinsx: 30 }]}
            layout={{
              height: 220,
              margin: { l: 32, r: 12, b: 24, t: 18 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'PnL', gridcolor: '#1f2937' },
              yaxis: { title: 'Count', gridcolor: '#1f2937' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="Greeks vs Spot">
          <Plot
            data={[
              { type: 'scatter', mode: 'lines', x: selected?.strikes || [], y: (selected?.strikes || []).map((strike) => Number(selected?.delta_exposure ?? 0) * (1 + (Number(strike) - Number(market?.spot || strike)) / Math.max(1, Number(market?.spot || strike)))), name: 'Delta', line: { color: '#22c55e' } },
              { type: 'scatter', mode: 'lines', x: selected?.strikes || [], y: (selected?.strikes || []).map((strike) => Number(selected?.gamma_exposure ?? 0) * (1 + Math.abs(Number(strike) - Number(market?.spot || strike)) / Math.max(1, Number(market?.spot || strike)))), name: 'Gamma', line: { color: '#38bdf8' } },
            ]}
            layout={{
              height: 220,
              margin: { l: 32, r: 12, b: 24, t: 18 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Spot Proxy', gridcolor: '#1f2937' },
              yaxis: { title: 'Greek', gridcolor: '#1f2937' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="Greeks vs Vol Shift">
          <Plot
            data={[{ type: 'scatter', mode: 'lines+markers', x: [-20, -10, 0, 10, 20], y: [-20, -10, 0, 10, 20].map((shift) => Number(selected?.vega_exposure ?? 0) * (1 + shift / 100)), line: { color: '#f43f5e', width: 2 } }]}
            layout={{
              height: 220,
              margin: { l: 32, r: 12, b: 24, t: 18 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Vol Shift %', gridcolor: '#1f2937' },
              yaxis: { title: 'Vega Response', gridcolor: '#1f2937' },
              showlegend: false,
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="Monte Carlo Paths">
          <Plot
            data={Array.from({ length: Math.min(10, pnlDist.length || 0) }, (_, index) => ({ type: 'scatter', mode: 'lines', x: [0, 1, 2, 3, 4], y: [0, pnlDist[index] * 0.25, pnlDist[index] * 0.5, pnlDist[index] * 0.75, pnlDist[index]], line: { width: 1 }, showlegend: false }))}
            layout={{
              height: 220,
              margin: { l: 32, r: 12, b: 24, t: 18 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Step', gridcolor: '#1f2937' },
              yaxis: { title: 'PnL Path', gridcolor: '#1f2937' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="Stress Scenarios">
          <table className="dense-table">
            <thead><tr><th>Scenario</th><th>PnL Impact</th></tr></thead>
            <tbody>
              {stressRows.map((row) => (
                <tr key={row.name}><td>{row.name}</td><td>{formatNumber(row.value, 4)}</td></tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Risk Decomposition Pie">
          <Plot
            data={[{ type: 'pie', labels: ['Gamma contribution', 'Vega contribution', 'Theta', 'Skew'], values: [Math.abs(Number(selected?.gamma_exposure ?? 0)), Math.abs(Number(selected?.vega_exposure ?? 0)), Math.abs(Number(selected?.theta_exposure ?? 0)), Math.abs(Number(selected?.skew_exposure ?? 0))], hole: 0.45 }]}
            layout={{ height: 220, margin: { l: 12, r: 12, b: 12, t: 12 }, paper_bgcolor: '#0a0f19', font: { color: '#d1d5db', size: 11 } }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
      </div>
    </SnapshotGuard>
  );
}
