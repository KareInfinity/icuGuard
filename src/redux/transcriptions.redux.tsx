import {createSlice, PayloadAction} from '@reduxjs/toolkit';
import {RootState} from './store.redux';

// Audio recording interface
interface AudioRecording {
  id: string;
  uri: string;
  name: string;
  duration: number;
  timestamp: number;
  transcription?: string;
}

interface SessionData {
  id: number;
  startTime: number;
  lastChunkSendTime: number;
  totalTiming: string; // HH:MM:SS format
  startBattery: number;
  stopBattery?: number;
  currentBattery?: number; // Added: current battery level during session
  isActive: boolean;
  chunksSent: number;
  currentChunkStartTime: number;
  chunkInterval?: number; // Added: seconds between chunks
}

interface TranscriptionState {
  texts: string[];
  sessions: SessionData[];
  currentRecording: AudioRecording | null;
  settings: {
    chunkIntervalSeconds: number;
  };
}

const initialState: TranscriptionState = {
  texts: [],
  sessions: [],
  currentRecording: null,
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
    // Set current recording (replaces old one)
    setCurrentRecording: (state, action: PayloadAction<AudioRecording>) => {
      state.currentRecording = action.payload;
    },
    // Update transcription for current recording
    updateTranscription: (state, action: PayloadAction<{transcription: string}>) => {
      if (state.currentRecording) {
        state.currentRecording.transcription = action.payload.transcription;
      }
    },
    // Reset settings to default
    resetSettings: (state) => {
      state.settings = initialState.settings;
    },
    // Delete a recording by ID
    deleteRecording: (state, action: PayloadAction<string>) => {
      if (state.currentRecording && state.currentRecording.id === action.payload) {
        state.currentRecording = null;
      }
    },
    // Update current session battery level
    updateCurrentSessionBattery: (state, action: PayloadAction<{batteryLevel: number; isCharging?: boolean}>) => {
      if (state.currentRecording) {
        // Find the current session and update its battery info
        const currentSession = state.sessions.find(session => session.isActive);
        if (currentSession) {
          currentSession.startBattery = action.payload.batteryLevel;
        }
      }
    },
    // Update existing session data
    updateSession: (state, action: PayloadAction<SessionData>) => {
      const sessionIndex = state.sessions.findIndex(session => session.id === action.payload.id);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex] = action.payload;
      }
    },
    // Update session chunk information
    updateSessionChunk: (state, action: PayloadAction<{
      sessionId: number;
      chunkCount: number;
      lastChunkTime: number;
      currentBattery?: number;
    }>) => {
      const sessionIndex = state.sessions.findIndex(session => session.id === action.payload.sessionId);
      if (sessionIndex !== -1) {
        const session = state.sessions[sessionIndex];
        session.chunksSent = action.payload.chunkCount;
        session.lastChunkSendTime = action.payload.lastChunkTime;
        if (action.payload.currentBattery !== undefined) {
          session.currentBattery = action.payload.currentBattery;
        }
      }
    },
    // End a session
    endSession: (state, action: PayloadAction<{
      sessionId: number;
      stopBattery?: number;
    }>) => {
      const sessionIndex = state.sessions.findIndex(session => session.id === action.payload.sessionId);
      if (sessionIndex !== -1) {
        const session = state.sessions[sessionIndex];
        session.isActive = false;
        if (action.payload.stopBattery !== undefined) {
          session.stopBattery = action.payload.stopBattery;
        }
      }
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
export const selectCurrentRecording = (state: RootState) => state.transcriptions.currentRecording;
export const selectCurrentSession = (state: RootState) => state.transcriptions.sessions.find(session => session.isActive) || null;
export const selectPastSessions = (state: RootState) => state.transcriptions.sessions.filter(session => !session.isActive) || []; 