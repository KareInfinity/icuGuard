declare module 'react-native' {
  interface NativeModulesStatic {
    BatteryModule: {
      getBatteryLevel(): Promise<number>;
      getBatteryInfo(): Promise<BatteryInfo>;
      startBatteryMonitoring(): void;
      stopBatteryMonitoring(): void;
    };
  }
}

export interface BatteryInfo {
  level: number;
  isCharging?: boolean;
  state?: string;
  health?: string;
  technology?: string;
  temperature?: number;
  voltage?: number;
  thermalState?: string;
}

export interface BatteryEvent {
  level: number;
  type: 'level' | 'state';
  state?: string;
  isCharging?: boolean;
}
