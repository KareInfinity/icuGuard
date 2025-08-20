package com.whisper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

public class BatteryModule extends ReactContextBaseJavaModule {
    private final ReactApplicationContext reactContext;
    private BroadcastReceiver batteryReceiver;

    public BatteryModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
    }

    @Override
    public String getName() {
        return "BatteryModule";
    }

    @ReactMethod
    public void getBatteryLevel(Promise promise) {
        try {
            IntentFilter ifilter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
            Intent batteryStatus = reactContext.registerReceiver(null, ifilter);

            if (batteryStatus != null) {
                int level = batteryStatus.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = batteryStatus.getIntExtra(BatteryManager.EXTRA_SCALE, -1);

                if (level != -1 && scale != -1) {
                    float batteryPct = level * 100 / (float) scale;
                    int batteryPercentage = Math.round(batteryPct);
                    promise.resolve(batteryPercentage);
                } else {
                    promise.reject("BATTERY_ERROR", "Could not get battery level");
                }
            } else {
                promise.reject("BATTERY_ERROR", "Battery status is null");
            }
        } catch (Exception e) {
            promise.reject("BATTERY_ERROR", "Error getting battery level: " + e.getMessage());
        }
    }

    @ReactMethod
    public void getBatteryInfo(Promise promise) {
        try {
            IntentFilter ifilter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
            Intent batteryStatus = reactContext.registerReceiver(null, ifilter);

            if (batteryStatus != null) {
                WritableMap batteryInfo = Arguments.createMap();
                
                // Battery level
                int level = batteryStatus.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = batteryStatus.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                if (level != -1 && scale != -1) {
                    float batteryPct = level * 100 / (float) scale;
                    batteryInfo.putInt("level", Math.round(batteryPct));
                }

                // Battery status
                int status = batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                boolean isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                                   status == BatteryManager.BATTERY_STATUS_FULL;
                batteryInfo.putBoolean("isCharging", isCharging);

                // Battery health
                int health = batteryStatus.getIntExtra(BatteryManager.EXTRA_HEALTH, -1);
                String healthStatus = "Unknown";
                switch (health) {
                    case BatteryManager.BATTERY_HEALTH_GOOD:
                        healthStatus = "Good";
                        break;
                    case BatteryManager.BATTERY_HEALTH_OVERHEAT:
                        healthStatus = "Overheat";
                        break;
                    case BatteryManager.BATTERY_HEALTH_DEAD:
                        healthStatus = "Dead";
                        break;
                    case BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE:
                        healthStatus = "Over Voltage";
                        break;
                    case BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE:
                        healthStatus = "Unspecified Failure";
                        break;
                    case BatteryManager.BATTERY_HEALTH_COLD:
                        healthStatus = "Cold";
                        break;
                }
                batteryInfo.putString("health", healthStatus);

                // Battery technology
                String technology = batteryStatus.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY);
                batteryInfo.putString("technology", technology != null ? technology : "Unknown");

                // Battery temperature
                int temperature = batteryStatus.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1);
                if (temperature != -1) {
                    float tempCelsius = temperature / 10.0f;
                    batteryInfo.putDouble("temperature", tempCelsius);
                }

                // Battery voltage
                int voltage = batteryStatus.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1);
                if (voltage != -1) {
                    batteryInfo.putInt("voltage", voltage);
                }

                promise.resolve(batteryInfo);
            } else {
                promise.reject("BATTERY_ERROR", "Battery status is null");
            }
        } catch (Exception e) {
            promise.reject("BATTERY_ERROR", "Error getting battery info: " + e.getMessage());
        }
    }

    @ReactMethod
    public void startBatteryMonitoring() {
        if (batteryReceiver != null) {
            return; // Already monitoring
        }

        batteryReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (Intent.ACTION_BATTERY_CHANGED.equals(intent.getAction())) {
                    int level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                    int scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                    
                    if (level != -1 && scale != -1) {
                        float batteryPct = level * 100 / (float) scale;
                        int batteryPercentage = Math.round(batteryPct);
                        
                        WritableMap params = Arguments.createMap();
                        params.putInt("level", batteryPercentage);
                        
                        reactContext
                            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                            .emit("BatteryLevelChanged", params);
                    }
                }
            }
        };

        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_BATTERY_CHANGED);
        filter.addAction(Intent.ACTION_POWER_CONNECTED);
        filter.addAction(Intent.ACTION_POWER_DISCONNECTED);
        
        reactContext.registerReceiver(batteryReceiver, filter);
    }

    @ReactMethod
    public void stopBatteryMonitoring() {
        if (batteryReceiver != null) {
            reactContext.unregisterReceiver(batteryReceiver);
            batteryReceiver = null;
        }
    }
}
