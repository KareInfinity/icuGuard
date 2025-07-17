import {combineReducers, configureStore} from '@reduxjs/toolkit';
import {counteractions, counterreducers} from './counter.redux';
import {transcriptionReducers} from './transcriptions.redux';
import {
  persistStore,
  persistReducer,
  FLUSH,
  REHYDRATE,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
} from 'redux-persist';
import AsyncStorage from '@react-native-async-storage/async-storage';

const rootReducer = combineReducers({
  counter: counterreducers,
  transcriptions: transcriptionReducers,
});

const persistedreducer = persistReducer(
  {
    key: 'root',
    version: 1,
    storage: AsyncStorage,
  },
  rootReducer,
);
export const store = configureStore({
  reducer: persistedreducer,
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware({
      // serializableCheck: {
      //   ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      // },
      serializableCheck: false,
    }),
});
export let persistor = persistStore(store);
// Infer the `RootState` and `AppDispatch` types from the store itself
export type RootState = ReturnType<typeof store.getState>;
// Inferred type: {posts: PostsState, comments: CommentsState, users: UsersState}
export type AppDispatch = typeof store.dispatch;

export default store;
