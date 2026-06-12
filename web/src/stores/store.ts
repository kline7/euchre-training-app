import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Settings {
  difficulty: number; // 0=Novice, 1=Intermediate, 2=Advanced, 3=Expert
  animationSpeed: number; // 0.5-2.0 multiplier
  showHints: boolean;
  autoAnalyze: boolean;
  /** House rule: trump may not be led until broken. False = standard euchre.
   *  Applies to solo play and is sent as the preferred style when queueing
   *  for multiplayer (only same-style players are matched). */
  trumpMustBeBroken: boolean;
}

interface SettingsStore extends Settings {
  setDifficulty: (d: number) => void;
  setAnimationSpeed: (s: number) => void;
  setShowHints: (h: boolean) => void;
  setAutoAnalyze: (a: boolean) => void;
  setTrumpMustBeBroken: (b: boolean) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      difficulty: 1,
      animationSpeed: 1.0,
      showHints: true,
      autoAnalyze: true,
      trumpMustBeBroken: true,
      setDifficulty: (d) => set({ difficulty: d }),
      setAnimationSpeed: (s) => set({ animationSpeed: s }),
      setShowHints: (h) => set({ showHints: h }),
      setAutoAnalyze: (a) => set({ autoAnalyze: a }),
      setTrumpMustBeBroken: (b) => set({ trumpMustBeBroken: b }),
    }),
    { name: 'euchre-settings' },
  ),
);

// UI state (non-persisted)
interface UIState {
  engineReady: boolean;
  thinking: boolean;
  restartRequested: number;
  setEngineReady: (ready: boolean) => void;
  setThinking: (thinking: boolean) => void;
  requestRestart: () => void;
}

export const useUI = create<UIState>((set) => ({
  engineReady: false,
  thinking: false,
  restartRequested: 0,
  setEngineReady: (ready) => set({ engineReady: ready }),
  setThinking: (thinking) => set({ thinking: thinking }),
  requestRestart: () => set((s) => ({ restartRequested: s.restartRequested + 1 })),
}));
