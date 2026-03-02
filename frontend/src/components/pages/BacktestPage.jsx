import React from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';

export default function BacktestPage({ loading, activeSnapshotId, backtest }) {
  if (!backtest) {
    return (
      <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
        <div className="snapshot-placeholder">No backtest results available. Run backtest first.</div>
      </SnapshotGuard>
    );
  }

  const equityCurve = Array.isArray(backtest.equity_curve) ? backtest.equity_curve : [];
  const drawdownCurve = Array.isArray(backtest.drawdown_curve) ? backtest.drawdown_curve : [];
  const metrics = backtest.metrics || {};
  const controls = backtest.controls || {};

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-backtest-grid">
        <Panel title="Backtest Controls" className="backtest-controls">
          <div className="filters-grid">
            <label>Start date
              <input type="text" value={controls.start_date || 'Auto'} readOnly />
            </label>
            <label>End date
              <input type="text" value={controls.end_date || 'Auto'} readOnly />
            </label>
            <label>Rebalance frequency
              <input type="text" value={controls.rebalance_frequency || 'Daily'} readOnly />
            </label>
            <label>Hedge frequency
              <input type="text" value={controls.hedge_frequency || 'Daily'} readOnly />
            </label>
            <label>Slippage assumption
              <input type="text" value={controls.slippage_assumption || '0.05%'} readOnly />
            </label>
          </div>
        </Panel>

        <Panel title="Equity Curve">
          <Plot
            data={[{ type: 'scatter', mode: 'lines', x: equityCurve.map((_, index) => index), y: equityCurve, line: { color: '#22c55e', width: 2 } }]}
            layout={{
              height: 250,
              margin: { l: 38, r: 20, b: 32, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Step', gridcolor: '#1f2937' },
              yaxis: { title: 'Equity', gridcolor: '#1f2937' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
        <Panel title="Drawdown Chart">
          <Plot
            data={[{ type: 'scatter', mode: 'lines', x: drawdownCurve.map((_, index) => index), y: drawdownCurve, line: { color: '#f43f5e', width: 2 } }]}
            layout={{
              height: 250,
              margin: { l: 38, r: 20, b: 32, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Step', gridcolor: '#1f2937' },
              yaxis: { title: 'Drawdown', gridcolor: '#1f2937' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
        <Panel title="Performance Metrics" className="backtest-metrics">
          <table className="dense-table">
            <thead>
              <tr><th>Metric</th><th>Value</th></tr>
            </thead>
            <tbody>
              <tr><td>CAGR</td><td>{formatNumber(metrics.cagr, 4)}</td></tr>
              <tr><td>Sharpe</td><td>{formatNumber(metrics.sharpe, 4)}</td></tr>
              <tr><td>Sortino</td><td>{formatNumber(metrics.sortino, 4)}</td></tr>
              <tr><td>Max DD</td><td>{formatNumber(metrics.max_drawdown, 4)}</td></tr>
              <tr><td>Win rate</td><td>{formatNumber(metrics.win_rate, 4)}</td></tr>
            </tbody>
          </table>
        </Panel>
      </div>
    </SnapshotGuard>
  );
}
