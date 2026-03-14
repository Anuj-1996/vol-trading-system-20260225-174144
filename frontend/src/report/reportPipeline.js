// reportPipeline.js
// Independent report generation pipeline for research-style PNG export
// Does NOT touch analytics, models, or core dashboard logic

// Utility: Export Plotly chart to PNG (returns dataURL)
async function exportPlotlyToPng(plotId, width = 1080) {
  const Plotly = await import('plotly.js-dist-min');
  const plotNode = document.getElementById(plotId);
  if (!plotNode) throw new Error(`Plot with id ${plotId} not found`);
  return await Plotly.toImage(plotNode, { format: 'png', width, height: 480, scale: 2 });
}

// Utility: Draw section on canvas
function drawSection(ctx, y, title, img, explanation, width) {
  const sectionSpacing = 36;
  const titleFont = 'bold 32px Inter, Arial, sans-serif';
  const paraFont = '400 20px Inter, Arial, sans-serif';
  const paraWidth = width - 80;
  ctx.save();
  ctx.font = titleFont;
  ctx.fillStyle = '#181c23';
  ctx.fillText(title, 40, y + 40);
  ctx.drawImage(img, 40, y + 60, width - 80, 320);
  ctx.font = paraFont;
  ctx.fillStyle = '#222';
  const lines = wrapText(ctx, explanation, paraWidth);
  lines.forEach((line, i) => ctx.fillText(line, 40, y + 410 + i * 28));
  ctx.restore();
  return y + 410 + lines.length * 28 + sectionSpacing;
}

// Utility: Wrap text for canvas
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  let line = '';
  const lines = [];
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      lines.push(line);
      line = words[n] + ' ';
    } else {
      line = testLine;
    }
  }
  lines.push(line);
  return lines;
}

// Main report pipeline
export async function runReportPipeline() {
  // 1. Gather chart PNGs (by id) and metric values (from DOM)
  // IDs must match those used in dashboard components
  const chartIds = [
    'chart-price-vol-history',
    'chart-iv-term-structure',
    'chart-vol-skew',
    'chart-market-model',
    'chart-gex-by-strike',
    'chart-pnl-heatmap',
  ];
  const chartTitles = [
    'Market Context',
    'Volatility Term Structure',
    'Volatility Skew',
    'Market vs Model Pricing',
    'Dealer Positioning',
    'Strategy Insight',
  ];
  const chartExplanations = [
    'Relationship between price, realized volatility, and implied volatility.',
    'Volatility across maturities.',
    'Demand for downside protection.',
    'How market prices deviate from pricing models.',
    'Dealer hedging pressure zones.',
    'How the strategy behaves across spot and volatility scenarios.',
  ];

  // Top metrics (from metric cards)
  function getMetricText(label) {
    const el = document.querySelector(`[data-report-metric="${label}"]`);
    return el ? el.textContent.trim() : '-';
  }
  const metrics = [
    { label: 'Spot Price', value: getMetricText('Spot Price') },
    { label: 'ATM IV', value: getMetricText('ATM IV') },
    { label: 'IV Rank', value: getMetricText('IV Rank') },
    { label: 'Volatility Risk Premium', value: getMetricText('VRP (Vol Risk Premium)') },
  ];

  // 2. Export all charts as PNG dataURLs
  const chartImgs = [];
  for (let i = 0; i < chartIds.length; ++i) {
    // eslint-disable-next-line no-await-in-loop
    const dataUrl = await exportPlotlyToPng(chartIds[i]);
    const img = await loadImage(dataUrl);
    chartImgs.push(img);
  }

  // 3. Build report on offscreen canvas
  const width = 1080;
  let y = 0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, 4000); // oversize, will crop later

  // Header
  ctx.font = 'bold 44px Inter, Arial, sans-serif';
  ctx.fillStyle = '#181c23';
  ctx.fillText('Market Snapshot — NIFTY Options', 40, 60);
  y = 100;

  // Top Metrics
  ctx.font = 'bold 28px Inter, Arial, sans-serif';
  ctx.fillStyle = '#222';
  ctx.fillText('Top Metrics', 40, y);
  y += 36;
  ctx.font = '400 24px Inter, Arial, sans-serif';
  metrics.forEach((m, i) => {
    ctx.fillText(`${m.label}: ${m.value}`, 60, y + i * 32);
  });
  y += metrics.length * 32 + 24;

  // Sections
  for (let i = 0; i < chartImgs.length; ++i) {
    y = drawSection(ctx, y, chartTitles[i], chartImgs[i], chartExplanations[i], width);
  }

  // Crop canvas
  const finalHeight = y + 40;
  canvas.height = finalHeight;
  const imageData = ctx.getImageData(0, 0, width, finalHeight);
  ctx.putImageData(imageData, 0, 0);

  // 4. Download PNG
  canvas.toBlob((blob) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'NIFTY_Options_Report.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, 'image/png');
}

// Helper: load image from dataURL
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}
