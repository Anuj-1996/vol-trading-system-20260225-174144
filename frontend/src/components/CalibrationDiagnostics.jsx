import React from 'react';

export default function CalibrationDiagnostics({ staticResult }) {
  const calibration = staticResult?.calibration;

  return (
    <section className="panel">
      <h3>Calibration Diagnostics</h3>
      <div className="grid-two">
        <div>
          <label>Converged</label>
          <p>{calibration ? String(calibration.converged) : '-'}</p>
        </div>
        <div>
          <label>Iterations</label>
          <p>{calibration?.iterations ?? '-'}</p>
        </div>
        <div>
          <label>Weighted RMSE</label>
          <p>{calibration ? calibration.weighted_rmse.toFixed(6) : '-'}</p>
        </div>
      </div>
    </section>
  );
}
