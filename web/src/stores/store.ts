import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Settings {
  difficulty: number; // 0=Novice, 1=Intermediate, 2=Advanced, 3=Expert
  animationSpeed: number; // 0.5-2.0 multiplier
  showHints: boolean;
  autoAnalyze: boolean;
}

interface SettingsStore extends Settings {
  setDifficulty: (d: number) => void;
  setAnimationSpeed: (s: number) => void;
  setShowHints: (h: boolean) => void;
  setAutoAnalyze: (a: boolean) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      difficulty: 1,
      animationSpeed: 1.0,
      showHints: true,
      autoAnalyze: true,
      setDifficulty: (d) => set({ difficulty: d }),
      setAnimationSpeed: (s) => set({ animationSpeed: s }),
      setShowHints: (h) => set({ showHints: h }),
      setAutoAnalyze: (a) => set({ autoAnalyze: a }),
    }),
    { name: 'euchre-settings' },
  ),
);

// UI state (non-persisted)
interface UIState {
  engineReady: boolean;
  thinking: boolean;
  setEngineReady: (ready: boolean) => void;
  setThinking: (thinking: boolean) => void;
}

export const useUI = create<UIState>((set) => ({
  engineReady: false,
  thinking: false,
  setEngineReady: (ready) => set({ engineReady: ready }),
  setThinking: (thinking) => set({ thinking: thinking }),
}));
