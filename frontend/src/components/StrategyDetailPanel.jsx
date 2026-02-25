import React from 'react';
import Plot from 'react-plotly.js';

export default function StrategyDetailPanel({ strategy }) {
  const hasData = Boolean(strategy);
  const x = hasData ? ['Expected Return', 'VaR 99', 'Expected Shortfall', 'Return on Margin', 'Fragility'] : [];
  const y = hasData
    ? [
        strategy.expected_value ?? 0,
        strategy.var_99 ?? 0,
        strategy.expected_shortfall ?? 0,
        strategy.return_on_margin ?? 0,
        strategy.fragility_score ?? 0,
      ]
    : [];

  return (
    <section className="panel">
      <h3>Strategy Detail Panel</h3>
      {hasData ? (
        <>
          <p>
            Selected: {strategy.strategy_type} | Strikes:{' '}
            {Array.isArray(strategy.strikes) ? strategy.strikes.join(', ') : strategy.strikes}
          </p>
          <Plot
            data={[{ x, y, type: 'bar', marker: { color: '#0f766e' } }]}
            layout={{
              title: 'PnL and Risk Profile',
              height: 300,
              margin: { l: 40, r: 20, t: 40, b: 40 },
            }}
            style={{ width: '100%' }}
            useResizeHandler
            config={{ displaylogo: false, responsive: true }}
          />
        </>
      ) : (
        <p>No strategy selected.</p>
      )}
    </section>
  );
}
