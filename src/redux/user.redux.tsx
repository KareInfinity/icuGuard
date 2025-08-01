import {createSlice, PayloadAction} from '@reduxjs/toolkit';
import {RootState} from './store.redux';

interface UserState {
  username: string;
  isFirstTime: boolean;
  hasCompletedSetup: boolean;
}

const userSlice = createSlice({
  name: 'user',
  initialState: {
    username: '',
    isFirstTime: true,
    hasCompletedSetup: false,
  } as UserState,
  reducers: {
    setUsername: (state, action: PayloadAction<string>) => {
      state.username = action.payload;
      state.hasCompletedSetup = true;
      state.isFirstTime = false;
    },
    completeSetup: (state) => {
      state.hasCompletedSetup = true;
      state.isFirstTime = false;
    },
    resetUser: (state) => {
      state.username = '';
      state.isFirstTime = true;
      state.hasCompletedSetup = false;
    },
  },
});

export const userActions = userSlice.actions;
export const userReducers = userSlice.reducer;
export const selectUser = (state: RootState) => state.user;
export const selectUsername = (state: RootState) => state.user.username;
export const selectIsFirstTime = (state: RootState) => state.user.isFirstTime;
export const selectHasCompletedSetup = (state: RootState) => state.user.hasCompletedSetup; 