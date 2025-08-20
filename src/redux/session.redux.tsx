import {createSlice, PayloadAction} from '@reduxjs/toolkit';
import {RootState} from './store.redux';

// Session interface
export interface Session {
  id: string;
  startTime: number;
  endTime?: number;
  duration: number; // in milliseconds
  status: 'active' | 'completed' | 'paused' | 'cancelled';
  transcriptionCount: number;
  totalTranscriptionLength: number;
  startBattery: number;
  endBattery?: number;
  isCharging?: boolean;
  metadata?: {
    deviceInfo?: string;
    location?: string;
    notes?: string;
  };
}

interface SessionState {
  sessions: Session[];
  currentSessionId: string | null;
  sessionHistory: Session[];
}

const initialState: SessionState = {
  sessions: [],
  currentSessionId: null,
  sessionHistory: [],
};

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    // Start a new session
    startSession: (state, action: PayloadAction<Omit<Session, 'endTime' | 'duration' | 'status'>>) => {
      const newSession: Session = {
        ...action.payload,
        status: 'active',
        duration: 0,
      };
      state.sessions.push(newSession);
      state.currentSessionId = newSession.id;
    },

    // End/complete a session
    endSession: (state, action: PayloadAction<{id: string; endTime: number; endBattery?: number}>) => {
      const sessionIndex = state.sessions.findIndex(s => s.id === action.payload.id);
      if (sessionIndex !== -1) {
        const session = state.sessions[sessionIndex];
        session.endTime = action.payload.endTime;
        session.duration = action.payload.endTime - session.startTime;
        session.status = 'completed';
        session.endBattery = action.payload.endBattery;
        
        // Move to history
        state.sessionHistory.push({...session});
        state.sessions.splice(sessionIndex, 1);
        
        if (state.currentSessionId === action.payload.id) {
          state.currentSessionId = null;
        }
      }
    },

    // Pause a session
    pauseSession: (state, action: PayloadAction<string>) => {
      const session = state.sessions.find(s => s.id === action.payload);
      if (session) {
        session.status = 'paused';
      }
    },

    // Resume a paused session
    resumeSession: (state, action: PayloadAction<string>) => {
      const session = state.sessions.find(s => s.id === action.payload);
      if (session) {
        session.status = 'active';
      }
    },

    // Cancel a session
    cancelSession: (state, action: PayloadAction<string>) => {
      const sessionIndex = state.sessions.findIndex(s => s.id === action.payload);
      if (sessionIndex !== -1) {
        const session = state.sessions[sessionIndex];
        session.status = 'cancelled';
        session.endTime = Date.now();
        session.duration = session.endTime - session.startTime;
        
        // Move to history
        state.sessionHistory.push({...session});
        state.sessions.splice(sessionIndex, 1);
        
        if (state.currentSessionId === action.payload) {
          state.currentSessionId = null;
        }
      }
    },

    // Update session transcription info
    updateSessionTranscription: (state, action: PayloadAction<{id: string; transcriptionCount: number; totalLength: number}>) => {
      const session = state.sessions.find(s => s.id === action.payload.id);
      if (session) {
        session.transcriptionCount = action.payload.transcriptionCount;
        session.totalTranscriptionLength = action.payload.totalLength;
      }
    },

    // Update session battery info
    updateSessionBattery: (state, action: PayloadAction<{id: string; batteryLevel: number; isCharging?: boolean}>) => {
      const session = state.sessions.find(s => s.id === action.payload.id);
      if (session) {
        session.endBattery = action.payload.batteryLevel;
        session.isCharging = action.payload.isCharging;
      }
    },

    // Update session metadata
    updateSessionMetadata: (state, action: PayloadAction<{id: string; metadata: Partial<Session['metadata']>}>) => {
      const session = state.sessions.find(s => s.id === action.payload.id);
      if (session) {
        session.metadata = { ...session.metadata, ...action.payload.metadata };
      }
    },

    // Clear all sessions (both active and history)
    clearAllSessions: (state) => {
      state.sessions = [];
      state.sessionHistory = [];
      state.currentSessionId = null;
    },

    // Clear only session history
    clearSessionHistory: (state) => {
      state.sessionHistory = [];
    },

    // Clear only active sessions
    clearActiveSessions: (state) => {
      state.sessions = [];
      state.currentSessionId = null;
    },

    // Delete a specific session from history
    deleteSessionFromHistory: (state, action: PayloadAction<string>) => {
      state.sessionHistory = state.sessionHistory.filter(s => s.id !== action.payload);
    },

    // Restore a session from history
    restoreSessionFromHistory: (state, action: PayloadAction<string>) => {
      const sessionIndex = state.sessionHistory.findIndex(s => s.id === action.payload);
      if (sessionIndex !== -1) {
        const session = state.sessionHistory[sessionIndex];
        const restoredSession: Session = {
          ...session,
          id: `${session.id}_restored_${Date.now()}`,
          startTime: Date.now(),
          endTime: undefined,
          duration: 0,
          status: 'active',
          transcriptionCount: 0,
          totalTranscriptionLength: 0,
        };
        state.sessions.push(restoredSession);
        state.currentSessionId = restoredSession.id;
        state.sessionHistory.splice(sessionIndex, 1);
      }
    },
  },
});

export const sessionActions = sessionSlice.actions;
export const sessionReducers = sessionSlice.reducer;

// Selectors
export const selectAllSessions = (state: RootState) => state.session.sessions;
export const selectActiveSessions = (state: RootState) => state.session.sessions.filter(s => s.status === 'active');
export const selectPausedSessions = (state: RootState) => state.session.sessions.filter(s => s.status === 'paused');
export const selectSessionHistory = (state: RootState) => state.session.sessionHistory;
export const selectCurrentSession = (state: RootState) => state.session.sessions.find(s => s.id === state.session.currentSessionId);
export const selectSessionCount = (state: RootState) => state.session.sessions.length;
export const selectHistoryCount = (state: RootState) => state.session.sessionHistory.length;
export const selectTotalSessionCount = (state: RootState) => state.session.sessions.length + state.session.sessionHistory.length;
