import React from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';

export default function PortfolioPage({ loading, activeSnapshotId, portfolio }) {
  const totals = portfolio?.totals || { pnl: 0, delta: 0, gamma: 0, vega: 0 };
  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-portfolio-grid">
        <div className="portfolio-top">
          <Panel title="Total PnL"><div className="metric-big">{formatNumber(totals.pnl, 2)}</div></Panel>
          <Panel title="Daily PnL"><div className="metric-big">{formatNumber(totals.pnl, 2)}</div></Panel>
          <Panel title="Total Vega"><div className="metric-big">{formatNumber(totals.vega, 2)}</div></Panel>
          <Panel title="Total Gamma"><div className="metric-big">{formatNumber(totals.gamma, 2)}</div></Panel>
          <Panel title="Total Delta"><div className="metric-big">{formatNumber(totals.delta, 2)}</div></Panel>
        </div>

        <Panel title="Positions Table">
          <div className="table-wrap">
            <table className="dense-table">
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Quantity</th>
                  <th>Price</th>
                  <th>PnL</th>
                  <th>Delta</th>
                  <th>Vega</th>
                  <th>Margin</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((item) => (
                  <tr key={item.id}>
                    <td>{item.strategy_type}</td>
                    <td>{Array.isArray(item.strikes) ? item.strikes.length : '-'}</td>
                    <td>{formatNumber(item.cost, 2)}</td>
                    <td>{formatNumber(item.expected_value, 2)}</td>
                    <td>{formatNumber(item.delta_exposure, 3)}</td>
                    <td>{formatNumber(item.vega_exposure, 3)}</td>
                    <td>{formatNumber(item.margin_required, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Portfolio Greeks Heatmap">
          <Plot
            data={[{ type: 'heatmap', x: ['Delta', 'Gamma', 'Vega'], y: ['Exposure'], z: [[totals.delta, totals.gamma, totals.vega]], colorscale: 'Viridis' }]}
            layout={{
              height: 200,
              margin: { l: 40, r: 20, b: 34, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
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
