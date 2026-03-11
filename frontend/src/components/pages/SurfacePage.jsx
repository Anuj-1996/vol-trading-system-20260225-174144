import React, { useEffect, useMemo, useState } from 'react';
import Plot from 'react-plotly.js';
import { Panel, SnapshotGuard, formatNumber } from './shared.jsx';

const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatExpiryLabel(label) {
  const m = String(label).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return `${parseInt(m[3],10)} ${SHORT_MONTHS[parseInt(m[2],10)-1]} ${m[1].slice(2)}`;
  }
  return String(label);
}

function movingAverage(values, windowSize = 5) {
  const source = Array.isArray(values) ? values.map((item) => Number(item)) : [];
  if (source.length < 3 || windowSize < 3) {
    return source;
  }
  const radius = Math.floor(windowSize / 2);
  return source.map((_, index) => {
    let total = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const nextIndex = index + offset;
      if (nextIndex >= 0 && nextIndex < source.length) {
        total += source[nextIndex];
        count += 1;
      }
    }
    return count ? total / count : source[index];
  });
}

function rollingMedian(values, windowSize = 5) {
  const source = Array.isArray(values) ? values.map((item) => Number(item)) : [];
  if (source.length < 3 || windowSize < 3) {
    return source;
  }
  const radius = Math.floor(windowSize / 2);
  return source.map((_, index) => {
    const bucket = [];
    for (let offset = -radius; offset <= radius; offset += 1) {
      const nextIndex = index + offset;
      if (nextIndex >= 0 && nextIndex < source.length) {
        bucket.push(source[nextIndex]);
      }
    }
    bucket.sort((a, b) => a - b);
    return bucket[Math.floor(bucket.length / 2)] ?? source[index];
  });
}

function smoothMatrix2D(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) {
    return [];
  }

  const rows = matrix.length;
  const cols = Math.max(...matrix.map((row) => (Array.isArray(row) ? row.length : 0)));
  if (!cols) {
    return [];
  }

  const cleanedByRow = matrix.map((rawRow) => {
    const row = Array.isArray(rawRow) ? rawRow.map((value) => Number(value)) : [];
    const medianSmoothed = rollingMedian(row, 5);
    const maSmoothed = movingAverage(medianSmoothed, 5);
    return maSmoothed.map((value) => Math.max(0.01, Math.min(3.0, value)));
  });

  const byColumn = Array.from({ length: cols }, (_, colIndex) =>
    cleanedByRow.map((row) => row[colIndex] ?? row[row.length - 1] ?? 0.2),
  );

  const smoothedColumns = byColumn.map((column) => movingAverage(rollingMedian(column, 3), 3));

  const rebuilt = Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: cols }, (_, colIndex) => smoothedColumns[colIndex][rowIndex] ?? cleanedByRow[rowIndex]?.[colIndex] ?? 0.2),
  );

  return rebuilt.map((row) => row.map((value) => Math.max(0.01, Math.min(3.0, value))));
}

function interpolateLinear(points, values, target) {
  if (!points.length || !values.length) {
    return 0;
  }
  if (target <= points[0]) {
    return Number(values[0] ?? 0);
  }
  if (target >= points[points.length - 1]) {
    return Number(values[values.length - 1] ?? 0);
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = Number(points[index]);
    const right = Number(points[index + 1]);
    if (target >= left && target <= right) {
      const leftValue = Number(values[index] ?? 0);
      const rightValue = Number(values[index + 1] ?? leftValue);
      const weight = right !== left ? (target - left) / (right - left) : 0;
      return leftValue + (rightValue - leftValue) * weight;
    }
  }
  return Number(values[values.length - 1] ?? 0);
}

function buildDenseAxis(axis, factor = 6) {
  const source = Array.isArray(axis) ? axis.map((value) => Number(value)).filter(Number.isFinite) : [];
  if (source.length < 2) {
    return source;
  }
  const result = [];
  for (let index = 0; index < source.length - 1; index += 1) {
    const left = source[index];
    const right = source[index + 1];
    const stepCount = Math.max(2, factor);
    for (let step = 0; step < stepCount; step += 1) {
      const weight = step / stepCount;
      result.push(left + (right - left) * weight);
    }
  }
  result.push(source[source.length - 1]);
  return result;
}

function densifyMatrix(strikeAxis, maturityAxis, matrix, strikeFactor = 6, maturityFactor = 6) {
  const strike = Array.isArray(strikeAxis) ? strikeAxis.map((value) => Number(value)) : [];
  const maturity = Array.isArray(maturityAxis) ? maturityAxis.map((value) => Number(value)) : [];
  const source = Array.isArray(matrix) ? matrix : [];

  if (strike.length < 2 || maturity.length < 2 || !source.length) {
    return { strikeDense: strike, maturityDense: maturity, matrixDense: source };
  }

  const strikeDense = buildDenseAxis(strike, strikeFactor);
  const maturityDense = buildDenseAxis(maturity, maturityFactor);

  const rowInterpolated = source.map((row) =>
    strikeDense.map((strikeValue) => interpolateLinear(strike, Array.isArray(row) ? row : [], strikeValue)),
  );

  const matrixDense = maturityDense.map((maturityValue) => {
    const interpolatedRow = [];
    for (let colIndex = 0; colIndex < strikeDense.length; colIndex += 1) {
      const colValues = rowInterpolated.map((row) => Number(row[colIndex] ?? 0));
      interpolatedRow.push(interpolateLinear(maturity, colValues, maturityValue));
    }
    return interpolatedRow;
  });

  return { strikeDense, maturityDense, matrixDense };
}

function downsampleAxis(axis, maxLength) {
  const source = Array.isArray(axis) ? axis.map((value) => Number(value)).filter(Number.isFinite) : [];
  if (source.length <= maxLength) {
    return { values: source, indexes: source.map((_, index) => index) };
  }
  const indexes = [];
  const values = [];
  const step = (source.length - 1) / (maxLength - 1);
  for (let index = 0; index < maxLength; index += 1) {
    const sourceIndex = Math.round(index * step);
    indexes.push(sourceIndex);
    values.push(source[sourceIndex]);
  }
  return { values, indexes };
}

function downsampleMatrix2D(matrix, rowIndexes, colIndexes) {
  return rowIndexes.map((rowIndex) =>
    colIndexes.map((colIndex) => Number(matrix?.[rowIndex]?.[colIndex] ?? 0)),
  );
}

function buildFrequencyAxis(length) {
  const half = Math.floor(length / 2);
  return Array.from({ length: half + 1 }, (_, index) => index / Math.max(length, 1));
}

