import React from 'react';

export default function MarketOverviewPanel({ staticResult }) {
  const calibration = staticResult?.calibration;
  const regime = staticResult?.regime;
  const overview = staticResult?.market_overview;

  return (
    <section className="panel">
      <h3>Market Overview</h3>
      <div className="grid-two">
        <div>
          <label>Spot</label>
          <p>{overview ? overview.spot.toFixed(2) : staticResult?.requestSpot ?? '-'}</p>
        </div>
        <div>
          <label>ATM IV</label>
          <p>{overview ? (overview.atm_market_iv * 100).toFixed(2) : '-'}</p>
        </div>
        <div>
          <label>Realized vs Implied Spread</label>
          <p>{overview ? overview.realized_implied_spread.toFixed(6) : '-'}</p>
        </div>
        <div>
          <label>Regime</label>
          <p>{regime ? `${regime.label} (${(regime.confidence * 100).toFixed(1)}%)` : '-'}</p>
        </div>
        <div>
          <label>Calibration RMSE</label>
          <p>{calibration ? calibration.weighted_rmse.toFixed(6) : '-'}</p>
        </div>
      </div>
    </section>
  );
}
