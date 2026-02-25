import React from 'react';

export default function ProgressBar({ state }) {
  const progressByState = {
    idle: 0,
    queued: 25,
    running: 65,
    cancel_requested: 80,
    canceled: 100,
    completed: 100,
    failed: 100,
    not_found: 100,
  };

  const value = progressByState[state] ?? 0;
  const color = ['failed', 'not_found'].includes(state)
    ? '#b91c1c'
    : state === 'canceled'
      ? '#b45309'
      : '#0f766e';

  return (
    <div className="progress-wrap">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
      <div className="progress-label">Job State: {state}</div>
    </div>
  );
}
