import React from 'react';

export function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '-';
  }
  return Number(value).toFixed(digits);
}

export function Panel({ title, children, className = '', onMaximize }) {
  return (
    <section className={`bbg-panel ${className}`.trim()}>
      <header className="bbg-panel-header">
        <span>{title}</span>
        {onMaximize && (
          <button className="maximize-btn" onClick={onMaximize} title="Maximize" type="button">
            ⛶
          </button>
        )}
      </header>
      <div className="bbg-panel-body">{children}</div>
    </section>
  );
}

export function SnapshotGuard({ loading, activeSnapshotId, children }) {
  if (loading) {
    return <div className="snapshot-placeholder">Loading snapshot...</div>;
  }
  if (!activeSnapshotId) {
    return <div className="snapshot-placeholder">Click "Fetch Live &amp; Analyse" to load data from NSE</div>;
  }
  return children;
}
