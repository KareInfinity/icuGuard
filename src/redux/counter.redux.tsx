import {createSlice, PayloadAction} from '@reduxjs/toolkit';
import {RootState} from './store.redux';

const counterslice = createSlice({
  name: 'counter',
  initialState: {
    value: 0,
  },
  reducers: {
    incremented: state => {
      // Redux Toolkit allows us to write "mutating" logic in reducers. It
      // doesn't actually mutate the state because it uses the Immer library,
      // which detects changes to a "draft state" and produces a brand new
      // immutable state based off those changes

      state.value += 1;
    },
    decremented: state => {
      state.value -= 1;
    },
    // Use the PayloadAction type to declare the contents of `action.payload`
    incrementByAmount: (state, action: PayloadAction<number>) => {
      state.value += action.payload;
    },
  },
});

export const counteractions = counterslice.actions;
export const counterreducers = counterslice.reducer;
export const selectCounter = (state: RootState) => state.counter;
