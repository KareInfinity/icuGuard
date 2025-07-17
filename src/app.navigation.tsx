import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {
  createNativeStackNavigator,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';
import {
  DefaultTheme,
  NavigationContainer,
  NavigatorScreenParams,
} from '@react-navigation/native';
import {Platform, Text} from 'react-native';

import {RecordingContainer} from './container/recording.container';
import {AccountContainer} from './container/account.container';

export type AppModuleParamList = {
  homemodule: NavigatorScreenParams<HomeModuleParamList>;
};

const appmodule = createNativeStackNavigator<AppModuleParamList>();

const theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    appbg: '#f5f5f5',
  },
};

export function AppNavigation() {
  return (
    <NavigationContainer theme={theme}>
      <appmodule.Navigator
        screenOptions={{
          headerTitleStyle: {color: '#333', fontWeight: 'normal'},
          headerBackTitle: Platform.OS == 'ios' ? 'Back' : '',
        }}>
        <appmodule.Screen
          name="homemodule"
          component={HomeModuleNavigation}
          options={{
            headerShown: false,
            headerShadowVisible: false,
            headerStyle: {backgroundColor: '#f5f5f5'},
          }}
        />
      </appmodule.Navigator>
    </NavigationContainer>
  );
}

export type HomeModuleParamList = {
  home: undefined;
  account: {
    text: string;
  };
};

const homemodule = createBottomTabNavigator<HomeModuleParamList>();

type HomeModuleNavigationProps = NativeStackScreenProps<
  AppModuleParamList,
  'homemodule'
>;

export function HomeModuleNavigation(props: HomeModuleNavigationProps) {
  return (
    <homemodule.Navigator
      screenOptions={{
        tabBarActiveTintColor: '#007AFF',
        tabBarShowLabel: false,
      }}>
      <homemodule.Screen
        name="home"
        component={RecordingContainer}
        options={{
          headerShown: false,
          tabBarIcon: ({color, size, focused}) => (
            <Text style={{color: focused ? '#007AFF' : '#999', fontSize: 24}}>
              🎤
            </Text>
          ),
        }}
      />
      <homemodule.Screen
        name="account"
        component={AccountContainer}
        options={{
          headerShown: false,
          tabBarIcon: ({color, size, focused}) => (
            <Text style={{color: focused ? '#007AFF' : '#999', fontSize: 24}}>
              👤
            </Text>
          ),
        }}
      />
    </homemodule.Navigator>
  );
}
