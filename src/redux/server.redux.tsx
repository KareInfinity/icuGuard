import {createSlice, PayloadAction} from '@reduxjs/toolkit';
import {RootState} from './store.redux';
import {DEFAULT_SERVER_URL} from '../utils/serverUtils';

const serverSlice = createSlice({
  name: 'server',
  initialState: {
    customServerUrl: DEFAULT_SERVER_URL,
  },
  reducers: {
    setCustomServerUrl: (state, action: PayloadAction<string>) => {
      state.customServerUrl = action.payload;
    },
    resetServerUrl: (state) => {
      state.customServerUrl = DEFAULT_SERVER_URL;
    },
  },
});

export const serverActions = serverSlice.actions;
export const serverReducers = serverSlice.reducer;
export const selectServer = (state: RootState) => state.server;
export const selectCustomServerUrl = (state: RootState) => state.server.customServerUrl; 