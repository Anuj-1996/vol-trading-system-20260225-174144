import React from 'react';

export const THEME_STORAGE_KEY = 'vol-trading-theme';

export const THEME_OPTIONS = [
  { key: 'light-dark', label: 'Light Dark' },
  { key: 'dark', label: 'Dark' },
  { key: 'true-dark', label: 'True Dark' },
];

export const ThemeContext = React.createContext('light-dark');

export const PLOT_THEME_TOKENS = {
  'light-dark': {
    background: '#0a0f19',
    grid: '#1f2937',
    zero: '#334155',
    font: '#d1d5db',
    sceneBackground: '#0a0f19',
  },
  dark: {
    background: '#070b12',
    grid: '#18212f',
    zero: '#273244',
    font: '#d1d5db',
    sceneBackground: '#070b12',
  },
  'true-dark': {
    background: '#000000',
    grid: '#161616',
    zero: '#262626',
    font: '#e5e7eb',
    sceneBackground: '#000000',
  },
};