function median(values) {
  const source = Array.isArray(values)
    ? values.map((value) => Number(value)).filter(Number.isFinite).sort((a, b) => a - b)
    : [];
  if (!source.length) {
    return 0;
  }
  const mid = Math.floor(source.length / 2);
  return source.length % 2 ? source[mid] : (source[mid - 1] + source[mid]) / 2;
}

function medianStep(values, scale = 1) {
  if (!Array.isArray(values) || values.length < 2) {
    return 0;
  }
  const diffs = [];
  for (let index = 1; index < values.length; index += 1) {
    const diff = Math.abs(Number(values[index]) - Number(values[index - 1]));
    if (Number.isFinite(diff) && diff > 0) {
      diffs.push(diff * scale);
    }
  }
  return median(diffs);
}

function dftMagnitude1D(values) {
  const source = Array.isArray(values) ? values.map((value) => Number(value)) : [];
  const length = source.length;
  if (!length) {
    return [];
  }
  const half = Math.floor(length / 2);
  return Array.from({ length: half + 1 }, (_, freqIndex) => {
    let real = 0;
    let imag = 0;
    for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
      const angle = (2 * Math.PI * freqIndex * sampleIndex) / length;
      real += source[sampleIndex] * Math.cos(angle);
      imag -= source[sampleIndex] * Math.sin(angle);
    }
    return Math.sqrt(real * real + imag * imag) / length;
  });
}

function dftMagnitude2D(matrix) {
  const rows = Array.isArray(matrix) ? matrix.length : 0;
  const cols = rows ? (Array.isArray(matrix[0]) ? matrix[0].length : 0) : 0;
  if (!rows || !cols) {
    return { strikeFreq: [], maturityFreq: [], magnitude: [] };
  }

  const rowHalf = Math.floor(rows / 2);
  const colHalf = Math.floor(cols / 2);
  const magnitude = [];

  for (let rowFreq = 0; rowFreq <= rowHalf; rowFreq += 1) {
    const spectrumRow = [];
    for (let colFreq = 0; colFreq <= colHalf; colFreq += 1) {
      let real = 0;
      let imag = 0;
      for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
        for (let colIndex = 0; colIndex < cols; colIndex += 1) {
          const angle = (2 * Math.PI * ((rowFreq * rowIndex) / rows + (colFreq * colIndex) / cols));
          const value = Number(matrix[rowIndex][colIndex] ?? 0);
          real += value * Math.cos(angle);
          imag -= value * Math.sin(angle);
        }
      }
      spectrumRow.push(Math.sqrt(real * real + imag * imag) / (rows * cols));
    }
    magnitude.push(spectrumRow);
  }

  return {
    strikeFreq: buildFrequencyAxis(cols),
    maturityFreq: buildFrequencyAxis(rows),
    magnitude,
  };
}

