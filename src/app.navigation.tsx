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
import {useSelector} from 'react-redux';
import {selectHasCompletedSetup} from './redux/user.redux';

import {RecordingContainer} from './container/recording.container';
import {AccountContainer} from './container/account.container';
import {UsernamePromptContainer} from './container/username-prompt.container';
import {TestingContainer} from './container/testing.container';

export type AppModuleParamList = {
  homemodule: NavigatorScreenParams<HomeModuleParamList>;
  usernamePrompt: undefined;
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
  const hasCompletedSetup = useSelector(selectHasCompletedSetup);

  return (
    <NavigationContainer theme={theme}>
      <appmodule.Navigator
        screenOptions={{
          headerTitleStyle: {color: '#333', fontWeight: 'normal'},
          headerBackTitle: Platform.OS == 'ios' ? 'Back' : '',
        }}>
        {!hasCompletedSetup ? (
          <appmodule.Screen
            name="usernamePrompt"
            component={UsernamePromptScreen}
            options={{
              headerShown: false,
            }}
          />
        ) : (
          <appmodule.Screen
            name="homemodule"
            component={HomeModuleNavigation}
            options={{
              headerShown: false,
              headerShadowVisible: false,
              headerStyle: {backgroundColor: '#f5f5f5'},
            }}
          />
        )}
      </appmodule.Navigator>
    </NavigationContainer>
  );
}

export type HomeModuleParamList = {
  recording: undefined;
  testing: undefined;
  account: {
    text: string;
  };
};

const homemodule = createBottomTabNavigator<HomeModuleParamList>();

type HomeModuleNavigationProps = NativeStackScreenProps<
  AppModuleParamList,
  'homemodule'
>;

type UsernamePromptScreenProps = NativeStackScreenProps<AppModuleParamList, 'usernamePrompt'>;

function UsernamePromptScreen({navigation}: UsernamePromptScreenProps) {
  const handleComplete = () => {
    // The navigation will automatically switch to the main app
    // when hasCompletedSetup becomes true
  };

  return <UsernamePromptContainer onComplete={handleComplete} />;
}

export function HomeModuleNavigation(props: HomeModuleNavigationProps) {
  return (
    <homemodule.Navigator
      screenOptions={{
        tabBarActiveTintColor: '#007AFF',
        tabBarShowLabel: false,
      }}>
      <homemodule.Screen
        name="recording"
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
            <Text style={{color: focused ? '#007AFF' : '#999', fontSize:24}}>
              👤
            </Text>
          ),
        }}
      />
        <homemodule.Screen
        name="testing"
        component={TestingContainer}
        options={{
          headerShown: false,
          tabBarIcon: ({color, size, focused}) => (
            <Text style={{color: focused ? '#007AFF' : '#999', fontSize: 24}}>
              🧪
            </Text>
          ),
        }}
      />
    </homemodule.Navigator>
  );
}
