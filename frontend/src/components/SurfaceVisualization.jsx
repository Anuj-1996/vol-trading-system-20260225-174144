import React from 'react';
import Plot from 'react-plotly.js';

const MODES = [
  { key: 'market', label: 'Market Surface' },
  { key: 'model', label: 'Model Surface' },
  { key: 'residual', label: 'Residual Surface' },
  { key: 'compare', label: 'Market vs Model' },
];

export default function SurfaceVisualization({ mode, onChangeMode, staticResult }) {
  const summary = staticResult?.ingestion;
  const surface = staticResult?.surface;

  const surfaceByMode = {
    market: surface?.market_iv_matrix,
    model: surface?.model_iv_matrix,
    residual: surface?.residual_iv_matrix,
  };

  const zMatrix = surfaceByMode[mode];
  const isCompareMode = mode === 'compare';
  const marketMatrix = surface?.market_iv_matrix;
  const modelMatrix = surface?.model_iv_matrix;
  const residualMatrix = surface?.residual_iv_matrix;

  const flatten = (matrix) => (Array.isArray(matrix) ? matrix.flat().map((value) => Number(value)) : []);
  const mean = (values) => (values.length ? values.reduce((acc, value) => acc + value, 0) / values.length : 0);

  const marketValues = flatten(marketMatrix);
  const modelValues = flatten(modelMatrix);
  const residualValues = flatten(residualMatrix);

  const marketMin = marketValues.length ? Math.min(...marketValues) : 0;
  const marketMax = marketValues.length ? Math.max(...marketValues) : 0;
  const modelMin = modelValues.length ? Math.min(...modelValues) : 0;
  const modelMax = modelValues.length ? Math.max(...modelValues) : 0;
  const residualRmse = residualValues.length
    ? Math.sqrt(residualValues.reduce((acc, value) => acc + value * value, 0) / residualValues.length)
    : 0;
  const hasSurfaceGrid = Boolean(
    surface &&
      Array.isArray(surface.strike_grid) &&
      Array.isArray(surface.maturity_grid)
  );
  const hasSingleMatrix = Array.isArray(zMatrix) && zMatrix.length > 0;
  const hasCompareMatrices =
    Array.isArray(marketMatrix) &&
    marketMatrix.length > 0 &&
    Array.isArray(modelMatrix) &&
    modelMatrix.length > 0;
  const canRender = hasSurfaceGrid && (isCompareMode ? hasCompareMatrices : hasSingleMatrix);

  const referenceMatrix = isCompareMode ? marketMatrix : zMatrix;
  const rowCount = canRender && Array.isArray(referenceMatrix) ? referenceMatrix.length : 0;
  const colCount = canRender && Array.isArray(referenceMatrix?.[0]) ? referenceMatrix[0].length : 0;
  const canRender3D = canRender && rowCount >= 2 && colCount >= 2;
  const canRenderSingleSlice = canRender && rowCount >= 1 && colCount >= 2;
  const firstSlice = canRenderSingleSlice && !isCompareMode ? zMatrix[0] : [];
  const firstMarketSlice = canRenderSingleSlice && isCompareMode ? marketMatrix[0] : [];
  const firstModelSlice = canRenderSingleSlice && isCompareMode ? modelMatrix[0] : [];
  const syntheticY =
    canRenderSingleSlice && isCompareMode && Array.isArray(surface?.maturity_grid) && surface.maturity_grid.length > 0
      ? [surface.maturity_grid[0], surface.maturity_grid[0] + 1e-4]
      : [];
  const syntheticMarketZ =
    canRenderSingleSlice && isCompareMode
      ? [firstMarketSlice, firstMarketSlice]
      : [];
  const syntheticModelZ =
    canRenderSingleSlice && isCompareMode
      ? [firstModelSlice, firstModelSlice]
      : [];

  return (
    <section className="panel">
      <h3>Surface Visualization</h3>
      <div className="toggle-row">
        {MODES.map((item) => (
          <button
            key={item.key}
            className={mode === item.key ? 'btn btn-active' : 'btn'}
            onClick={() => onChangeMode(item.key)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="surface-placeholder">
        <p>Mode: {mode}</p>
        <p>Records: {summary?.record_count ?? '-'}</p>
        <p>Strike Range: {summary ? `${summary.min_strike} to ${summary.max_strike}` : '-'}</p>

        {canRender ? (
          <>
            {canRender3D && !isCompareMode ? (
              <Plot
                data={[
                  {
                    type: 'surface',
                    x: surface.strike_grid,
                    y: surface.maturity_grid,
                    z: zMatrix,
                    colorbar: { title: mode === 'residual' ? 'Residual IV' : 'IV' },
                    hovertemplate:
                      'Strike: %{x}<br>Maturity: %{y:.4f}y<br>Value: %{z:.6f}<extra></extra>',
                  },
                ]}
                layout={{
                  title: `${MODES.find((item) => item.key === mode)?.label ?? 'Surface'}`,
                  height: 360,
                  margin: { l: 20, r: 20, b: 20, t: 40 },
                  scene: {
                    xaxis: { title: 'Strike' },
                    yaxis: { title: 'Maturity (Years)' },
                    zaxis: { title: mode === 'residual' ? 'Residual IV' : 'Implied Vol' },
                  },
                }}
                style={{ width: '100%' }}
                useResizeHandler
                config={{ displaylogo: false, responsive: true }}
              />
            ) : (canRender3D && isCompareMode) || (isCompareMode && canRenderSingleSlice) ? (
              <Plot
                data={[
                  {
                    type: 'surface',
                    name: 'Market IV',
                    x: surface.strike_grid,
                    y: canRender3D ? surface.maturity_grid : syntheticY,
                    z: canRender3D ? marketMatrix : syntheticMarketZ,
                    opacity: 0.95,
                    colorscale: 'Viridis',
                    showscale: false,
                    hovertemplate:
                      'Market<br>Strike: %{x}<br>Maturity: %{y:.4f}y<br>IV: %{z:.6f}<extra></extra>',
                  },
                  {
                    type: 'surface',
                    name: 'Model IV',
                    x: surface.strike_grid,
                    y: canRender3D ? surface.maturity_grid : syntheticY,
                    z: canRender3D ? modelMatrix : syntheticModelZ,
                    opacity: 0.65,
                    colorscale: 'Portland',
                    colorbar: { title: 'Model IV' },
                    hovertemplate:
                      'Model<br>Strike: %{x}<br>Maturity: %{y:.4f}y<br>IV: %{z:.6f}<extra></extra>',
                  },
                ]}
                layout={{
                  title: canRender3D
                    ? 'Market vs Model Volatility Surface'
                    : 'Market vs Model Volatility Surface (Single Maturity Ribbon)',
                  height: 360,
                  margin: { l: 20, r: 20, b: 20, t: 40 },
                  scene: {
                    xaxis: { title: 'Strike' },
                    yaxis: { title: 'Maturity (Years)' },
                    zaxis: { title: 'Implied Vol' },
                  },
                }}
                style={{ width: '100%' }}
                useResizeHandler
                config={{ displaylogo: false, responsive: true }}
              />
            ) : (
              <Plot
                data={[
                  ...(isCompareMode
                    ? [
                        {
                          type: 'scatter',
                          mode: 'lines+markers',
                          name: 'Market IV',
                          x: surface.strike_grid,
                          y: firstMarketSlice,
                          marker: { color: '#0f766e' },
                          line: { color: '#0f766e', width: 2 },
                          hovertemplate: 'Market<br>Strike: %{x}<br>IV: %{y:.6f}<extra></extra>',
                        },
                        {
                          type: 'scatter',
                          mode: 'lines+markers',
                          name: 'Model IV',
                          x: surface.strike_grid,
                          y: firstModelSlice,
                          marker: { color: '#b45309' },
                          line: { color: '#b45309', width: 2 },
                          hovertemplate: 'Model<br>Strike: %{x}<br>IV: %{y:.6f}<extra></extra>',
                        },
                      ]
                    : [
                        {
                          type: 'scatter',
                          mode: 'lines+markers',
                          x: surface.strike_grid,
                          y: firstSlice,
                          marker: { color: '#0f766e' },
                          line: { color: '#0f766e', width: 2 },
                          hovertemplate: 'Strike: %{x}<br>Value: %{y:.6f}<extra></extra>',
                        },
                      ]),
                ]}
                layout={{
                  title: `${MODES.find((item) => item.key === mode)?.label ?? 'Surface'} (Single Maturity Slice)`,
                  height: 360,
                  margin: { l: 40, r: 20, b: 40, t: 40 },
                  xaxis: { title: 'Strike' },
                  yaxis: { title: mode === 'residual' ? 'Residual IV' : 'Implied Vol' },
                }}
                style={{ width: '100%' }}
                useResizeHandler
                config={{ displaylogo: false, responsive: true }}
              />
            )}

            <div className="surface-metrics">
              <div>
                <label>Market IV Min / Max</label>
                <p>{marketMin.toFixed(6)} / {marketMax.toFixed(6)}</p>
              </div>
              <div>
                <label>Market IV Mean</label>
                <p>{mean(marketValues).toFixed(6)}</p>
              </div>
              <div>
                <label>Model IV Min / Max</label>
                <p>{modelMin.toFixed(6)} / {modelMax.toFixed(6)}</p>
              </div>
              <div>
                <label>Model IV Mean</label>
                <p>{mean(modelValues).toFixed(6)}</p>
              </div>
              <div>
                <label>Residual RMSE</label>
                <p>{residualRmse.toFixed(6)}</p>
              </div>
              <div>
                <label>Residual Mean</label>
                <p>{mean(residualValues).toFixed(6)}</p>
              </div>
            </div>
          </>
        ) : (
          <p>Run static pipeline to generate surface plot.</p>
        )}
      </div>
    </section>
  );
}
