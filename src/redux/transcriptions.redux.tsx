import {createSlice, PayloadAction} from '@reduxjs/toolkit';
import {RootState} from './store.redux';

interface SessionData {
  id: string;
  startTime: number;
  endTime: number;
  elapsedMs: number;
  startBatteryPercentage: number;
  endBatteryPercentage: number;
  timestamp: string;
  chunksSent: number;
  firstChunkTime: number;
  lastChunkTime: number;
  totalChunkTime: number;
}

interface TranscriptionState {
  texts: string[];
  sessions: SessionData[];
  settings: {
    chunkIntervalSeconds: number;
  };
}

const initialState: TranscriptionState = {
  texts: [],
  sessions: [],
  settings: {
    chunkIntervalSeconds: 20, // Default 20 seconds
  },
};

const transcriptionsSlice = createSlice({
  name: 'transcriptions',
  initialState,
  reducers: {
    // Set the initial list of transcriptions
    setTranscriptions: (state, action: PayloadAction<string[]>) => {
      if (!state.texts) {
        state.texts = [];
      }
      state.texts = action.payload;
    },
    // Add new transcription text (append)
    addTranscription: (state, action: PayloadAction<string>) => {
      if (!state.texts) {
        state.texts = [];
      }
      state.texts.push(action.payload);
    },
    // Add multiple transcription texts (append)
    addTranscriptions: (state, action: PayloadAction<string[]>) => {
      if (!state.texts) {
        state.texts = [];
      }
      state.texts.push(...action.payload);
    },
    // Clear all transcriptions
    clearTranscriptions: (state) => {
      state.texts = [];
    },
    // Add new session data
    addSession: (state, action: PayloadAction<SessionData>) => {
      if (!state.sessions) {
        state.sessions = [];
      }
      state.sessions.push(action.payload);
    },
    // Clear all sessions
    clearSessions: (state) => {
      state.sessions = [];
    },
    // Update chunk interval setting
    updateChunkInterval: (state, action: PayloadAction<number>) => {
      if (!state.settings) {
        state.settings = { chunkIntervalSeconds: 20 };
      }
      state.settings.chunkIntervalSeconds = action.payload;
    },
    // Reset settings to default
    resetSettings: (state) => {
      state.settings = initialState.settings;
    },
  },
});

export const transcriptionActions = transcriptionsSlice.actions;
export const transcriptionReducers = transcriptionsSlice.reducer;

// Selectors
export const selectTranscriptions = (state: RootState) => state.transcriptions.texts;
export const selectTranscriptionCount = (state: RootState) => state.transcriptions.texts.length;
export const selectSessions = (state: RootState) => state.transcriptions.sessions || [];
export const selectSessionCount = (state: RootState) => (state.transcriptions.sessions || []).length;
export const selectChunkInterval = (state: RootState) => state.transcriptions.settings?.chunkIntervalSeconds || 20;
export const selectSettings = (state: RootState) => state.transcriptions.settings || initialState.settings; 