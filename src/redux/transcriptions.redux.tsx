import {createSlice, PayloadAction} from '@reduxjs/toolkit';
import {RootState} from './store.redux';

interface TranscriptionState {
  texts: string[];
}

const initialState: TranscriptionState = {
  texts: [],
};

const transcriptionsSlice = createSlice({
  name: 'transcriptions',
  initialState,
  reducers: {
    // Set the initial list of transcriptions
    setTranscriptions: (state, action: PayloadAction<string[]>) => {
      state.texts = action.payload;
    },
    // Add new transcription text (append)
    addTranscription: (state, action: PayloadAction<string>) => {
      state.texts.push(action.payload);
    },
    // Add multiple transcription texts (append)
    addTranscriptions: (state, action: PayloadAction<string[]>) => {
      state.texts.push(...action.payload);
    },
    // Clear all transcriptions
    clearTranscriptions: (state) => {
      state.texts = [];
    },
  },
});

export const transcriptionActions = transcriptionsSlice.actions;
export const transcriptionReducers = transcriptionsSlice.reducer;

// Selectors
export const selectTranscriptions = (state: RootState) => state.transcriptions.texts;
export const selectTranscriptionCount = (state: RootState) => state.transcriptions.texts.length; 