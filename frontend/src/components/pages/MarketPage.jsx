import React from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber, formatPct } from './shared.jsx';

export default function MarketPage({ loading, activeSnapshotId, market, surface, selectedExpiryIndex = 0 }) {
  const strikeGrid = Array.isArray(surface?.strike_grid) ? surface.strike_grid : [];
  const marketMatrix = Array.isArray(surface?.market_iv_matrix) ? surface.market_iv_matrix : [];
  const marketSlice = marketMatrix[selectedExpiryIndex] || marketMatrix[0] || [];
  const termDays = Array.isArray(market?.term_structure_days) ? market.term_structure_days : [];
  const termMarketAtm = Array.isArray(market?.term_structure_market_atm) ? market.term_structure_market_atm : [];
  const termModelAtm = Array.isArray(market?.term_structure_model_atm) ? market.term_structure_model_atm : [];
  const spot = Number(market?.spot ?? 0);
  const hasSingleExpiry = termDays.length <= 1;
  const history = market?.price_history || null;
  const hasHistory = Boolean(history && Array.isArray(history.dates) && history.dates.length > 2);

  const rv20Series = hasHistory ? history.rv20_annualized : [];
  const rv60Series = hasHistory ? history.rv60_annualized : [];
  const volumeSeries = hasHistory ? history.volume || [] : [];
  const spotSpreadPct = market?.atm_iv && market?.rv_20d ? ((Number(market.atm_iv) - Number(market.rv_20d)) * 100) : null;

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-market-grid">
        <div className="market-price-wide">
          <Panel title="Price Chart">
            <Plot
              data={[
                ...(hasHistory
                  ? [
                      {
                        type: 'candlestick',
                        x: history.dates,
                        open: history.open,
                        high: history.high,
                        low: history.low,
                        close: history.close,
                        name: 'Price',
                        increasing: { line: { color: '#22c55e' } },
                        decreasing: { line: { color: '#ef4444' } },
                      },
                      {
                        type: 'bar',
                        x: history.dates,
                        y: volumeSeries,
                        name: 'Volume',
                        yaxis: 'y2',
                        marker: { color: '#334155', opacity: 0.7 },
                      },
                      {
                        type: 'scatter',
                        mode: 'lines',
                        x: history.dates,
                        y: rv20Series,
                        name: '20D RV',
                        yaxis: 'y3',
                        line: { color: '#38bdf8', width: 1.5 },
                      },
                      {
                        type: 'scatter',
                        mode: 'lines',
                        x: history.dates,
                        y: rv60Series,
                        name: '60D RV',
                        yaxis: 'y3',
                        line: { color: '#f59e0b', width: 1.5 },
                      },
                    ]
                  : [
                      {
                        type: 'scatter',
                        mode: 'lines+markers',
                        x: ['t-1', 't'],
                        y: [spot, spot],
                        line: { color: '#f59e0b', width: 2 },
                        name: 'Spot',
                      },
                    ]),
              ]}
              layout={{
                height: 360,
                margin: { l: 36, r: 40, b: 28, t: 22 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 11 },
                xaxis: { title: 'Date', gridcolor: '#1f2937' },
                yaxis: { title: 'Price', gridcolor: '#1f2937' },
                yaxis2: {
                  title: 'Volume',
                  overlaying: 'y',
                  side: 'right',
                  showgrid: false,
                  zeroline: false,
                },
                yaxis3: {
                  title: 'RV',
                  overlaying: 'y',
                  side: 'right',
                  gridcolor: '#1f2937',
                  tickformat: '.2f',
                  position: 0.94,
                },
                showlegend: true,
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
            <div className="kv-grid two-col compact">
              <div><span>20D RV</span><strong>{formatPct(market?.rv_20d, 2)}</strong></div>
              <div><span>60D RV</span><strong>{formatPct(market?.rv_60d, 2)}</strong></div>
              <div><span>Volume (last)</span><strong>{formatNumber(volumeSeries[volumeSeries.length - 1], 0)}</strong></div>
              <div><span>ATM IV - 20D RV (pts)</span><strong>{spotSpreadPct !== null ? formatNumber(spotSpreadPct, 2) : '-'}</strong></div>
            </div>
          </Panel>
        </div>

        <div className="col-left">
          <Panel title="Realized Vol Metrics">
            <div className="kv-grid two-col">
              <div><span>10D RV</span><strong>{formatPct(market?.rv_10d, 2)}</strong></div>
              <div><span>20D RV</span><strong>{formatPct(market?.rv_20d, 2)}</strong></div>
              <div><span>60D RV</span><strong>{formatPct(market?.rv_60d, 2)}</strong></div>
              <div><span>RV Percentile</span><strong>{formatNumber(market?.rv_percentile, 2)}%</strong></div>
            </div>
          </Panel>
        </div>

        <div className="col-middle">
          <Panel title="IV Term Structure">
            <Plot
              data={[
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: termDays,
                  y: termMarketAtm,
                  line: { color: '#22c55e', width: 2 },
                  name: 'Market ATM IV',
                },
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: termDays,
                  y: termModelAtm,
                  line: { color: '#f59e0b', width: 2 },
                  name: 'Model ATM IV',
                },
              ]}
              layout={{
                height: 220,
                margin: { l: 36, r: 12, b: 28, t: 22 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 11 },
                xaxis: { title: 'Days', gridcolor: '#1f2937' },
                yaxis: { title: 'ATM IV', gridcolor: '#1f2937' },
                annotations: hasSingleExpiry
                  ? [
                      {
                        xref: 'paper',
                        yref: 'paper',
                        x: 0.02,
                        y: 0.96,
                        text: 'Single-expiry snapshot: term structure has one point',
                        showarrow: false,
                        font: { color: '#9ca3af', size: 10 },
                      },
                    ]
                  : [],
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </Panel>
          <Panel title="Skew Curve">
            <Plot
              data={[{ type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: marketSlice, line: { color: '#38bdf8', width: 2 } }]}
              layout={{
                height: 220,
                margin: { l: 36, r: 12, b: 28, t: 22 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 11 },
                xaxis: { title: 'Strike', gridcolor: '#1f2937' },
                yaxis: { title: 'IV', gridcolor: '#1f2937' },
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </Panel>
        </div>

        <div className="col-right">
          <Panel title="Market Regime Box">
            <div className="kv-grid one-col">
              <div><span>Trend Regime</span><strong style={{color: market?.regime?.label === 'high_vol' ? '#ef4444' : '#22c55e'}}>{market?.regime?.label || '-'}</strong></div>
              <div><span>Vol Regime (IV/RV)</span><strong>{market?.regime?.volatility_regime_score != null ? Number(market.regime.volatility_regime_score).toFixed(2) + 'x' : '-'}</strong></div>
              <div><span>Skew (Put-Call)</span><strong>{market?.regime?.skew_regime_score != null ? (Number(market.regime.skew_regime_score) * 100).toFixed(2) + ' pts' : '-'}</strong></div>
              <div><span>Confidence</span><strong>{market?.regime?.confidence != null ? (Number(market.regime.confidence) * 100).toFixed(1) + '%' : '-'}</strong></div>
            </div>
          </Panel>
          <Panel title="Vol Stats">
            <div className="kv-grid one-col">
              <div><span>ATM Market IV</span><strong style={{color:'#f59e0b'}}>{market?.atm_iv != null ? (Number(market.atm_iv) * 100).toFixed(2) + '%' : '-'}</strong></div>
              <div><span>ATM Model IV</span><strong>{market?.atm_model_iv != null ? (Number(market.atm_model_iv) * 100).toFixed(2) + '%' : '-'}</strong></div>
              <div><span>IV Rank</span><strong>{market?.iv_rank != null ? Number(market.iv_rank).toFixed(1) + '%' : '-'}</strong></div>
              <div><span>IV Percentile</span><strong>{market?.iv_percentile != null ? Number(market.iv_percentile).toFixed(1) + '%' : '-'}</strong></div>
              <div><span>IV-RV Spread</span><strong style={{color: Number(market?.realized_implied_spread ?? 0) >= 0 ? '#22c55e' : '#ef4444'}}>{market?.realized_implied_spread != null ? (Number(market.realized_implied_spread) * 100).toFixed(2) + ' pts' : '-'}</strong></div>
              <div><span>VVIX Equivalent</span><strong>{market?.vvix_equivalent != null ? (Number(market.vvix_equivalent) * 100).toFixed(2) + '%' : '-'}</strong></div>
            </div>
            <Plot
              data={[
                {
                  type: 'bar',
                  x: ['IV Rank', 'IV Pctl', 'RV Pctl'],
                  y: [
                    Number(market?.iv_rank ?? 0),
                    Number(market?.iv_percentile ?? 0),
                    Number(market?.rv_percentile ?? 0),
                  ],
                  marker: { color: ['#f59e0b', '#22c55e', '#38bdf8'] },
                },
              ]}
              layout={{
                height: 160,
                margin: { l: 30, r: 12, b: 28, t: 8 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 10 },
                xaxis: { gridcolor: '#1f2937' },
                yaxis: { title: 'Percentile', gridcolor: '#1f2937', range: [0, 100] },
                showlegend: false,
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </Panel>
        </div>
      </div>
    </SnapshotGuard>
  );
}
