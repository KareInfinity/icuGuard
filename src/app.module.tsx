import React from 'react';
import {AppNavigation} from './app.navigation';
import {Provider} from 'react-redux';
import {persistor, store} from './redux/store.redux';
import {PersistGate} from 'redux-persist/integration/react';
import {SafeAreaView} from 'react-native';

function App() {
  return (
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <SafeAreaView style={{flex: 1}}>
          <AppNavigation />
        </SafeAreaView>
      </PersistGate>
    </Provider>
  );
}

export {App};
