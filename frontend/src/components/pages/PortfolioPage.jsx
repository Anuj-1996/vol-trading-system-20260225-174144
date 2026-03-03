import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Plot from 'react-plotly.js';
import { portfolioList, portfolioDelete, portfolioClear, portfolioRevalue } from '../../api/client';
import { Panel, formatNumber, formatRs, formatPctVal } from './shared.jsx';

export default function PortfolioPage({ loading, activeSnapshotId, market }) {
  const [positions, setPositions] = useState([]);
  const [totals, setTotals] = useState({ expected_pnl: 0, actual_pnl: 0, delta: 0, gamma: 0, vega: 0, theta: 0, margin: 0 });
  const [liveSpot, setLiveSpot] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revaluing, setRevaluing] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [tab, setTab] = useState('open');

  const fetchPositions = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await portfolioList(tab);
      const data = res.data || res;
      setPositions(data.positions || []);
      setTotals(data.totals || {});
    } catch (err) {
      console.error('Failed to fetch portfolio:', err);
    } finally {
      setRefreshing(false);
    }
  }, [tab]);

  useEffect(() => { fetchPositions(); }, [fetchPositions]);

  const handleRevalue = async () => {
    setRevaluing(true);
    try {
      const res = await portfolioRevalue();
      const data = res.data || res;
      setPositions(data.positions || []);
      setTotals(data.totals || {});
      if (data.live_spot) setLiveSpot(data.live_spot);
    } catch (err) {
      console.error('Revalue error:', err);
    } finally {
      setRevaluing(false);
    }
  };

  const handleDelete = async (posId) => {
    try {
      await portfolioDelete(posId);
      await fetchPositions();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleClearAll = async () => {
    if (!confirm('Delete ALL portfolio positions?')) return;
    try {
      await portfolioClear();
      await fetchPositions();
    } catch (err) {
      console.error('Clear failed:', err);
    }
  };

  const hasActualData = positions.some((p) => p.actual_pnl !== undefined);

  const comparisonData = useMemo(() => {
    if (!positions.length) return null;
    const labels = positions.map((p) => `${p.strategy_type}\n${(p.legs_label || '').slice(0, 20)}`);
    const expected = positions.map((p) => Number(p.expected_value || p.expected_pnl || 0));
    const actual = positions.map((p) => Number(p.actual_pnl ?? p.actual_ev ?? p.expected_value ?? 0));
    return { labels, expected, actual };
  }, [positions]);

  const greeksArr = useMemo(() => {
    const d = { delta: 0, gamma: 0, vega: 0, theta: 0 };
    positions.forEach((p) => {
      d.delta += Number(p.delta_exposure || 0);
      d.gamma += Number(p.gamma_exposure || 0);
      d.vega += Number(p.vega_exposure || 0);
      d.theta += Number(p.theta_exposure || 0);
    });
    return d;
  }, [positions]);

  return (
    <div className="page-portfolio-grid">
        <div className="portfolio-top">
          <Panel title="Expected PnL">
            <div className="metric-big" style={{ color: '#f59e0b' }}>
              {formatNumber(totals.expected_pnl ?? totals.pnl, 2)}
            </div>
          </Panel>
          <Panel title="Actual PnL">
            <div className="metric-big" style={{ color: Number(totals.actual_pnl ?? 0) >= 0 ? '#22c55e' : '#f43f5e' }}>
              {hasActualData ? formatNumber(totals.actual_pnl, 2) : '-'}
            </div>
          </Panel>
          <Panel title="Live Spot">
            <div className="metric-big">{liveSpot ? formatNumber(liveSpot, 2) : '-'}</div>
          </Panel>
          <Panel title="Total Delta">
            <div className="metric-big">{formatNumber(totals.delta, 4)}</div>
          </Panel>
          <Panel title="Total Margin">
            <div className="metric-big">{formatNumber(totals.margin, 2)}</div>
          </Panel>
        </div>

        <Panel title="Portfolio Controls">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="action-btn" onClick={fetchPositions} disabled={refreshing}>
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
            <button type="button" className="action-btn accent" onClick={handleRevalue} disabled={revaluing}>
              {revaluing ? 'Revaluing...' : 'Revalue with Live Data'}
            </button>
            <button type="button" className="action-btn" style={{ background: '#7f1d1d' }} onClick={handleClearAll}>
              Clear All
            </button>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <button type="button" className={`action-btn${tab === 'open' ? ' accent' : ''}`} onClick={() => setTab('open')}>Open</button>
              <button type="button" className={`action-btn${tab === 'closed' ? ' accent' : ''}`} onClick={() => setTab('closed')}>Closed</button>
            </div>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>{positions.length} position{positions.length !== 1 ? 's' : ''}</span>
          </div>
        </Panel>

        {comparisonData && (
          <Panel title="Expected vs Actual PnL Comparison">
            <Plot
              data={[
                { type: 'bar', name: 'Expected EV', x: comparisonData.labels, y: comparisonData.expected, marker: { color: '#f59e0b' } },
                { type: 'bar', name: 'Actual PnL', x: comparisonData.labels, y: comparisonData.actual, marker: { color: '#22c55e' } },
              ]}
              layout={{
                barmode: 'group',
                height: 260,
                margin: { l: 48, r: 16, b: 80, t: 20 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 10 },
                xaxis: { gridcolor: '#1f2937', tickangle: -30 },
                yaxis: { title: 'PnL', gridcolor: '#1f2937' },
                legend: { orientation: 'h', y: 1.12 },
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </Panel>
        )}

        <Panel title="Positions — Expected vs Actual">
          <div className="table-wrap">
            <table className="dense-table sortable-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Strategy</th>
                  <th>Legs</th>
                  <th>Expiry</th>
                  <th>Entry Spot</th>
                  <th>Live Spot</th>
                  <th>Spot Δ%</th>
                  <th style={{ color: '#f59e0b' }}>Exp EV</th>
                  <th style={{ color: '#22c55e' }}>Act PnL</th>
                  <th style={{ color: '#f59e0b' }}>Exp VaR95</th>
                  <th style={{ color: '#22c55e' }}>Act VaR95</th>
                  <th style={{ color: '#f59e0b' }}>Exp VaR99</th>
                  <th style={{ color: '#22c55e' }}>Act VaR99</th>
                  <th style={{ color: '#f59e0b' }}>Exp ES</th>
                  <th style={{ color: '#22c55e' }}>Act ES</th>
                  <th>Delta</th>
                  <th>Gamma</th>
                  <th>Vega</th>
                  <th>Theta</th>
                  <th>Margin</th>
                  <th>P(Loss)</th>
                  <th>Fragility</th>
                  <th>Score</th>
                  <th>Added</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {positions.length ? positions.map((pos) => (
                  <React.Fragment key={pos.id}>
                    <tr
                      className={expandedId === pos.id ? 'selected-row' : ''}
                      onClick={() => setExpandedId(expandedId === pos.id ? null : pos.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ fontSize: 10 }}>{expandedId === pos.id ? '▼' : '▶'}</td>
                      <td>{pos.strategy_type}</td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: '0.8em' }}>{pos.legs_label || '-'}</td>
                      <td style={{ color: '#38bdf8', fontSize: '0.8em' }}>{pos.expiry_date || '-'}</td>
                      <td>{formatNumber(pos.spot_at_entry, 2)}</td>
                      <td>{pos.live_spot ? formatNumber(pos.live_spot, 2) : '-'}</td>
                      <td style={{ color: Number(pos.spot_change_pct ?? 0) >= 0 ? '#22c55e' : '#f43f5e' }}>
                        {pos.spot_change_pct !== undefined ? `${pos.spot_change_pct}%` : '-'}
                      </td>
                      <td style={{ color: '#f59e0b' }}>{formatNumber(pos.expected_value, 4)}</td>
                      <td style={{ color: Number(pos.actual_pnl ?? 0) >= 0 ? '#22c55e' : '#f43f5e' }}>
                        {pos.actual_pnl !== undefined ? formatNumber(pos.actual_pnl, 4) : '-'}
                      </td>
                      <td style={{ color: '#f59e0b' }}>{formatRs(pos.var_95)}</td>
                      <td style={{ color: '#22c55e' }}>{pos.actual_var95 !== undefined ? formatRs(pos.actual_var95) : '-'}</td>
                      <td style={{ color: '#f59e0b' }}>{formatRs(pos.var_99)}</td>
                      <td style={{ color: '#22c55e' }}>{pos.actual_var99 !== undefined ? formatRs(pos.actual_var99) : '-'}</td>
                      <td style={{ color: '#f59e0b' }}>{formatRs(pos.expected_shortfall)}</td>
                      <td style={{ color: '#22c55e' }}>{pos.actual_es !== undefined ? formatRs(pos.actual_es) : '-'}</td>
                      <td>{formatNumber(pos.delta_exposure, 4)}</td>
                      <td>{formatNumber(pos.gamma_exposure, 4)}</td>
                      <td>{formatNumber(pos.vega_exposure, 4)}</td>
                      <td>{formatNumber(pos.theta_exposure, 4)}</td>
                      <td>{formatRs(pos.margin_required)}</td>
                      <td style={{ color: Number(pos.probability_of_loss ?? 0) > 0.5 ? '#f43f5e' : '#22c55e' }}>
                        {formatPctVal(pos.probability_of_loss)}
                      </td>
                      <td>{formatNumber(pos.fragility_score, 4)}</td>
                      <td>{formatPctVal(pos.overall_score)}</td>
                      <td style={{ fontSize: '0.75em', whiteSpace: 'nowrap' }}>{pos.added_at ? pos.added_at.slice(0, 16).replace('T', ' ') : '-'}</td>
                      <td>
                        <button
                          type="button"
                          className="action-btn"
                          style={{ background: '#7f1d1d', padding: '2px 8px', fontSize: 11 }}
                          onClick={(e) => { e.stopPropagation(); handleDelete(pos.id); }}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                    {expandedId === pos.id && (
                      <tr>
                        <td colSpan={25} style={{ padding: 0 }}>
                          <PositionDetailRow pos={pos} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )) : (
                  <tr><td colSpan={25} style={{ textAlign: 'center', padding: 24, color: '#6b7280' }}>
                    No portfolio positions. Add strategies from the Strategy Screener.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Portfolio Greeks Exposure">
          <Plot
            data={[{
              type: 'heatmap',
              x: ['Delta', 'Gamma', 'Vega', 'Theta'],
              y: ['Portfolio'],
              z: [[greeksArr.delta, greeksArr.gamma, greeksArr.vega, greeksArr.theta]],
              colorscale: 'Viridis',
            }]}
            layout={{
              height: 140,
              margin: { l: 60, r: 20, b: 34, t: 10 },
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
  );
}


function PositionDetailRow({ pos }) {
  const pnlDist = Array.isArray(pos.pnl_distribution) ? pos.pnl_distribution.map(Number).filter(Number.isFinite) : [];
  const hasDist = pnlDist.length > 10;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12, background: '#0d1320', borderBottom: '1px solid #1f2937' }}>
      <div>
        <h4 style={{ margin: '0 0 8px', color: '#f59e0b', fontSize: 12 }}>Expected vs Actual Metrics</h4>
        <table className="dense-table" style={{ fontSize: 11 }}>
          <thead>
            <tr><th>Metric</th><th style={{ color: '#f59e0b' }}>Expected</th><th style={{ color: '#22c55e' }}>Actual</th><th>Diff</th></tr>
          </thead>
          <tbody>
            <MetricRow label="EV / PnL" expected={pos.expected_value} actual={pos.actual_pnl ?? pos.actual_ev} />
            <MetricRow label="VaR 95" expected={pos.var_95} actual={pos.actual_var95} isRs />
            <MetricRow label="VaR 99" expected={pos.var_99} actual={pos.actual_var99} isRs />
            <MetricRow label="Expected Shortfall" expected={pos.expected_shortfall} actual={pos.actual_es} isRs />
            <MetricRow label="P(Loss)" expected={pos.probability_of_loss} actual={pos.actual_prob_loss} digits={4} isPct />
            <tr>
              <td>Entry Spot → Live</td>
              <td>{formatNumber(pos.spot_at_entry, 2)}</td>
              <td>{pos.live_spot ? formatNumber(pos.live_spot, 2) : '-'}</td>
              <td style={{ color: Number(pos.spot_change ?? 0) >= 0 ? '#22c55e' : '#f43f5e' }}>
                {pos.spot_change !== undefined ? formatNumber(pos.spot_change, 2) : '-'}
              </td>
            </tr>
          </tbody>
        </table>
        <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
          <div>Legs: {pos.legs_label || '-'}</div>
          <div>Strikes: {Array.isArray(pos.strikes) ? pos.strikes.join(', ') : '-'}</div>
          <div>Break Even: {Array.isArray(pos.break_even_levels) ? pos.break_even_levels.map((v) => Number(v).toFixed(2)).join(', ') : '-'}</div>
          <div>Margin: {formatRs(pos.margin_required)} | RoM: {formatNumber(pos.return_on_margin, 6)}</div>
        </div>
      </div>

      <div>
        {hasDist ? (
          <Plot
            data={[{
              type: 'histogram',
              x: pnlDist,
              nbinsx: 60,
              marker: { color: '#f59e0b', opacity: 0.7 },
              name: 'Expected Dist',
            }]}
            layout={{
              height: 200,
              margin: { l: 36, r: 12, b: 28, t: 12 },
              paper_bgcolor: '#0d1320',
              plot_bgcolor: '#0d1320',
              font: { color: '#d1d5db', size: 10 },
              xaxis: { title: 'PnL', gridcolor: '#1f2937' },
              yaxis: { title: 'Freq', gridcolor: '#1f2937' },
              showlegend: false,
              shapes: [
                { type: 'line', x0: 0, x1: 0, y0: 0, y1: 1, yref: 'paper', line: { color: '#6b7280', width: 1, dash: 'dash' } },
                ...(pos.actual_pnl !== undefined ? [{ type: 'line', x0: pos.actual_pnl, x1: pos.actual_pnl, y0: 0, y1: 1, yref: 'paper', line: { color: '#22c55e', width: 2 } }] : []),
              ],
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        ) : (
          <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280' }}>
            No PnL distribution stored
          </div>
        )}
      </div>
    </div>
  );
}


function MetricRow({ label, expected, actual, digits = 4, isPct = false, isRs = false }) {
  const exp = Number(expected ?? 0);
  const act = actual !== undefined && actual !== null ? Number(actual) : null;
  const diff = act !== null ? act - exp : null;
  const fmt = isRs ? (v) => formatRs(v) : isPct ? (v) => formatPctVal(v, digits) : (v) => formatNumber(v, digits);
  const fmtDiff = isRs
    ? (v) => { const rs = Number(v) * 65; return (rs >= 0 ? '+\u20B9' : '-\u20B9') + Math.abs(rs).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
    : isPct
    ? (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(digits) + '%'
    : (v) => (v >= 0 ? '+' : '') + formatNumber(v, digits);
  return (
    <tr>
      <td>{label}</td>
      <td style={{ color: '#f59e0b' }}>{fmt(expected)}</td>
      <td style={{ color: '#22c55e' }}>{act !== null ? fmt(act) : '-'}</td>
      <td style={{ color: diff !== null ? (diff >= 0 ? '#22c55e' : '#f43f5e') : '#6b7280' }}>
        {diff !== null ? fmtDiff(diff) : '-'}
      </td>
    </tr>
  );
}
