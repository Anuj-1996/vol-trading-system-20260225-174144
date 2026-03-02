import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';

export default function StrategyDetailPage({ loading, activeSnapshotId, strategies, selectedStrategyId, risk, market }) {
  const items = Array.isArray(strategies?.items) ? strategies.items : [];
  const selected = items.find((item) => item.id === selectedStrategyId) || items[0] || null;
  const spot = Number(market?.spot ?? 0);

  const pnlDist = useMemo(() => {
    if (Array.isArray(selected?.pnl_distribution) && selected.pnl_distribution.length) {
      return selected.pnl_distribution;
    }
    return [];
  }, [selected]);

  const var95 = Number(selected?.var_95 ?? 0);
  const var99 = Number(selected?.var_99 ?? 0);
  const breakEvens = Array.isArray(selected?.break_even_levels) ? selected.break_even_levels.map(Number) : [];

  const stressRows = [
    { name: 'Spot -5%', value: Number(risk?.stress?.spot_down_5 ?? 0) },
    { name: 'Spot +5%', value: Number(risk?.stress?.spot_up_5 ?? 0) },
    { name: 'Vol +10%', value: Number(risk?.stress?.vol_up_10 ?? 0) },
    { name: 'Vol Crush', value: Number(risk?.stress?.vol_crush ?? 0) },
    { name: 'Time Decay 1W', value: Number(risk?.stress?.time_decay_1w ?? 0) },
  ];

  const payoffAxis = Array.from({ length: 41 }, (_, index) => spot * (0.85 + index * 0.0075));
  const selectedDelta = Number(selected?.delta_exposure ?? 0);
  const selectedGamma = Number(selected?.gamma_exposure ?? 0);
  const payoffValues = payoffAxis.map((nodeSpot) => {
    const displacement = (nodeSpot - spot) / Math.max(spot, 1e-8);
    return Number(selected?.expected_value ?? 0) + selectedDelta * displacement * spot + 0.5 * selectedGamma * displacement * displacement * spot;
  });

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-detail-grid">
        <Panel title="Key Metrics">
          <div className="kv-grid two-col compact">
            <div><span>Strategy</span><strong>{selected?.strategy_type || '-'}</strong></div>
            <div><span>Strikes</span><strong>{Array.isArray(selected?.strikes) ? selected.strikes.join(', ') : '-'}</strong></div>
            <div><span>Cost / Margin</span><strong>{formatNumber(selected?.cost, 2)}</strong></div>
            <div><span>Expected Value</span><strong style={{color: Number(selected?.expected_value ?? 0) >= 0 ? '#22c55e' : '#f43f5e'}}>{formatNumber(selected?.expected_value, 4)}</strong></div>
            <div><span>Return on Margin</span><strong>{formatNumber(selected?.return_on_margin, 6)}</strong></div>
            <div><span>Overall Score</span><strong>{formatNumber(selected?.overall_score, 6)}</strong></div>
            <div><span>P(Loss)</span><strong style={{color: Number(selected?.probability_of_loss ?? 0) > 0.5 ? '#f43f5e' : '#22c55e'}}>{formatNumber(selected?.probability_of_loss, 4)}</strong></div>
            <div><span>Max Loss</span><strong style={{color: '#f43f5e'}}>{formatNumber(selected?.max_loss, 2)}</strong></div>
            <div><span>VaR 95</span><strong>{formatNumber(selected?.var_95, 4)}</strong></div>
            <div><span>VaR 99</span><strong>{formatNumber(selected?.var_99, 4)}</strong></div>
            <div><span>Exp. Shortfall</span><strong>{formatNumber(selected?.expected_shortfall, 4)}</strong></div>
            <div><span>Fragility</span><strong>{formatNumber(selected?.fragility_score, 6)}</strong></div>
          </div>
        </Panel>

        <Panel title="Payoff At Expiry">
          <Plot
            data={[
              { type: 'scatter', mode: 'lines', x: payoffAxis, y: payoffValues, line: { color: '#38bdf8', width: 2 }, name: 'Payoff' },
              { type: 'scatter', mode: 'lines', x: [payoffAxis[0], payoffAxis[payoffAxis.length-1]], y: [0, 0], line: { color: '#4b5563', width: 1, dash: 'dot' }, showlegend: false },
              ...breakEvens.filter(be => be > payoffAxis[0] && be < payoffAxis[payoffAxis.length-1]).map((be, i) => ({
                type: 'scatter', mode: 'lines', x: [be, be], y: [Math.min(...payoffValues), Math.max(...payoffValues)],
                line: { color: '#f59e0b', width: 1.5, dash: 'dash' }, name: i === 0 ? 'Break-even' : undefined, showlegend: i === 0,
              })),
            ]}
            layout={{
              height: 220,
              margin: { l: 32, r: 12, b: 24, t: 18 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Spot at Expiry', gridcolor: '#1f2937' },
              yaxis: { title: 'PnL', gridcolor: '#1f2937' },
              showlegend: true,
              legend: { orientation: 'h', y: 1.15, font: { size: 9 } },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="PnL Distribution Histogram">
          <Plot
            data={[
              { type: 'histogram', x: pnlDist, marker: { color: '#f59e0b' }, nbinsx: 30, name: 'PnL' },
              ...(var95 ? [{ type: 'scatter', mode: 'lines', x: [-var95, -var95], y: [0, pnlDist.length * 0.08], line: { color: '#fb923c', width: 2, dash: 'dash' }, name: 'VaR 95' }] : []),
              ...(var99 ? [{ type: 'scatter', mode: 'lines', x: [-var99, -var99], y: [0, pnlDist.length * 0.08], line: { color: '#f43f5e', width: 2, dash: 'dash' }, name: 'VaR 99' }] : []),
            ]}
            layout={{
              height: 220,
              margin: { l: 32, r: 12, b: 24, t: 18 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'PnL', gridcolor: '#1f2937' },
              yaxis: { title: 'Count', gridcolor: '#1f2937' },
              legend: { orientation: 'h', y: 1.15, font: { size: 9 } },
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

        <Panel title="Stress Scenario Bars">
          <Plot
            data={[{ type: 'bar', x: stressRows.map((row) => row.name), y: stressRows.map((row) => row.value), marker: { color: stressRows.map((row) => (row.value >= 0 ? '#22c55e' : '#f43f5e')) } }]}
            layout={{
              height: 220,
              margin: { l: 32, r: 12, b: 30, t: 18 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { gridcolor: '#1f2937' },
              yaxis: { title: 'PnL Impact', gridcolor: '#1f2937' },
              showlegend: false,
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
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
