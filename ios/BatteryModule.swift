import Foundation
import UIKit

@objc(BatteryModule)
class BatteryModule: NSObject {
  
  @objc
  func getBatteryLevel(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    UIDevice.current.isBatteryMonitoringEnabled = true
    
    let batteryLevel = UIDevice.current.batteryLevel
    if batteryLevel >= 0 {
      let percentage = Int(batteryLevel * 100)
      resolve(percentage)
    } else {
      reject("BATTERY_ERROR", "Could not get battery level", nil)
    }
  }
  
  @objc
  func getBatteryInfo(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    UIDevice.current.isBatteryMonitoringEnabled = true
    
    let batteryLevel = UIDevice.current.batteryLevel
    let batteryState = UIDevice.current.batteryState
    
    var batteryInfo: [String: Any] = [:]
    
    if batteryLevel >= 0 {
      batteryInfo["level"] = Int(batteryLevel * 100)
    }
    
    var stateString = "Unknown"
    var isCharging = false
    
    switch batteryState {
    case .charging:
      stateString = "Charging"
      isCharging = true
    case .full:
      stateString = "Full"
      isCharging = true
    case .unplugged:
      stateString = "Unplugged"
      isCharging = false
    case .unknown:
      stateString = "Unknown"
      isCharging = false
    @unknown default:
      stateString = "Unknown"
      isCharging = false
    }
    
    batteryInfo["state"] = stateString
    batteryInfo["isCharging"] = isCharging
    
    // Get additional battery info if available
    if #available(iOS 11.0, *) {
      let thermalState = ProcessInfo.processInfo.thermalState
      var thermalString = "Unknown"
      
      switch thermalState {
      case .nominal:
        thermalString = "Nominal"
      case .fair:
        thermalString = "Fair"
      case .serious:
        thermalString = "Serious"
      case .critical:
        thermalString = "Critical"
      @unknown default:
        thermalString = "Unknown"
      }
      
      batteryInfo["thermalState"] = thermalString
    }
    
    resolve(batteryInfo)
  }
  
  @objc
  func startBatteryMonitoring() {
    UIDevice.current.isBatteryMonitoringEnabled = true
    
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(batteryLevelDidChange),
      name: UIDevice.batteryLevelDidChangeNotification,
      object: nil
    )
    
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(batteryStateDidChange),
      name: UIDevice.batteryStateDidChangeNotification,
      object: nil
    )
  }
  
  @objc
  func stopBatteryMonitoring() {
    UIDevice.current.isBatteryMonitoringEnabled = false
    
    NotificationCenter.default.removeObserver(
      self,
      name: UIDevice.batteryLevelDidChangeNotification,
      object: nil
    )
    
    NotificationCenter.default.removeObserver(
      self,
      name: UIDevice.batteryStateDidChangeNotification,
      object: nil
    )
  }
  
  @objc
  private func batteryLevelDidChange() {
    let batteryLevel = UIDevice.current.batteryLevel
    if batteryLevel >= 0 {
      let percentage = Int(batteryLevel * 100)
      
      let batteryInfo: [String: Any] = [
        "level": percentage,
        "type": "level"
      ]
      
      // Send event to React Native
      if let bridge = RCTBridge.current() {
        bridge.eventDispatcher().sendAppEvent(withName: "BatteryLevelChanged", body: batteryInfo)
      }
    }
  }
  
  @objc
  private func batteryStateDidChange() {
    let batteryState = UIDevice.current.batteryState
    var stateString = "Unknown"
    var isCharging = false
    
    switch batteryState {
    case .charging:
      stateString = "Charging"
      isCharging = true
    case .full:
      stateString = "Full"
      isCharging = true
    case .unplugged:
      stateString = "Unplugged"
      isCharging = false
    case .unknown:
      stateString = "Unknown"
      isCharging = false
    @unknown default:
      stateString = "Unknown"
      isCharging = false
    }
    
    let batteryInfo: [String: Any] = [
      "state": stateString,
      "isCharging": isCharging,
      "type": "state"
    ]
    
    // Send event to React Native
    if let bridge = RCTBridge.current() {
      bridge.eventDispatcher().sendAppEvent(withName: "BatteryLevelChanged", body: batteryInfo)
    }
  }
  
  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }
}
