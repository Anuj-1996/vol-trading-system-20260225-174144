import React, { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';

export default function BacktestPage({ loading, activeSnapshotId, backtest }) {

  if (!backtest) {
    return (
      <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
        <div className="snapshot-placeholder">No backtest results available. Run a pipeline first — backtest is synthesized from MC PnL distributions.</div>
      </SnapshotGuard>
    );
  }

  const equityCurve = Array.isArray(backtest.equity_curve) ? backtest.equity_curve : [];
  const drawdownCurve = Array.isArray(backtest.drawdown_curve) ? backtest.drawdown_curve : [];
  const pnlSeries = Array.isArray(backtest.pnl_series) ? backtest.pnl_series : [];
  const holdDays = Number(backtest.hold_days_to_maturity || backtest.periods || 1);
  const annualizationFactor = Math.sqrt(252 / Math.max(holdDays, 1));
  const m = backtest.metrics || {};
  const xLabels = equityCurve.map((_, i) => i);

  // Running Sharpe (expanding window)
  const runningSharpe = useMemo(() => {
    const result = [];
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < pnlSeries.length; i++) {
      sum += pnlSeries[i];
      sumSq += pnlSeries[i] ** 2;
      const n = i + 1;
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      const std = Math.sqrt(Math.max(0, variance));
      result.push(std > 1e-10 ? (mean / std) * annualizationFactor : 0);
    }
    return result;
  }, [pnlSeries, annualizationFactor]);

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-backtest-grid">
        <Panel title="Backtest Summary" className="backtest-controls">
          <div className="kv-grid two-col" style={{ marginBottom: 8 }}>
            <div><span>Strategy</span><strong style={{ color: '#a5b4fc' }}>{backtest.strategy_name || '-'}</strong></div>
            <div><span>Hold Days (to expiry)</span><strong>{backtest.hold_days_to_maturity || backtest.periods || '-'}</strong></div>
          </div>
          <p style={{ fontSize: 10, color: '#6b7280', margin: '0 0 4px' }}>Walk-forward simulation: each trade holds till maturity and samples from the selected strategy MC PnL distribution.</p>
        </Panel>

        <Panel title="Performance Metrics" className="backtest-metrics">
          <table className="dense-table">
            <thead>
              <tr><th>Metric</th><th>Value</th></tr>
            </thead>
            <tbody>
              <tr><td>Sharpe (ann.)</td><td style={{ color: m.sharpe >= 1 ? '#22c55e' : m.sharpe >= 0 ? '#d1d5db' : '#ef4444' }}>{formatNumber(m.sharpe, 3)}</td></tr>
              <tr><td>Sortino (ann.)</td><td style={{ color: m.sortino >= 1 ? '#22c55e' : '#d1d5db' }}>{formatNumber(m.sortino, 3)}</td></tr>
              <tr><td>Win Rate</td><td>{(m.win_rate * 100).toFixed(1)}%</td></tr>
              <tr><td>Max Drawdown</td><td style={{ color: '#f43f5e' }}>{formatNumber(m.max_drawdown, 2)}</td></tr>
              <tr><td>Total Return</td><td style={{ color: m.total_return >= 0 ? '#22c55e' : '#ef4444' }}>{formatNumber(m.total_return, 2)}</td></tr>
              <tr><td>Mean PnL</td><td>{formatNumber(m.mean_pnl, 2)}</td></tr>
              <tr><td>Std PnL</td><td>{formatNumber(m.std_pnl, 2)}</td></tr>
              <tr><td>Best Day</td><td style={{ color: '#22c55e' }}>{formatNumber(m.best_day, 2)}</td></tr>
              <tr><td>Worst Day</td><td style={{ color: '#ef4444' }}>{formatNumber(m.worst_day, 2)}</td></tr>
              <tr><td>Backtest Overfit Prob.</td><td>{m.pbo != null ? `${(Number(m.pbo) * 100).toFixed(1)}%` : '-'}</td></tr>
            </tbody>
          </table>
        </Panel>

        <Panel title="Equity Curve">
          <Plot
            data={[
              { type: 'scatter', mode: 'lines', x: xLabels, y: equityCurve, line: { color: '#22c55e', width: 2 }, name: 'Equity', fill: 'tozeroy', fillcolor: 'rgba(34,197,94,0.07)' },
              { type: 'scatter', mode: 'lines', x: xLabels, y: xLabels.map(() => 0), line: { color: '#6b7280', width: 1, dash: 'dash' }, showlegend: false },
            ]}
            layout={{
              height: 260,
              margin: { l: 50, r: 20, b: 36, t: 10 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Trading Period', gridcolor: '#1f2937' },
              yaxis: { title: 'Cumulative PnL', gridcolor: '#1f2937' },
              legend: { orientation: 'h', y: 1.1, font: { size: 9 } },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="Drawdown">
          <Plot
            data={[
              { type: 'scatter', mode: 'lines', x: xLabels.slice(0, drawdownCurve.length), y: drawdownCurve.map((d) => -d), line: { color: '#f43f5e', width: 2 }, name: 'Drawdown', fill: 'tozeroy', fillcolor: 'rgba(244,63,94,0.1)' },
            ]}
            layout={{
              height: 200,
              margin: { l: 50, r: 20, b: 36, t: 10 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Trading Period', gridcolor: '#1f2937' },
              yaxis: { title: 'Drawdown', gridcolor: '#1f2937' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="Per-Period PnL">
          <Plot
            data={[{
              type: 'bar',
              x: pnlSeries.map((_, i) => i),
              y: pnlSeries,
              marker: { color: pnlSeries.map((p) => p >= 0 ? '#22c55e' : '#ef4444'), opacity: 0.8 },
              name: 'PnL',
            }]}
            layout={{
              height: 200,
              margin: { l: 50, r: 20, b: 36, t: 10 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Trading Period', gridcolor: '#1f2937' },
              yaxis: { title: 'PnL', gridcolor: '#1f2937' },
              bargap: 0.1,
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="Rolling Sharpe (Expanding)">
          <Plot
            data={[
              { type: 'scatter', mode: 'lines', x: runningSharpe.map((_, i) => i), y: runningSharpe, line: { color: '#38bdf8', width: 2 }, name: 'Sharpe' },
              { type: 'scatter', mode: 'lines', x: [0, runningSharpe.length - 1], y: [1, 1], line: { color: '#22c55e', width: 1, dash: 'dot' }, showlegend: false },
              { type: 'scatter', mode: 'lines', x: [0, runningSharpe.length - 1], y: [0, 0], line: { color: '#6b7280', width: 1, dash: 'dash' }, showlegend: false },
            ]}
            layout={{
              height: 200,
              margin: { l: 50, r: 20, b: 36, t: 10 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Trading Period', gridcolor: '#1f2937' },
              yaxis: { title: 'Sharpe Ratio', gridcolor: '#1f2937' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="PnL Distribution (Backtest)">
          <Plot
            data={[{
              type: 'histogram',
              x: pnlSeries,
              nbinsx: 50,
              marker: { color: '#38bdf8', opacity: 0.75 },
              name: 'PnL Dist',
            }]}
            layout={{
              height: 200,
              margin: { l: 50, r: 20, b: 36, t: 10 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'PnL', gridcolor: '#1f2937' },
              yaxis: { title: 'Count', gridcolor: '#1f2937' },
              bargap: 0.02,
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
