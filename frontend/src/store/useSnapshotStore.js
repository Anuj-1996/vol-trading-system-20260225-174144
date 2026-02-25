import { create } from 'zustand';

export const useSnapshotStore = create((set) => ({
  activeSnapshotId: null,
  loading: false,
  error: null,
  market: null,
  surface: null,
  strategies: null,
  risk: null,
  backtest: null,
  portfolio: null,
  dynamicState: 'idle',
  selectedStrategyId: null,

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  setActiveSnapshotId: (activeSnapshotId) => set({ activeSnapshotId }),
  setDynamicState: (dynamicState) => set({ dynamicState }),
  setSelectedStrategyId: (selectedStrategyId) => set({ selectedStrategyId }),
  setSnapshotData: (payload) =>
    set((state) => ({
      market: payload.market ?? state.market,
      surface: payload.surface ?? state.surface,
      strategies: payload.strategies ?? state.strategies,
      risk: payload.risk ?? state.risk,
      backtest: payload.backtest ?? state.backtest,
      portfolio: payload.portfolio ?? state.portfolio,
      selectedStrategyId:
        payload.selectedStrategyId !== undefined
          ? payload.selectedStrategyId
          : state.selectedStrategyId,
    })),
  clearSnapshot: () =>
    set({
      activeSnapshotId: null,
      market: null,
      surface: null,
      strategies: null,
      risk: null,
      backtest: null,
      portfolio: null,
      selectedStrategyId: null,
      dynamicState: 'idle',
    }),
}));
