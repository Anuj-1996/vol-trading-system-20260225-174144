import React from 'react';
import Plot from 'react-plotly.js';
import { PLOT_THEME_TOKENS, ThemeContext } from '../theme';

function patchAxis(axis, tokens, isSceneAxis = false) {
  if (!axis || typeof axis !== 'object' || Array.isArray(axis)) {
    return axis;
  }

  return {
    ...axis,
    gridcolor: tokens.grid,
    zerolinecolor: tokens.zero,
    ...(isSceneAxis ? { backgroundcolor: tokens.sceneBackground } : {}),
  };
}

function patchLayout(layout, tokens) {
  if (!layout || typeof layout !== 'object') {
    return layout;
  }

  const nextLayout = {
    ...layout,
    paper_bgcolor: tokens.background,
    plot_bgcolor: tokens.background,
    font: {
      ...(layout.font || {}),
      color: tokens.font,
    },
  };

  Object.keys(layout).forEach((key) => {
    if (/^xaxis\d*$/.test(key) || /^yaxis\d*$/.test(key) || /^zaxis\d*$/.test(key)) {
      nextLayout[key] = patchAxis(layout[key], tokens, false);
    }
  });

  if (layout.scene && typeof layout.scene === 'object') {
    nextLayout.scene = {
      ...layout.scene,
      xaxis: patchAxis(layout.scene.xaxis, tokens, true),
      yaxis: patchAxis(layout.scene.yaxis, tokens, true),
      zaxis: patchAxis(layout.scene.zaxis, tokens, true),
      bgcolor: tokens.sceneBackground,
    };
  }

  if (layout.polar && typeof layout.polar === 'object') {
    nextLayout.polar = {
      ...layout.polar,
      bgcolor: tokens.background,
      angularaxis: patchAxis(layout.polar.angularaxis, tokens, false),
      radialaxis: patchAxis(layout.polar.radialaxis, tokens, false),
    };
  }

  if (layout.geo && typeof layout.geo === 'object') {
    nextLayout.geo = {
      ...layout.geo,
      bgcolor: tokens.background,
    };
  }

  return nextLayout;
}

export default function ThemedPlot(props) {
  const themeMode = React.useContext(ThemeContext);
  const tokens = PLOT_THEME_TOKENS[themeMode] || PLOT_THEME_TOKENS['light-dark'];
  const themedLayout = React.useMemo(() => patchLayout(props.layout, tokens), [props.layout, tokens]);

  return <Plot {...props} layout={themedLayout} />;
}