export default function SurfacePage({
  loading,
  activeSnapshotId,
  market,
  surface,
  modelSelection = 'SABR',
  selectedExpiryIndex = 0,
  onExpiryIndexChange,
  onRecalibrate,
  canRecalibrate = false,
}) {
  const [sliceExpiryIndex, setSliceExpiryIndex] = useState(0);
  const [sliceStrikeIndex, setSliceStrikeIndex] = useState(0);
  const [logMoneyness, setLogMoneyness] = useState(false);
  const [selectedSurfaceModel, setSelectedSurfaceModel] = useState(modelSelection || 'SABR');
  const [recalibrating, setRecalibrating] = useState(false);
  const [recalibrateMsg, setRecalibrateMsg] = useState('');

  const strikeGrid = Array.isArray(surface?.strike_grid) ? surface.strike_grid : [];
  const maturityGrid = Array.isArray(surface?.maturity_grid) ? surface.maturity_grid : [];
  const expiryLabels = Array.isArray(surface?.expiry_labels)
    ? surface.expiry_labels
    : maturityGrid.map((value) => `${Math.max(1, Math.round(Number(value) * 365))}D`);
  const formattedExpiryLabels = useMemo(() => expiryLabels.map(formatExpiryLabel), [expiryLabels]);

  // 2D text array for market surface hover (rows = expiries, cols = strikes)
  const marketExpiryText = useMemo(
    () => maturityGrid.map((_, ri) => strikeGrid.map(() => formattedExpiryLabels[ri] || '')),
    [maturityGrid, strikeGrid, formattedExpiryLabels],
  );

  // Y-axis scene config for 3D charts: show expiry labels instead of numeric years
  const expiryYAxis = useMemo(() => ({
    title: 'Expiry',
    tickvals: maturityGrid,
    ticktext: formattedExpiryLabels,
  }), [maturityGrid, formattedExpiryLabels]);

  const openInterestMatrix = Array.isArray(surface?.open_interest_matrix) ? surface.open_interest_matrix : [];
  const maxPainByExpiry = Array.isArray(surface?.max_pain_by_expiry) ? surface.max_pain_by_expiry : [];
  const marketMatrix = Array.isArray(surface?.market_iv_matrix) ? surface.market_iv_matrix : [];
  const modelVariants = useMemo(() => {
    const variants = {};
    if (Array.isArray(surface?.model_iv_matrix)) {
      variants.Heston = {
        model_iv_matrix: surface.model_iv_matrix,
        residual_iv_matrix: surface?.residual_iv_matrix,
        calibration: surface?.calibration ? { ...surface.calibration, model: 'Heston' } : null,
      };
    }
    const backendVariants = surface?.model_variants && typeof surface.model_variants === 'object'
      ? surface.model_variants
      : {};
    Object.entries(backendVariants).forEach(([modelName, payload]) => {
      if (!payload || !Array.isArray(payload.model_iv_matrix)) {
        return;
      }
      variants[modelName] = {
        ...payload,
        calibration: payload.calibration || null,
      };
    });
    return variants;
  }, [surface]);
  const availableSurfaceModels = useMemo(() => Object.keys(modelVariants), [modelVariants]);
  const selectedModelVariant = modelVariants[selectedSurfaceModel]
    || modelVariants[modelSelection]
    || modelVariants[surface?.active_model]
    || modelVariants.Heston
    || null;
  const activeCalibration = selectedModelVariant?.calibration || surface?.calibration || null;
  const activeModelName = selectedModelVariant?.calibration?.model || selectedSurfaceModel || 'Heston';
  const modelMatrix = Array.isArray(selectedModelVariant?.model_iv_matrix)
    ? selectedModelVariant.model_iv_matrix
    : Array.isArray(surface?.model_iv_matrix)
      ? surface.model_iv_matrix
      : [];
  const smoothedModelMatrix = useMemo(() => smoothMatrix2D(modelMatrix), [modelMatrix]);
  const denseModelSurface = useMemo(
    () => densifyMatrix(strikeGrid, maturityGrid, smoothedModelMatrix, 7, 7),
    [strikeGrid, maturityGrid, smoothedModelMatrix],
  );
  const residualMatrix = Array.isArray(selectedModelVariant?.residual_iv_matrix)
    ? selectedModelVariant.residual_iv_matrix
    : Array.isArray(surface?.residual_iv_matrix)
      ? surface.residual_iv_matrix
      : [];
  const displayResidualMatrix = useMemo(() => {
    if (!marketMatrix.length || !smoothedModelMatrix.length) {
      return residualMatrix;
    }
    return marketMatrix.map((row, rowIndex) =>
      (Array.isArray(row) ? row : []).map((value, colIndex) => Number(value) - Number(smoothedModelMatrix[rowIndex]?.[colIndex] ?? 0)),
    );
  }, [marketMatrix, smoothedModelMatrix, residualMatrix]);
  const singleExpiry = maturityGrid.length < 2;
  const selectedStrikeValue = strikeGrid[sliceStrikeIndex] || 0;

  const strikeSeriesMarket = useMemo(
    () => maturityGrid.map((_, idx) => marketMatrix[idx]?.[sliceStrikeIndex] ?? null),
    [maturityGrid, marketMatrix, sliceStrikeIndex],
  );
  const strikeSeriesModel = useMemo(
    () => maturityGrid.map((_, idx) => smoothedModelMatrix[idx]?.[sliceStrikeIndex] ?? null),
    [maturityGrid, smoothedModelMatrix, sliceStrikeIndex],
  );

  const residualValues = displayResidualMatrix.flat().map((value) => Number(value));
  const residualRmse = residualValues.length
    ? Math.sqrt(residualValues.reduce((acc, value) => acc + value * value, 0) / residualValues.length)
    : 0;
  const residualMaxAbs = residualValues.length
    ? Math.max(...residualValues.map((value) => Math.abs(value)))
    : 0;
  const selectedOiRow = openInterestMatrix[sliceExpiryIndex] || [];
  const selectedMaxPain = Number(maxPainByExpiry[sliceExpiryIndex] ?? 0);
  const marketIvDistribution = (marketMatrix[sliceExpiryIndex] || marketMatrix.flat() || []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  const modelIvDistribution = (smoothedModelMatrix[sliceExpiryIndex] || smoothedModelMatrix.flat() || []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);

  // Gaussian KDE helper for smooth PDF curves
  const computeKDE = (data, nPoints = 200) => {
    if (!data.length) return { x: [], y: [] };
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 0.01;
    const bandwidth = 1.06 * (data.reduce((s, v) => s + (v - data.reduce((a, b) => a + b, 0) / data.length) ** 2, 0) / data.length) ** 0.5 * data.length ** -0.2 || range * 0.05;
    const xMin = min - range * 0.15;
    const xMax = max + range * 0.15;
    const step = (xMax - xMin) / nPoints;
    const xs = Array.from({ length: nPoints }, (_, i) => xMin + i * step);
    const ys = xs.map((x) => {
      const sum = data.reduce((acc, xi) => acc + Math.exp(-0.5 * ((x - xi) / bandwidth) ** 2), 0);
      return sum / (data.length * bandwidth * Math.sqrt(2 * Math.PI));
    });
    return { x: xs, y: ys };
  };
  const marketKDE = computeKDE(marketIvDistribution);
  const modelKDE = computeKDE(modelIvDistribution);
  const frequencyDomain = useMemo(() => {
    const rowAxis = downsampleAxis(maturityGrid, 14);
    const colAxis = downsampleAxis(strikeGrid, 28);
    const matrixRaw = downsampleMatrix2D(smoothedModelMatrix, rowAxis.indexes, colAxis.indexes);
    const allValues = matrixRaw.flat().map((value) => Number(value)).filter(Number.isFinite);
    const meanValue = allValues.length
      ? allValues.reduce((acc, value) => acc + value, 0) / allValues.length
      : 0;
    // Remove DC bias so spectral shape is visible (prevents a giant zero-frequency spike).
    const matrix = matrixRaw.map((row) => row.map((value) => Number(value) - meanValue));

    const spectrum = dftMagnitude2D(matrix);
    const powerSpectrum = spectrum.magnitude.map((row) =>
      row.map((value) => {
        const magnitude = Math.max(0, Number(value) || 0);
        return magnitude * magnitude;
      }),
    );
    if (powerSpectrum.length && powerSpectrum[0].length) {
      powerSpectrum[0][0] = 0; // suppress residual DC bin
    }
    const powerValues = powerSpectrum.flat().filter((value) => Number.isFinite(value) && value > 0);
    const sortedPower = [...powerValues].sort((a, b) => a - b);
    const q99 = sortedPower.length
      ? sortedPower[Math.max(0, Math.floor(0.99 * (sortedPower.length - 1)))]
      : 1;
    const scale = q99 > 1e-12 ? q99 : 1;
    const powerSpectrumDisplay = powerSpectrum.map((row) =>
      row.map((value) => Math.log10(1 + Math.max(0, value) / scale)),
    );

    let dominantValue = -Infinity;
    let dominantRowIndex = 0;
    let dominantColIndex = 0;
    for (let rowIndex = 0; rowIndex < powerSpectrumDisplay.length; rowIndex += 1) {
      for (let colIndex = 0; colIndex < (powerSpectrumDisplay[rowIndex] || []).length; colIndex += 1) {
        if (rowIndex === 0 && colIndex === 0) {
          continue;
        }
        const value = powerSpectrumDisplay[rowIndex][colIndex];
        if (value > dominantValue) {
          dominantValue = value;
          dominantRowIndex = rowIndex;
          dominantColIndex = colIndex;
        }
      }
    }

    const expiryRowRaw = (smoothedModelMatrix[sliceExpiryIndex] || []).map((value) => Number(value));
    const expiryMean = expiryRowRaw.length
      ? expiryRowRaw.reduce((acc, value) => acc + value, 0) / expiryRowRaw.length
      : 0;
    const expiryRow = expiryRowRaw.map((value) => value - expiryMean);
    const expirySpectrum = dftMagnitude1D(expiryRow).map((value) => {
      const power = Math.max(0, value * value);
      return Math.log10(1 + power);
    });
    if (expirySpectrum.length) {
      expirySpectrum[0] = 0;
    }
    const expiryFrequencyAxis = buildFrequencyAxis(expiryRow.length);
    const strikeStepPoints = medianStep(colAxis.values, 1);
    const maturityStepDays = medianStep(rowAxis.values, 365);
    const dominantStrikeFreq = spectrum.strikeFreq[dominantColIndex] ?? 0;
    const dominantMaturityFreq = spectrum.maturityFreq[dominantRowIndex] ?? 0;
    const strikeCycleBins = dominantStrikeFreq > 0 ? 1 / dominantStrikeFreq : 0;
    const maturityCycleBins = dominantMaturityFreq > 0 ? 1 / dominantMaturityFreq : 0;
    const dominantStrikeCyclePoints = strikeStepPoints > 0 ? strikeCycleBins * strikeStepPoints : 0;
    const dominantMaturityCycleDays = maturityStepDays > 0 ? maturityCycleBins * maturityStepDays : 0;

    return {
      strikeFreq: spectrum.strikeFreq,
      maturityFreq: spectrum.maturityFreq,
      dominantMaturityFreq,
      dominantStrikeFreq,
      dominantPower: Number.isFinite(dominantValue) ? dominantValue : 0,
      dominantStrikeCyclePoints,
      dominantMaturityCycleDays,
      strikeStepPoints,
      maturityStepDays,
      powerSpectrum: powerSpectrumDisplay,
      expirySpectrum,
      expiryFrequencyAxis,
    };
  }, [maturityGrid, strikeGrid, smoothedModelMatrix, sliceExpiryIndex]);
  const calibrationDiagnostics = useMemo(() => {
    const calib = activeCalibration || null;
    const model = calib?.model || activeModelName || 'Heston';
    if (model === 'SABR') {
      const params = calib?.parameters || {};
      const alpha = Number(params?.alpha);
      const beta = Number(params?.beta);
      const rho = Number(params?.rho);
      const nu = Number(params?.nu);
      const rmse = Number(calib?.weighted_rmse);
      const expiryFits = Array.isArray(calib?.expiry_fits) ? calib.expiry_fits : [];
      const convergedCount = expiryFits.filter((fit) => fit?.converged).length;
      const totalFits = expiryFits.length;
      const averageFitRmse = totalFits
        ? expiryFits.reduce((acc, fit) => acc + Number(fit?.rmse ?? 0), 0) / totalFits
        : null;
      const bestFit = expiryFits.length
        ? [...expiryFits].sort((left, right) => Number(left?.rmse ?? Infinity) - Number(right?.rmse ?? Infinity))[0]
        : null;
      const worstFit = expiryFits.length
        ? [...expiryFits].sort((left, right) => Number(right?.rmse ?? -Infinity) - Number(left?.rmse ?? -Infinity))[0]
        : null;

      const checks = {
        alpha: Number.isFinite(alpha) && alpha > 0,
        beta: Number.isFinite(beta) && beta >= 0 && beta <= 1,
        rho: Number.isFinite(rho) && Math.abs(rho) < 0.999,
        nu: Number.isFinite(nu) && nu > 0 && nu <= 5,
        rmse: Number.isFinite(rmse) && rmse <= 0.08,
        coverage: totalFits > 0 && convergedCount / totalFits >= 0.6,
        expiries: totalFits >= 2,
        converged: Boolean(calib?.converged),
      };
      const passCount = Object.values(checks).filter(Boolean).length;
      const totalCount = Object.keys(checks).length;
      const score = totalCount ? passCount / totalCount : 0;
      const verdict = score >= 0.8 ? 'Good' : score >= 0.55 ? 'Usable' : 'Unstable';
      return {
        model,
        params: {
          alpha: Number.isFinite(alpha) ? alpha : null,
          beta: Number.isFinite(beta) ? beta : null,
          rho: Number.isFinite(rho) ? rho : null,
          nu: Number.isFinite(nu) ? nu : null,
        },
        rmse: Number.isFinite(rmse) ? rmse : null,
        checks,
        passCount,
        totalCount,
        verdict,
        expiryFits,
        convergedCount,
        expiryCount: totalFits,
        averageFitRmse: Number.isFinite(averageFitRmse) ? averageFitRmse : null,
        bestFitExpiry: bestFit?.expiry_label || null,
        worstFitExpiry: worstFit?.expiry_label || null,
      };
    }

    const params = calib?.parameters || {};
    const v0 = Number(params?.v0);
    const theta = Number(params?.theta);
    const kappa = Number(params?.kappa);
    const xi = Number(params?.xi ?? params?.sigma);
    const rho = Number(params?.rho);
    const rmse = Number(calib?.weighted_rmse);
    const atmIv = Number(market?.atm_iv);

    const toFinite = (v) => (Number.isFinite(v) ? v : null);
    const instVol = Number.isFinite(v0) && v0 >= 0 ? Math.sqrt(v0) : null;
    const longVol = Number.isFinite(theta) && theta >= 0 ? Math.sqrt(theta) : null;
    const halfLifeDays = Number.isFinite(kappa) && kappa > 0 ? (Math.log(2) / kappa) * 252 : null;
    const fellerLhs = Number.isFinite(kappa) && Number.isFinite(theta) ? 2 * kappa * theta : null;
    const fellerRhs = Number.isFinite(xi) ? xi * xi : null;
    const fellerOk = Number.isFinite(fellerLhs) && Number.isFinite(fellerRhs) ? fellerLhs > fellerRhs : null;

    const crisis = Number.isFinite(atmIv) && atmIv > 0.35;
    const bounds = crisis
      ? {
          v0: [0.005, 0.15],
          theta: [0.005, 0.20],
          kappa: [0.2, 8.0],
          xi: [0.1, 2.0],
          rho: [-0.99, -0.05],
        }
      : {
          v0: [0.005, 0.05],
          theta: [0.01, 0.08],
          kappa: [0.3, 4.0],
          xi: [0.2, 1.2],
          rho: [-0.9, -0.2],
        };

    const inRange = (value, range) => Number.isFinite(value) && value >= range[0] && value <= range[1];
    const checks = {
      v0: inRange(v0, bounds.v0),
      theta: inRange(theta, bounds.theta),
      kappa: inRange(kappa, bounds.kappa),
      xi: inRange(xi, bounds.xi),
      rho: inRange(rho, bounds.rho),
      feller: fellerOk === true,
      halfLife: Number.isFinite(halfLifeDays) && halfLifeDays >= 5 && halfLifeDays <= 756,
      rmse: Number.isFinite(rmse) && rmse <= 0.25,
      converged: Boolean(calib?.converged),
    };
    const passCount = Object.values(checks).filter(Boolean).length;
    const totalCount = Object.keys(checks).length;
    const score = totalCount ? passCount / totalCount : 0;
    const verdict = score >= 0.8 ? 'Good' : score >= 0.55 ? 'Usable' : 'Unstable';

    return {
      model,
      params: {
        v0: toFinite(v0),
        theta: toFinite(theta),
        kappa: toFinite(kappa),
        xi: toFinite(xi),
        rho: toFinite(rho),
      },
      rmse: toFinite(rmse),
      instVol: toFinite(instVol),
      longVol: toFinite(longVol),
      halfLifeDays: toFinite(halfLifeDays),
      fellerLhs: toFinite(fellerLhs),
      fellerRhs: toFinite(fellerRhs),
      fellerOk,
      checks,
      passCount,
      totalCount,
      verdict,
      crisis,
    };
  }, [activeCalibration, activeModelName, market]);
  const calibrationCards = useMemo(() => {
    if (calibrationDiagnostics.model === 'SABR') {
      return [
        { label: 'Model', value: 'SABR' },
        { label: 'Status', value: activeCalibration?.converged ? 'Converged' : 'Partial', color: activeCalibration?.converged ? '#22c55e' : '#f59e0b' },
        { label: 'Iterations', value: activeCalibration?.iterations ?? '-' },
        { label: 'Weighted RMSE', value: formatNumber(calibrationDiagnostics.rmse, 6) },
        { label: 'Calibration Verdict', value: `${calibrationDiagnostics.verdict} (${calibrationDiagnostics.passCount}/${calibrationDiagnostics.totalCount})`, color: calibrationDiagnostics.verdict === 'Good' ? '#22c55e' : calibrationDiagnostics.verdict === 'Usable' ? '#f59e0b' : '#ef4444' },
        { label: 'Converged Expiry Fits', value: `${calibrationDiagnostics.convergedCount}/${calibrationDiagnostics.expiryCount || 0}` },
        { label: 'alpha', value: formatNumber(calibrationDiagnostics.params.alpha, 6) },
        { label: 'beta', value: formatNumber(calibrationDiagnostics.params.beta, 4) },
        { label: 'rho', value: formatNumber(calibrationDiagnostics.params.rho, 4) },
        { label: 'nu (Vol of Vol)', value: formatNumber(calibrationDiagnostics.params.nu, 6) },
        { label: 'Average Slice RMSE', value: formatNumber(calibrationDiagnostics.averageFitRmse, 6) },
        { label: 'Best Fit Expiry', value: calibrationDiagnostics.bestFitExpiry || '-' },
        { label: 'Worst Fit Expiry', value: calibrationDiagnostics.worstFitExpiry || '-' },
      ];
    }

    return [
      { label: 'Model', value: 'Heston' },
      { label: 'Status', value: activeCalibration?.converged ? 'Converged' : 'Not Converged', color: activeCalibration?.converged ? '#22c55e' : '#f43f5e' },
      { label: 'Iterations', value: activeCalibration?.iterations ?? '-' },
      { label: 'Weighted RMSE', value: formatNumber(calibrationDiagnostics.rmse, 6) },
      { label: 'Calibration Verdict', value: `${calibrationDiagnostics.verdict} (${calibrationDiagnostics.passCount}/${calibrationDiagnostics.totalCount})`, color: calibrationDiagnostics.verdict === 'Good' ? '#22c55e' : calibrationDiagnostics.verdict === 'Usable' ? '#f59e0b' : '#ef4444' },
      { label: 'v0 (Initial Variance)', value: formatNumber(calibrationDiagnostics.params.v0, 6) },
      { label: 'theta (Long-Run Variance)', value: formatNumber(calibrationDiagnostics.params.theta, 6) },
      { label: 'kappa (Mean Reversion)', value: formatNumber(calibrationDiagnostics.params.kappa, 4) },
      { label: 'sigma / xi (Vol of Vol)', value: formatNumber(calibrationDiagnostics.params.xi, 6) },
      { label: 'rho (Correlation)', value: formatNumber(calibrationDiagnostics.params.rho, 4) },
      { label: 'Regime Bounds', value: calibrationDiagnostics.crisis ? 'Crisis' : 'Normal' },
      { label: 'Sqrt(v0) Instant Vol', value: calibrationDiagnostics.instVol != null ? `${(calibrationDiagnostics.instVol * 100).toFixed(2)}%` : '-' },
      { label: 'Sqrt(theta) Long Vol', value: calibrationDiagnostics.longVol != null ? `${(calibrationDiagnostics.longVol * 100).toFixed(2)}%` : '-' },
      { label: 'Half-Life', value: calibrationDiagnostics.halfLifeDays != null ? `${formatNumber(calibrationDiagnostics.halfLifeDays, 1)} days` : '-' },
      { label: 'Feller Condition', value: calibrationDiagnostics.fellerOk ? 'Pass' : 'Fail', color: calibrationDiagnostics.fellerOk ? '#22c55e' : '#ef4444' },
      { label: '2*kappa*theta', value: formatNumber(calibrationDiagnostics.fellerLhs, 6) },
      { label: 'xi^2', value: formatNumber(calibrationDiagnostics.fellerRhs, 6) },
    ];
  }, [activeCalibration, calibrationDiagnostics]);

  useEffect(() => {
    setSliceExpiryIndex(selectedExpiryIndex);
  }, [selectedExpiryIndex]);

  useEffect(() => {
    const preferredModel = surface?.active_model || modelSelection || 'SABR';
    setSelectedSurfaceModel((current) => {
      if (availableSurfaceModels.includes(current)) {
        return current;
      }
      if (availableSurfaceModels.includes(preferredModel)) {
        return preferredModel;
      }
      return availableSurfaceModels[0] || preferredModel;
    });
  }, [surface?.active_model, modelSelection, availableSurfaceModels]);

  return (
    <SnapshotGuard loading={loading} activeSnapshotId={activeSnapshotId}>
      <div className="page-surface-grid">
        <div className="surface-hero">
          <Panel title={`Market + ${activeModelName} Combined Surface 3D`} enableCopyPlot>
            <Plot
              data={singleExpiry
                ? [
                    { type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: marketMatrix[0] || [], line: { color: '#22c55e', width: 2 }, name: 'Market Smile' },
                    { type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: smoothedModelMatrix[0] || [], line: { color: '#f59e0b', width: 2, shape: 'spline', smoothing: 1.1 }, name: `${activeModelName} Smile` },
                  ]
                : [
                    { type: 'surface', x: strikeGrid, y: maturityGrid, z: marketMatrix, colorscale: 'Viridis', opacity: 0.92, showscale: false, name: 'Market', text: marketExpiryText, hovertemplate: 'Strike: %{x:.0f}<br>Expiry: %{text}<br>IV: %{z:.4f}<extra>Market</extra>' },
                    { type: 'surface', x: denseModelSurface.strikeDense, y: denseModelSurface.maturityDense, z: denseModelSurface.matrixDense, colorscale: 'Portland', opacity: 0.72, showscale: true, name: activeModelName, hovertemplate: `Strike: %{x:.0f}<br>IV: %{z:.4f}<extra>${activeModelName}</extra>` },
                  ]}
              layout={{
                height: 360,
                margin: { l: 20, r: 20, b: 20, t: 20 },
                paper_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 11 },
                ...(singleExpiry
                  ? {
                      xaxis: { title: 'Strike', gridcolor: '#1f2937' },
                      yaxis: { title: 'IV', gridcolor: '#1f2937' },
                      annotations: [{ xref: 'paper', yref: 'paper', x: 0.02, y: 0.95, text: 'Single expiry: rendering smile slice', showarrow: false, font: { color: '#9ca3af', size: 10 } }],
                    }
                  : {
                      scene: { xaxis: { title: 'Strike' }, yaxis: expiryYAxis, zaxis: { title: 'IV' }, bgcolor: '#0a0f19' },
                    }),
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </Panel>
        </div>

        <Panel title="Market IV Surface 3D" enableCopyPlot>
          <Plot
            data={singleExpiry
              ? [{ type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: marketMatrix[0] || [], line: { color: '#22c55e', width: 2 }, name: 'Market Smile' }]
              : [{ type: 'surface', x: strikeGrid, y: maturityGrid, z: marketMatrix, colorscale: 'Viridis', text: marketExpiryText, hovertemplate: 'Strike: %{x:.0f}<br>Expiry: %{text}<br>IV: %{z:.4f}<extra></extra>' }]}
            layout={{
              height: 260,
              margin: { l: 20, r: 20, b: 20, t: 20 },
              paper_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              ...(singleExpiry
                ? {
                    xaxis: { title: 'Strike', gridcolor: '#1f2937' },
                    yaxis: { title: 'IV', gridcolor: '#1f2937' },
                  }
                : {
                    scene: { xaxis: { title: 'Strike' }, yaxis: expiryYAxis, zaxis: { title: 'IV' }, bgcolor: '#0a0f19' },
                  }),
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title={`${activeModelName} IV Surface 3D`} enableCopyPlot>
          <Plot
            data={singleExpiry
              ? [{ type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: smoothedModelMatrix[0] || [], line: { color: '#f59e0b', width: 2, shape: 'spline', smoothing: 1.1 }, name: `${activeModelName} Smile` }]
              : [{
                  type: 'surface',
                  x: denseModelSurface.strikeDense,
                  y: denseModelSurface.maturityDense,
                  z: denseModelSurface.matrixDense,
                  colorscale: 'Portland',
                  showscale: true,
                  contours: {
                    z: { show: false },
                  },
                  hovertemplate: `Strike: %{x:.0f}<br>IV: %{z:.4f}<extra>${activeModelName}</extra>`,
                }]}
            layout={{
              height: 260,
              margin: { l: 20, r: 20, b: 20, t: 20 },
              paper_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              ...(singleExpiry
                ? {
                    xaxis: { title: 'Strike', gridcolor: '#1f2937' },
                    yaxis: { title: 'IV', gridcolor: '#1f2937' },
                    annotations: [{ xref: 'paper', yref: 'paper', x: 0.02, y: 0.95, text: 'Single expiry: rendering smile slice', showarrow: false, font: { color: '#9ca3af', size: 10 } }],
                  }
                : {
                    scene: { xaxis: { title: 'Strike' }, yaxis: expiryYAxis, zaxis: { title: 'IV' }, bgcolor: '#0a0f19' },
                  }),
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
        <Panel title="Residual IV Surface 3D" enableCopyPlot>
          <Plot
            data={singleExpiry
              ? [{ type: 'scatter', mode: 'lines+markers', x: strikeGrid, y: displayResidualMatrix[0] || [], line: { color: '#f43f5e', width: 2 }, name: 'Residual' },
                 { type: 'scatter', mode: 'lines', x: [strikeGrid[0], strikeGrid[strikeGrid.length - 1]], y: [0, 0], line: { color: '#6b7280', width: 1, dash: 'dash' }, showlegend: false }]
              : [{
                  type: 'surface',
                  x: strikeGrid,
                  y: maturityGrid,
                  z: displayResidualMatrix,
                  colorscale: [[0,'#3b82f6'],[0.5,'#111827'],[1,'#ef4444']],
                  showscale: true,
                  colorbar: { title: 'Residual', tickformat: '.4f' },
                  cmid: 0,
                  hovertemplate: 'Strike: %{x:.0f}<br>Residual: %{z:.4f}<extra></extra>',
                }]}
            layout={{
              height: 260,
              margin: { l: 20, r: 20, b: 20, t: 20 },
              paper_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              ...(singleExpiry
                ? {
                    xaxis: { title: 'Strike', gridcolor: '#1f2937' },
                    yaxis: { title: 'Residual IV', gridcolor: '#1f2937' },
                  }
                : {
                    scene: { xaxis: { title: 'Strike' }, yaxis: expiryYAxis, zaxis: { title: 'Residual IV' }, bgcolor: '#0a0f19' },
                  }),
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>
        <Panel title="Max Pain by Expiry" enableCopyPlot>
          <Plot
            data={[
              {
                type: 'scatter',
                mode: 'lines+markers',
                x: expiryLabels,
                y: maxPainByExpiry,
                line: { color: '#f59e0b', width: 2 },
                marker: { color: '#f59e0b', size: 6 },
                name: 'Max Pain Strike',
              },
            ]}
            layout={{
              height: 180,
              margin: { l: 38, r: 20, b: 32, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Expiry' },
              yaxis: { title: 'Max Pain Strike' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
          <Plot
            data={[
              { type: 'bar', x: strikeGrid, y: selectedOiRow, marker: { color: '#38bdf8', opacity: 0.75 }, name: 'Open Interest' },
              selectedMaxPain
                ? {
                    type: 'scatter',
                    mode: 'lines',
                    x: [selectedMaxPain, selectedMaxPain],
                    y: [0, Math.max(...selectedOiRow.map((value) => Number(value) || 0), 1)],
                    line: { color: '#f59e0b', width: 2, dash: 'dash' },
                    name: 'Selected Expiry Max Pain',
                  }
                : null,
            ].filter(Boolean)}
            layout={{
              height: 170,
              margin: { l: 38, r: 20, b: 30, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 10 },
              xaxis: { title: 'Strike', gridcolor: '#1f2937' },
              yaxis: { title: 'Open Interest', gridcolor: '#1f2937' },
              barmode: 'overlay',
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </Panel>

        <Panel title="Distribution Plots (KDE)" enableCopyPlot>
          <Plot
            data={[
              {
                type: 'scatter',
                mode: 'lines',
                x: marketKDE.x,
                y: marketKDE.y,
                line: { color: '#22c55e', width: 2.5 },
                fill: 'tozeroy',
                fillcolor: 'rgba(34,197,94,0.15)',
                name: 'Market IV',
              },
              {
                type: 'scatter',
                mode: 'lines',
                x: modelKDE.x,
                y: modelKDE.y,
                line: { color: '#f59e0b', width: 2.5, dash: 'dot' },
                fill: 'tozeroy',
                fillcolor: 'rgba(245,158,11,0.10)',
                name: 'Model IV',
              },
            ]}
            layout={{
              height: 240,
              margin: { l: 36, r: 20, b: 30, t: 20 },
              paper_bgcolor: '#0a0f19',
              plot_bgcolor: '#0a0f19',
              font: { color: '#d1d5db', size: 11 },
              xaxis: { title: 'Implied Vol', gridcolor: '#1f2937' },
              yaxis: { title: 'Density', gridcolor: '#1f2937' },
              legend: { orientation: 'h' },
            }}
            config={{ displaylogo: false, responsive: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
          <div className="metric-strip">
            <div><span>Selected Expiry</span><strong>{expiryLabels[sliceExpiryIndex] || '-'}</strong></div>
            <div><span>Max Pain Strike</span><strong>{formatNumber(selectedMaxPain, 2)}</strong></div>
            <div><span>Market IV Mean</span><strong>{formatNumber(marketIvDistribution.length ? marketIvDistribution.reduce((a, b) => a + b, 0) / marketIvDistribution.length : 0, 6)}</strong></div>
            <div><span>Model IV Mean</span><strong>{formatNumber(modelIvDistribution.length ? modelIvDistribution.reduce((a, b) => a + b, 0) / modelIvDistribution.length : 0, 6)}</strong></div>
          </div>
        </Panel>
        <Panel title="Frequency-Domain Volatility (Signal Spectrum)" enableCopyPlot>
          {!singleExpiry && frequencyDomain.powerSpectrum.length ? (
            <>
              <Plot
                data={[
                  {
                    type: 'surface',
                    x: frequencyDomain.strikeFreq,
                    y: frequencyDomain.maturityFreq,
                    z: frequencyDomain.powerSpectrum,
                    colorscale: 'Portland',
                    showscale: true,
                    colorbar: { title: { text: 'Normalized Power (log10(1 + P/P99))' } },
                    hovertemplate:
                      'Strike Freq: %{x:.3f} cyc/step<br>Maturity Freq: %{y:.3f} cyc/step<br>Norm. Power: %{z:.6f}<extra></extra>',
                  },
                ]}
                layout={{
                  height: 220,
                  margin: { l: 26, r: 18, b: 20, t: 16 },
                  paper_bgcolor: '#0a0f19',
                  font: { color: '#d1d5db', size: 10 },
                  scene: {
                    xaxis: { title: { text: 'Strike Frequency (cycles per strike step)' } },
                    yaxis: { title: { text: 'Maturity Frequency (cycles per expiry step)' } },
                    zaxis: { title: { text: 'Spectral Power (normalized log scale)' } },
                    bgcolor: '#0a0f19',
                  },
                }}
                config={{ displaylogo: false, responsive: true }}
                style={{ width: '100%' }}
                useResizeHandler
              />
            </>
          ) : (
            <Plot
              data={[
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: frequencyDomain.expiryFrequencyAxis,
                  y: frequencyDomain.expirySpectrum,
                  line: { color: '#38bdf8', width: 2 },
                  marker: { color: '#38bdf8', size: 5 },
                  name: 'Expiry Spectrum',
                },
              ]}
              layout={{
                height: 220,
                margin: { l: 34, r: 18, b: 30, t: 16 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 10 },
                xaxis: { title: 'Strike Frequency', gridcolor: '#1f2937' },
                yaxis: { title: 'Normalized Log Power', gridcolor: '#1f2937' },
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          )}
          <div className="metric-strip">
            <div><span>Dominant Strike Freq</span><strong>{`${formatNumber(frequencyDomain.dominantStrikeFreq, 4)} cyc/step`}</strong></div>
            <div><span>Dominant Maturity Freq</span><strong>{`${formatNumber(frequencyDomain.dominantMaturityFreq, 4)} cyc/step`}</strong></div>
            <div><span>Dominant Spectral Power</span><strong>{formatNumber(frequencyDomain.dominantPower, 6)}</strong></div>
            <div><span>Transform Basis</span><strong>{`2D DFT (${activeModelName} IV)`}</strong></div>
            <div><span>Dominant Strike Cycle</span><strong>{frequencyDomain.dominantStrikeCyclePoints > 0 ? `${formatNumber(frequencyDomain.dominantStrikeCyclePoints, 1)} pts` : '-'}</strong></div>
            <div><span>Dominant Maturity Cycle</span><strong>{frequencyDomain.dominantMaturityCycleDays > 0 ? `${formatNumber(frequencyDomain.dominantMaturityCycleDays, 1)} days` : '-'}</strong></div>
            <div><span>Strike Step (Grid)</span><strong>{frequencyDomain.strikeStepPoints > 0 ? `${formatNumber(frequencyDomain.strikeStepPoints, 1)} pts` : '-'}</strong></div>
            <div><span>Maturity Step (Grid)</span><strong>{frequencyDomain.maturityStepDays > 0 ? `${formatNumber(frequencyDomain.maturityStepDays, 1)} days` : '-'}</strong></div>
          </div>
          <div style={{ marginTop: 6, color: '#94a3b8', fontSize: '0.68rem' }}>
            Frequency units are cycles per grid step. Cycle metrics convert those frequencies to approximate strike points and days.
          </div>
        </Panel>
        <Panel title={`${activeModelName} Calibration Summary`} className="surface-calibration-wide">
          {activeCalibration ? (
            <>
              <div className="surface-model-toolbar">
                <label>
                  Surface model
                  <select value={selectedSurfaceModel} onChange={(event) => setSelectedSurfaceModel(event.target.value)}>
                    {availableSurfaceModels.map((modelName) => (
                      <option key={modelName} value={modelName}>{modelName}</option>
                    ))}
                  </select>
                </label>
                <span>
                  Heston remains the production pricing engine. SABR is wired for surface-fit comparison across the 3D views.
                </span>
              </div>
              <div className="calibration-summary-grid compact">
                {calibrationCards.map((item) => (
                  <div key={`${activeModelName}-${item.label}`}>
                    <span>{item.label}</span>
                    <strong style={item.color ? { color: item.color } : undefined}>{item.value}</strong>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 6, color: '#94a3b8', fontSize: '0.68rem' }}>
                {calibrationDiagnostics.model === 'SABR'
                  ? 'SABR checks: parameter sanity, slice-fit RMSE, expiry coverage, and fit convergence across expiries.'
                  : 'Heston checks: parameter bounds, Feller condition, half-life (5 to 756 days), RMSE threshold, and convergence.'}
              </div>
              {calibrationDiagnostics.model === 'Heston' ? (
                <div style={{ marginTop: 6, color: '#6b7280', fontSize: '0.64rem', lineHeight: 1.35 }}>
                  Normal bounds: v0 [0.005, 0.05], theta [0.01, 0.08], kappa [0.3, 4.0], sigma/xi [0.2, 1.2], rho [-0.9, -0.2].<br />
                  Crisis bounds (ATM IV &gt; 35%): v0 [0.005, 0.15], theta [0.005, 0.20], kappa [0.2, 8.0], sigma/xi [0.1, 2.0], rho [-0.99, -0.05].
                </div>
              ) : (
                <div style={{ marginTop: 6, color: '#6b7280', fontSize: '0.64rem', lineHeight: 1.35 }}>
                  SABR is calibrated independently on each expiry slice using Hagan lognormal implied vols, then stitched into a 3D comparison surface.
                </div>
              )}
              {calibrationDiagnostics.model === 'Heston' && calibrationDiagnostics.verdict === 'Unstable' ? (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!canRecalibrate || recalibrating}
                    onClick={async () => {
                      if (!onRecalibrate) return;
                      setRecalibrating(true);
                      setRecalibrateMsg('');
                      try {
                        await onRecalibrate();
                        setRecalibrateMsg('Recalibration completed.');
                      } catch (error) {
                        setRecalibrateMsg(error?.message || 'Recalibration failed.');
                      } finally {
                        setRecalibrating(false);
                      }
                    }}
                  >
                    {recalibrating ? 'Recalibrating...' : 'Recalibrate'}
                  </button>
                  <span style={{ color: '#9ca3af', fontSize: '0.68rem' }}>
                    {canRecalibrate ? 'Use this when verdict is unstable.' : 'Live data id required for recalibration.'}
                  </span>
                </div>
              ) : null}
              {recalibrateMsg ? (
                <div style={{ marginTop: 6, color: recalibrateMsg.toLowerCase().includes('failed') ? '#ef4444' : '#22c55e', fontSize: '0.68rem' }}>
                  {recalibrateMsg}
                </div>
              ) : null}
            </>
          ) : (
            <p style={{color:'#6b7280', fontSize:'0.75rem'}}>Run pipeline to see calibration parameters.</p>
          )}
        </Panel>
        <Panel title="Slice Viewer" className="surface-slice-wide" enableCopyPlot>
          <div className="slice-controls">
            <label>Select Expiry
              <select
                value={sliceExpiryIndex}
                onChange={(event) => {
                  const nextIndex = Number(event.target.value);
                  setSliceExpiryIndex(nextIndex);
                  onExpiryIndexChange?.(nextIndex);
                }}
              >
                {formattedExpiryLabels.map((expiryLabel, index) => (
                  <option key={`slice-expiry-${expiryLabels[index] || index}`} value={index}>
                    {expiryLabel}
                  </option>
                ))}
              </select>
            </label>
            <label>Select Strike
              <select
                value={sliceStrikeIndex}
                onChange={(event) => setSliceStrikeIndex(Number(event.target.value))}
              >
                {strikeGrid.map((strike, index) => (
                  <option key={`slice-strike-${Number(strike) || index}`} value={index}>
                    {formatNumber(strike, 2)}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox-inline">
              <input type="checkbox" checked={logMoneyness} onChange={(event) => setLogMoneyness(event.target.checked)} />
              Toggle log moneyness
            </label>
          </div>
          <div className="slice-mini-grid">
            <Plot
              data={[
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: strikeGrid.map((strike) => (logMoneyness && market?.spot ? Math.log(Number(strike) / Number(market.spot)) : Number(strike))),
                  y: marketMatrix[sliceExpiryIndex] || [],
                  line: { color: '#22c55e', width: 2 },
                  name: 'Expiry Slice Mkt',
                },
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: strikeGrid.map((strike) => (logMoneyness && market?.spot ? Math.log(Number(strike) / Number(market.spot)) : Number(strike))),
                  y: smoothedModelMatrix[sliceExpiryIndex] || [],
                  line: { color: '#f59e0b', width: 2, shape: 'spline', smoothing: 1.1 },
                  name: 'Expiry Slice Mod',
                },
              ]}
              layout={{
                height: 150,
                margin: { l: 34, r: 12, b: 24, t: 20 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 10 },
                xaxis: { title: logMoneyness ? 'Log Moneyness' : 'Strike', gridcolor: '#1f2937' },
                yaxis: { title: 'IV', gridcolor: '#1f2937' },
                title: { text: 'Expiry Slice', font: { size: 10, color: '#9ca3af' }, x: 0.02, xanchor: 'left' },
                legend: { orientation: 'h', y: 1.2, font: { size: 9 } },
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
            <Plot
              data={[
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: formattedExpiryLabels,
                  y: strikeSeriesMarket,
                  line: { color: '#38bdf8', width: 2 },
                  name: 'Strike Slice Mkt',
                },
                {
                  type: 'scatter',
                  mode: 'lines+markers',
                  x: formattedExpiryLabels,
                  y: strikeSeriesModel,
                  line: { color: '#f43f5e', width: 2, shape: 'spline', smoothing: 1.1 },
                  name: 'Strike Slice Mod',
                },
              ]}
              layout={{
                height: 150,
                margin: { l: 34, r: 12, b: 24, t: 20 },
                paper_bgcolor: '#0a0f19',
                plot_bgcolor: '#0a0f19',
                font: { color: '#d1d5db', size: 10 },
                xaxis: { title: 'Expiry', gridcolor: '#1f2937' },
                yaxis: { title: 'IV', gridcolor: '#1f2937' },
                title: { text: 'Strike Slice', font: { size: 10, color: '#9ca3af' }, x: 0.02, xanchor: 'left' },
                legend: { orientation: 'h', y: 1.2, font: { size: 9 } },
              }}
              config={{ displaylogo: false, responsive: true }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </div>
          <div className="metric-strip">
            <div><span>Residual RMSE</span><strong>{formatNumber(residualRmse, 6)}</strong></div>
            <div><span>Selected Strike</span><strong>{formatNumber(selectedStrikeValue, 2)}</strong></div>
            <div><span>Max |Residual|</span><strong>{formatNumber(residualMaxAbs, 6)}</strong></div>
            <div><span>Selected Expiry</span><strong>{formattedExpiryLabels[sliceExpiryIndex] || '-'}</strong></div>
          </div>
        </Panel>
      </div>

    </SnapshotGuard>
  );
}
