import React from 'react';
import ProgressBar from './ProgressBar';

export default function DynamicHedgingVisualization({ dynamicState, dynamicResult, dynamicJobId, recentLogs }) {
  return (
    <section className="panel">
      <h3>Dynamic Hedging Visualization</h3>
      <ProgressBar state={dynamicState} />
      <p>Job ID: {dynamicJobId ?? '-'}</p>
      <div className="grid-two">
        <div>
          <label>Mean PnL</label>
          <p>{dynamicResult?.mean_pnl?.toFixed?.(6) ?? '-'}</p>
        </div>
        <div>
          <label>VaR 99</label>
          <p>{dynamicResult?.var_99?.toFixed?.(6) ?? '-'}</p>
        </div>
        <div>
          <label>Expected Shortfall</label>
          <p>{dynamicResult?.expected_shortfall?.toFixed?.(6) ?? '-'}</p>
        </div>
        <div>
          <label>Average Adjustments</label>
          <p>{dynamicResult?.average_adjustments?.toFixed?.(2) ?? '-'}</p>
        </div>
      </div>

      <div className="logs-block">
        <label>Function/Error Logs</label>
        <pre>{recentLogs?.length ? recentLogs.join('\n') : 'No logs yet.'}</pre>
      </div>
    </section>
  );
}
