import React, { useEffect } from 'react';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import KeepAwake from 'react-native-keep-awake';

import { AppNavigation } from './src/app.navigation';
import { persistor, store } from './src/redux/store.redux';

function App() {
  useEffect(() => {
    KeepAwake.activate(); // prevent screen from sleeping
    return () => KeepAwake.deactivate(); // allow sleep when app is closed
  }, []);

  return (
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <AppNavigation />
      </PersistGate>
    </Provider>
  );
}

export default App;
