import React, { useRef } from 'react';
import Plot from './ThemedPlot';

export type GreekCompositionDatum = {
  strike: number;
  expiry: string;
  call_delta: number;
  call_gamma: number;
  call_theta: number;
  call_vega: number;
  call_rho: number;
  put_delta: number;
  put_gamma: number;
  put_theta: number;
  put_vega: number;
  put_rho: number;
};

export interface GreekCompositionSurfaceProps {
  data: GreekCompositionDatum[];
  width?: number | string;
  height?: number | string;
}

const CALL_COLORS = [
  '#1f77b4', // Delta
  '#2ca02c', // Gamma
  '#ff7f0e', // Theta
  '#9467bd', // Vega
  '#8c564b', // Rho
];
const PUT_COLORS = [
  '#aec7e8', // Delta
  '#98df8a', // Gamma
  '#ffbb78', // Theta
  '#c5b0d5', // Vega
  '#c49c94', // Rho
];
const GREEK_KEYS = [
  'call_delta', 'call_gamma', 'call_theta', 'call_vega', 'call_rho',
  'put_delta', 'put_gamma', 'put_theta', 'put_vega', 'put_rho',
] as const;
const GREEK_LABELS = [
  'Call Delta', 'Call Gamma', 'Call Theta', 'Call Vega', 'Call Rho',
  'Put Delta', 'Put Gamma', 'Put Theta', 'Put Vega', 'Put Rho',
];

function getUniqueStrikes(data: GreekCompositionDatum[]) {
  return Array.from(new Set(data.map(d => d.strike))).sort((a, b) => a - b);
}
function getUniqueExpiries(data: GreekCompositionDatum[]) {
  return Array.from(new Set(data.map(d => d.expiry)));
}

export const GreekCompositionSurface: React.FC<GreekCompositionSurfaceProps> = ({ data, width = '100%', height = 600 }) => {
  const plotRef = useRef<any>(null);
  const strikes = getUniqueStrikes(data);
  const expiries = getUniqueExpiries(data);

  // Build a map for fast lookup
  const dataMap = new Map<string, GreekCompositionDatum>();
  data.forEach(d => {
    dataMap.set(`${d.strike}|${d.expiry}`, d);
  });

  // For each Greek, build a 2D array (expiry x strike)
  const greekSurfaces = GREEK_KEYS.map((key, i) => {
    const z: number[][] = expiries.map(expiry =>
      strikes.map(strike => {
        const d = dataMap.get(`${strike}|${expiry}`);
        return d ? d[key] : 0;
      })
    );
    return {
      z,
      x: strikes,
      y: expiries,
      name: GREEK_LABELS[i],
      color: i < 5 ? CALL_COLORS[i] : PUT_COLORS[i - 5],
      key,
    };
  });

  // For stacked bars, we need to sum previous values for each bar
  const traces = [];
  for (let g = 0; g < greekSurfaces.length; g++) {
    const { z, x, y, name, color } = greekSurfaces[g];
    // Compute base (sum of previous)
    let base: number[][] = Array.from({ length: y.length }, () => Array(x.length).fill(0));
    if (g > 0) {
      for (let i = 0; i < y.length; i++) {
        for (let j = 0; j < x.length; j++) {
          base[i][j] = traces.reduce((sum, t) => sum + t.z[i][j], 0);
        }
      }
    }
    traces.push({
      type: 'bar3d',
      x: x,
      y: y,
      z: z.flat(),
      base: base.flat(),
      width: 0.8,
      depth: 0.8,
      name,
      marker: { color },
      hovertemplate:
        'Strike: %{x}<br>Expiry: %{y}<br>' +
        `Greek: ${name}<br>` +
        'Value: %{z}<extra></extra>',
      opacity: 1,
    });
  }

  // Plotly does not have native bar3d, so we use mesh3d or scatter3d for custom bars
  // Here, we use scatter3d with mode="markers" and marker.size for bar effect
  // For large data, this is efficient
  const plotlyTraces = traces.map((t, idx) => {
    const points = [];
    for (let i = 0; i < t.y.length; i++) {
      for (let j = 0; j < t.x.length; j++) {
        const z0 = t.base[i * t.x.length + j] || 0;
        const z1 = z0 + t.z[i * t.x.length + j];
        points.push({
          x: t.x[j],
          y: t.y[i],
          z: z1,
          z0,
        });
      }
    }
    return {
      type: 'scatter3d',
      mode: 'markers',
      x: points.map(p => p.x),
      y: points.map(p => p.y),
      z: points.map(p => (p.z + p.z0) / 2),
      marker: {
        color: t.marker.color,
        size: 16,
        opacity: 0.95,
        line: { width: 0 },
        symbol: 'square',
      },
      name: t.name,
      customdata: points.map(p => [p.x, p.y, t.name, p.z - p.z0]),
      hovertemplate:
        'Strike: %{customdata[0]}<br>Expiry: %{customdata[1]}<br>' +
        'Greek: %{customdata[2]}<br>' +
        'Value: %{customdata[3]:.2f}<extra></extra>',
      showlegend: true,
    };
  });

  return (
    <Plot
      ref={plotRef}
      data={plotlyTraces}
      layout={{
        scene: {
          xaxis: { title: 'Strike Price', type: 'linear', tickmode: 'array', tickvals: strikes },
          yaxis: { title: 'Expiry', type: 'category', tickmode: 'array', tickvals: expiries },
          zaxis: { title: 'Total Greek Magnitude' },
          camera: { projection: { type: 'perspective' } },
        },
        margin: { l: 0, r: 0, b: 0, t: 40 },
        legend: { orientation: 'h', y: 1.1 },
        hovermode: 'closest',
        dragmode: 'turntable',
        autosize: true,
        width,
        height,
        title: 'Greek Composition Surface (Stacked)',
      }}
      config={{
        responsive: true,
        displayModeBar: true,
        scrollZoom: true,
        toImageButtonOptions: { format: 'png', filename: 'greek_composition_surface' },
      }}
      useResizeHandler
    />
  );
};

export default GreekCompositionSurface;
