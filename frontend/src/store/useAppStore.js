import { create } from 'zustand';

export const useAppStore = create((set) => ({
  staticResult: null,
  dynamicResult: null,
  dynamicState: 'idle',
  dynamicJobId: null,
  selectedStrategyIndex: 0,
  surfaceMode: 'market',
  error: null,

  setStaticResult: (value) => set({ staticResult: value }),
  setDynamicResult: (value) => set({ dynamicResult: value }),
  setDynamicState: (value) => set({ dynamicState: value }),
  setDynamicJobId: (value) => set({ dynamicJobId: value }),
  setSelectedStrategyIndex: (value) => set({ selectedStrategyIndex: value }),
  setSurfaceMode: (value) => set({ surfaceMode: value }),
  setError: (value) => set({ error: value }),
  clearError: () => set({ error: null }),
}));
