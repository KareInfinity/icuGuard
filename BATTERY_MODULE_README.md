# 🔋 Custom Battery Module for React Native

This project includes a custom native battery module that provides real-time battery information for both Android and iOS.

## 📱 Features

- **Real-time battery percentage** (0-100%)
- **Battery status** (charging, discharging, full)
- **Battery health** (Android only)
- **Battery temperature** (Android only)
- **Battery voltage** (Android only)
- **Thermal state** (iOS only)
- **Event monitoring** for battery changes

## 🏗️ Build Instructions

### Android

1. **Clean and rebuild:**
   ```bash
   cd android
   ./gradlew clean
   cd ..
   ```

2. **Rebuild the app:**
   ```bash
   npx react-native run-android
   ```

### iOS

1. **Install pods:**
   ```bash
   cd ios
   pod install
   cd ..
   ```

2. **Clean and rebuild:**
   ```bash
   npx react-native run-ios
   ```

## 🔧 Usage

### Basic Battery Level
```typescript
import { NativeModules } from 'react-native';

const batteryLevel = await NativeModules.BatteryModule.getBatteryLevel();
console.log(`Battery: ${batteryLevel}%`);
```

### Detailed Battery Info
```typescript
const batteryInfo = await NativeModules.BatteryModule.getBatteryInfo();
console.log('Battery Info:', batteryInfo);
// Returns: { level: 78, isCharging: false, state: "Unplugged", ... }
```

### Start Monitoring
```typescript
NativeModules.BatteryModule.startBatteryMonitoring();

// Listen for battery events
import { DeviceEventEmitter } from 'react-native';
DeviceEventEmitter.addListener('BatteryLevelChanged', (data) => {
  console.log('Battery changed:', data);
});
```

### Stop Monitoring
```typescript
NativeModules.BatteryModule.stopBatteryMonitoring();
```

## 📋 API Reference

### Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `getBatteryLevel()` | Get current battery percentage | `Promise<number>` |
| `getBatteryInfo()` | Get detailed battery information | `Promise<BatteryInfo>` |
| `startBatteryMonitoring()` | Start listening for battery changes | `void` |
| `stopBatteryMonitoring()` | Stop listening for battery changes | `void` |

### Events

| Event | Description | Data |
|-------|-------------|------|
| `BatteryLevelChanged` | Fired when battery level or status changes | `{ level: number, type: 'level' \| 'state', ... }` |

### Types

```typescript
interface BatteryInfo {
  level: number;           // Battery percentage (0-100)
  isCharging?: boolean;    // Whether device is charging
  state?: string;          // Battery state (Android: charging, discharging, full, not_charging)
  health?: string;         // Battery health (Android only)
  technology?: string;     // Battery technology (Android only)
  temperature?: number;    // Battery temperature in Celsius (Android only)
  voltage?: number;        // Battery voltage in millivolts (Android only)
  thermalState?: string;   // Thermal state (iOS only)
}
```

## 🚨 Troubleshooting

### Android Build Issues
- **Clean build:** `cd android && ./gradlew clean`
- **Invalidate caches** in Android Studio
- **Sync project** with Gradle files

### iOS Build Issues
- **Clean build folder** in Xcode (Product → Clean Build Folder)
- **Reset package cache:** `cd ios && pod deintegrate && pod install`
- **Clear derived data** in Xcode preferences

### Module Not Found
- Ensure the module is properly added to `MainApplication.kt` (Android)
- Check that `BatteryModule.swift` and `BatteryModule.m` are in the iOS project
- Rebuild the entire project after adding native modules

## 🔍 Testing

1. **Run the app** and navigate to the Testing screen
2. **Press "Get Detailed Battery Info"** button
3. **Check the logs** for battery information
4. **Start recording** to see battery level in session data

## 📝 Notes

- **Android:** Uses `BatteryManager` and `BroadcastReceiver` for real-time updates
- **iOS:** Uses `UIDevice` battery monitoring and `NotificationCenter`
- **Permissions:** No special permissions required
- **Performance:** Minimal overhead, efficient event handling
- **Compatibility:** Works with React Native 0.60+

## 🎯 Next Steps

- [ ] Add battery level to session metadata
- [ ] Implement low battery warnings
- [ ] Add battery optimization settings
- [ ] Create battery usage analytics
