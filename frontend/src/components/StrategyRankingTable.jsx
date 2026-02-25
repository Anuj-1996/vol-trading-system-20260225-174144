import React from 'react';

export default function StrategyRankingTable({ strategies, selectedIndex, onSelect }) {
  return (
    <section className="panel">
      <h3>Strategy Ranking Table</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Strategy Type</th>
              <th>Strikes</th>
              <th>Expected Return</th>
              <th>VaR 99</th>
              <th>Expected Shortfall</th>
              <th>Return on Margin</th>
              <th>Fragility Score</th>
              <th>Overall Score</th>
            </tr>
          </thead>
          <tbody>
            {strategies?.length ? (
              strategies.map((item, index) => (
                <tr
                  key={`${item.strategy_type}-${index}`}
                  onClick={() => onSelect(index)}
                  className={index === selectedIndex ? 'selected-row' : ''}
                >
                  <td>{item.strategy_type}</td>
                  <td>{Array.isArray(item.strikes) ? item.strikes.join(', ') : item.strikes}</td>
                  <td>{item.expected_value?.toFixed?.(4) ?? '-'}</td>
                  <td>{item.var_99?.toFixed?.(4) ?? '-'}</td>
                  <td>{item.expected_shortfall?.toFixed?.(4) ?? '-'}</td>
                  <td>{item.return_on_margin?.toFixed?.(6) ?? '-'}</td>
                  <td>{item.fragility_score?.toFixed?.(6) ?? '-'}</td>
                  <td>{item.overall_score?.toFixed?.(6) ?? '-'}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8}>No strategies available.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
