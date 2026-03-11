# GreekCompositionSurface (Stacked 3D Option Greeks)

A reusable React component for visualizing option Greek composition by strike and expiry in a 3D stacked bar format.

## Features
- 3D grid: X = Strike, Y = Expiry, Z = Total Greek magnitude
- Each bar is stacked by 10 Greek components (Call/Put: Delta, Gamma, Theta, Vega, Rho)
- Distinct color palettes for Call and Put Greeks
- Interactive: rotate, zoom, pan (camera state persists)
- Hover tooltips: strike, expiry, greek, value
- Efficient for large option chains

## Props
```ts
interface GreekCompositionDatum {
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
}

interface GreekCompositionSurfaceProps {
  data: GreekCompositionDatum[];
  width?: number | string; // default: '100%'
  height?: number | string; // default: 600
}
```

## Usage
```tsx
import GreekCompositionSurface from './components/charts/GreekCompositionSurface';

const data = [
  {
    strike: 18000,
    expiry: '2026-03-12',
    call_delta: 120,
    call_gamma: 30,
    call_theta: -40,
    call_vega: 50,
    call_rho: 10,
    put_delta: -100,
    put_gamma: 25,
    put_theta: -35,
    put_vega: 45,
    put_rho: -8,
  },
  // ...more rows
];

<GreekCompositionSurface data={data} height={500} />
```

## Integration
- Place the component in any dashboard or analytics page.
- Data can be generated from your backend or calculated in the frontend.
- For large chains, pre-aggregate Greeks by strike/expiry for best performance.

## Notes
- Requires `react-plotly.js` and `plotly.js-dist-min` as dependencies.
- The chart is fully interactive and responsive.
