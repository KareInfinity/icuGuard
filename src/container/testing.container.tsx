import * as React from 'react';
import {useEffect, useState, useRef} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  NativeModules,
  TextInput,
  Modal,
  FlatList,
  SectionList,
  Platform,
  DeviceEventEmitter,
} from 'react-native';
import {useDispatch, useSelector} from 'react-redux';
import {selectUsername} from '../redux/user.redux';
import {selectCustomServerUrl} from '../redux/server.redux';
import {
  transcriptionActions,
  selectCurrentRecording,
  selectSessions,
  selectCurrentSession,
  selectPastSessions,
} from '../redux/transcriptions.redux';
import AudioRecord from 'react-native-audio-record';
import RNFS from 'react-native-fs';
import {getCustomPlatformWSUrl} from '../utils/serverUtils';

/**
 * Enhanced Battery Monitoring System
 * 
 * This component now includes a comprehensive battery monitoring solution that prevents stale data:
 * 
 * 1. **Real-time Listener**: Uses DeviceEventEmitter to listen for 'BatteryLevelChanged' events
 *    from the native BatteryModule, providing immediate updates when the system broadcasts changes.
 * 
 * 2. **Periodic Refresh**: Falls back to a 30-second refresh interval to catch any missed broadcasts
 *    or ensure data freshness even when system events are delayed.
 * 
 * 3. **Enhanced Fallback**: The existing getBatteryLevel() function is enhanced with updateBatteryLevel()
 *    which provides better error handling and change detection.
 * 
 * 4. **Manual Refresh**: Users can manually refresh battery data via the "Refresh Battery" button.
 * 
 * This approach ensures battery data is always current and prevents the "stuck at 25%" issue
 * by combining push (listener) and pull (manual/periodic) update mechanisms.
 */

interface SessionData {
  id: number;
  startTime: number;
  lastChunkSendTime: number;
  totalTiming: string;
  startBattery: number;
  stopBattery?: number;
  currentBattery?: number; // Added: current battery level during session
  isActive: boolean;
  chunksSent: number;
  currentChunkStartTime: number;
  chunkInterval?: number; // Added: seconds between chunks
}

export function TestingContainer() {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [audioRecordInitialized, setAudioRecordInitialized] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sentCount, setSentCount] = useState<number>(0);
  const [processedCount, setProcessedCount] = useState<number>(0);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [showChunkIntervalModal, setShowChunkIntervalModal] = useState(false);
  const [chunkIntervalSeconds, setChunkIntervalSeconds] =
    useState<string>('20');
  const [currentBatteryLevel, setCurrentBatteryLevel] = useState<number | null>(
    null,
  );
  const [wsConnected, setWsConnected] = useState(false);
  const [wsConnecting, setWsConnecting] = useState(false);
  const [showSessionsList, setShowSessionsList] = useState(false);
  const [batteryThreshold, setBatteryThreshold] = useState<number>(5); // Battery threshold for auto-stop

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const recordingStartTimeRef = useRef<number | null>(null);
  const chunkIdRef = useRef<number>(1);
  const startRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const dispatch = useDispatch();
  const username = useSelector(selectUsername);
  const customServerUrl = useSelector(selectCustomServerUrl);
  const currentRecording = useSelector(selectCurrentRecording);
  const sessions = useSelector(selectSessions);
  const currentSession = useSelector(selectCurrentSession);
  const pastSessions = useSelector(selectPastSessions);

  // Check audio permissions
  const checkAudioPermissions = async () => {
    try {
      // For Android, we'll check if we can access the microphone
      if (Platform.OS === 'android') {
        const {PermissionsAndroid} = require('react-native');
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone Permission',
            message:
              'This app needs access to your microphone to record audio.',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          },
        );

        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          addLog('✅ Microphone permission granted');
          return true;
        } else {
          addLog('❌ Microphone permission denied');
          return false;
        }
      }

      // For iOS, permissions are handled differently
      addLog('ℹ️ iOS audio permissions handled by system');
      return true;
    } catch (error) {
      addLog(`❌ Permission check failed: ${String(error)}`);
      return false;
    }
  };

  // Initialize audio recorder with retry logic
  useEffect(() => {
    const initializeAudioRecord = async (retryCount = 0) => {
      try {
        addLog(`🔧 Initializing AudioRecord... (attempt ${retryCount + 1})`);

        // Check if AudioRecord module is available
        if (!AudioRecord || typeof AudioRecord.init !== 'function') {
          throw new Error(
            'AudioRecord module not properly imported or corrupted',
          );
        }

        // Check permissions first
        const hasPermission = await checkAudioPermissions();
        if (!hasPermission) {
          throw new Error('Microphone permission denied');
        }

        const options = {
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
          wavFile: 'voice_recording.wav',
        };

        addLog(`📋 AudioRecord options: ${JSON.stringify(options)}`);
        await AudioRecord.init(options);
        setAudioRecordInitialized(true);
        addLog('✅ Audio recorder initialized successfully');
      } catch (error) {
        addLog(
          `❌ AudioRecord init attempt ${retryCount + 1} failed: ${String(
            error,
          )}`,
        );

        if (retryCount < 3) {
          // Wait 1 second before retrying
          setTimeout(() => {
            initializeAudioRecord(retryCount + 1);
          }, 1000);
        } else {
          addLog('❌ Failed to initialize AudioRecord after all retries');
          setAudioRecordInitialized(false);

          const errorMessage = String(error);
          if (errorMessage.includes('permission')) {
            Alert.alert(
              'Permission Required',
              'Microphone permission is required. Please grant microphone access in your device settings and restart the app.',
            );
          } else {
            Alert.alert(
              'Audio Error',
              'Failed to initialize audio recorder. Please restart the app and try again.',
            );
          }
        }
      }
    };

    // Add a small delay to ensure the component is fully mounted
    const timer = setTimeout(() => {
      initializeAudioRecord();
    }, 500);

    return () => {
      clearTimeout(timer);
      // Cleanup recording state when component unmounts
      if (isRecording) {
        addLog('🧹 Cleaning up recording state on unmount');
        if (recordingIntervalRef.current) {
          clearInterval(recordingIntervalRef.current);
        }
        // Try to stop recording gracefully
        if (typeof AudioRecord.stop === 'function') {
          AudioRecord.stop().catch(() => {
            // Ignore errors during cleanup
          });
        }
      }
    };
  }, []);

  const addLog = (message: string) => {
    const timestamp = new Date().toISOString().substr(11, 8);
    const logMessage = `[${timestamp}] ${message}`;
    setLogs(prev => [logMessage, ...prev].slice(0, 100));
    console.log(logMessage);
  };

  const startRecording = async () => {
    addLog(`🔍 AudioRecord state check: initialized=${audioRecordInitialized}`);

    if (!audioRecordInitialized) {
      addLog('❌ Cannot start recording: AudioRecord not initialized');
      Alert.alert(
        'Audio Error',
        'Audio recorder not initialized. Please wait for initialization or use the "Reinitialize Audio" button.',
      );
      return;
    }

    try {
      addLog('🎤 Starting recording...');

      // Double-check AudioRecord is available
      if (typeof AudioRecord.start !== 'function') {
        throw new Error(
          'AudioRecord.start is not a function - module may be corrupted',
        );
      }

      // Check if already recording
      if (isRecording) {
        addLog('⚠️ Already recording, stopping current recording first');
        await stopRecording();
        // Wait a bit before starting new recording
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      await AudioRecord.start();
      setIsRecording(true);
      setRecordingDuration(0);
      recordingStartTimeRef.current = Date.now();

      recordingIntervalRef.current = setInterval(() => {
        if (recordingStartTimeRef.current) {
          setRecordingDuration(Date.now() - recordingStartTimeRef.current);
        }
      }, 100);

      addLog('✅ Recording started successfully');
    } catch (error) {
      const errorMessage = String(error);
      addLog(`❌ Recording failed: ${errorMessage}`);

      // Check if it's the uninitialized error
      if (
        errorMessage.includes('uninitialized') ||
        errorMessage.includes('not initialized')
      ) {
        addLog('🔄 AudioRecord lost initialization, resetting state');
        setAudioRecordInitialized(false);
        Alert.alert(
          'Audio Error',
          'Audio recorder lost initialization. Please use the "Reinitialize Audio" button and try again.',
        );
      } else if (
        errorMessage.includes('permission') ||
        errorMessage.includes('denied')
      ) {
        addLog('🚫 Audio permission denied');
        Alert.alert(
          'Permission Required',
          'Audio recording permission is required. Please grant microphone access in your device settings.',
        );
      } else if (
        errorMessage.includes('already recording') ||
        errorMessage.includes('recording')
      ) {
        addLog('🔄 AudioRecord already recording, stopping first');
        try {
          await AudioRecord.stop();
          addLog('✅ Stopped existing recording');
          // Try starting again after a short delay
          setTimeout(() => {
            startRecording();
          }, 1000);
        } catch (stopError) {
          addLog(`❌ Failed to stop existing recording: ${String(stopError)}`);
        }
      } else {
        Alert.alert(
          'Recording Error',
          `Failed to start recording: ${errorMessage}`,
        );
      }
    }
  };

  const stopRecording = async () => {
    addLog(`🛑 Attempting to stop recording... (isRecording: ${isRecording})`);

    if (!isRecording) {
      addLog('⚠️ Not currently recording, nothing to stop');
      return;
    }

    try {
      addLog('🔄 Stopping AudioRecord...');

      // Check if AudioRecord.stop is available
      if (typeof AudioRecord.stop !== 'function') {
        throw new Error(
          'AudioRecord.stop is not a function - module may be corrupted',
        );
      }

      const audioFile = await AudioRecord.stop();
      addLog(
        `📁 AudioRecord.stop() returned: ${
          audioFile ? 'file path' : 'null/undefined'
        }`,
      );

      // Reset recording state
      setIsRecording(false);
      setRecordingDuration(0);
      recordingStartTimeRef.current = null;

      // Clear the recording interval
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
        addLog('⏱️ Recording interval cleared');
      }

      if (audioFile) {
        const recording = {
          id: Date.now().toString(),
          uri: audioFile,
          name: `recording_${Date.now()}.wav`,
          duration: recordingDuration,
          timestamp: Date.now(),
        };

        dispatch(transcriptionActions.setCurrentRecording(recording));
        addLog(`✅ Recording saved: ${Math.round(recordingDuration / 1000)}s`);
        addLog(`📁 File path: ${audioFile}`);
      } else {
        addLog('⚠️ AudioRecord.stop() returned no file path');
      }

      addLog('✅ Recording stopped successfully');
    } catch (error) {
      const errorMessage = String(error);
      addLog(`❌ Failed to stop recording: ${errorMessage}`);

      // Force reset recording state even if there's an error
      setIsRecording(false);
      setRecordingDuration(0);
      recordingStartTimeRef.current = null;

      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }

      // Check for specific error types
      if (
        errorMessage.includes('not recording') ||
        errorMessage.includes('no recording')
      ) {
        addLog('ℹ️ AudioRecord was not recording, state reset');
      } else if (errorMessage.includes('permission')) {
        addLog('🚫 Permission error while stopping recording');
        Alert.alert(
          'Permission Error',
          'Failed to stop recording due to permission issues.',
        );
      } else {
        Alert.alert(
          'Recording Error',
          `Failed to stop recording: ${errorMessage}`,
        );
      }
    }
  };

  const formatDuration = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const formatHMS = (ms: number): string => {
    if (ms <= 0) return '00:00:00';
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600)
      .toString()
      .padStart(2, '0');
    const minutes = Math.floor((totalSec % 3600) / 60)
      .toString()
      .padStart(2, '0');
    const seconds = (totalSec % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  };

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
  };

  // Custom native battery module - most reliable method
  const getBatteryLevel = async (): Promise<number> => {
    try {
      // Try our custom BatteryModule first (most reliable)
      if (
        NativeModules.BatteryModule &&
        NativeModules.BatteryModule.getBatteryLevel
      ) {
        try {
          const batteryLevel =
            await NativeModules.BatteryModule.getBatteryLevel();
          if (
            typeof batteryLevel === 'number' &&
            batteryLevel >= 0 &&
            batteryLevel <= 100
          ) {
            setCurrentBatteryLevel(batteryLevel);
            addLog(`🔋 Battery: ${batteryLevel}% (Custom BatteryModule)`);
            return batteryLevel;
          }
        } catch (error) {
          addLog(`⚠️ Custom BatteryModule failed: ${String(error)}`);
        }
      }

      // Fallback to RNDeviceInfo if available
      if (
        NativeModules.RNDeviceInfo &&
        NativeModules.RNDeviceInfo.getBatteryLevel
      ) {
        try {
          const batteryLevel =
            await NativeModules.RNDeviceInfo.getBatteryLevel();
          if (
            typeof batteryLevel === 'number' &&
            batteryLevel >= 0 &&
            batteryLevel <= 1
          ) {
            const batteryPercentage = Math.round(batteryLevel * 100);
            setCurrentBatteryLevel(batteryPercentage);
            addLog(`🔋 Battery: ${batteryPercentage}% (RNDeviceInfo)`);
            return batteryPercentage;
          }
        } catch (error) {
          addLog(`⚠️ RNDeviceInfo failed: ${String(error)}`);
        }
      }

      addLog('⚠️ No battery level method available, using fallback');
      return 100;
    } catch (error) {
      addLog(`❌ Error getting battery level: ${String(error)}`);
      return 100;
    }
  };

  // Enhanced battery level update with fallback refresh
  const updateBatteryLevel = async (): Promise<number> => {
    try {
      const freshLevel = await getBatteryLevel();
      
      // If the level is significantly different from current state, log it
      if (currentBatteryLevel !== null && Math.abs(freshLevel - currentBatteryLevel) > 5) {
        addLog(`🔋 Battery level changed significantly: ${currentBatteryLevel}% → ${freshLevel}%`);
      }
      
      setCurrentBatteryLevel(freshLevel);
      return freshLevel;
    } catch (error) {
      addLog(`❌ Failed to update battery level: ${String(error)}`);
      return currentBatteryLevel || 100;
    }
  };

  // Check battery level and auto-stop if below threshold
  const checkBatteryAndAutoStop = async (): Promise<boolean> => {
    try {
      const currentBattery = await updateBatteryLevel();
      
      if (currentBattery <= batteryThreshold) {
        addLog(`🔋⚠️ Battery level critical: ${currentBattery}% (threshold: ${batteryThreshold}%)`);
        addLog(`🛑 Auto-stopping session due to low battery`);
        
        // Show alert to user
        // Alert.alert(
        //   'Low Battery Warning',
        //   `Battery level is at ${currentBattery}% (below ${batteryThreshold}% threshold). Session will be stopped automatically to preserve battery.`,
        //   [{ text: 'OK' }]
        // );
        
        // Immediately stop all running states
        setIsRunning(false);
        
        // Clear all intervals immediately
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (sendIntervalRef.current) {
          clearInterval(sendIntervalRef.current);
          sendIntervalRef.current = null;
        }
        
        // Stop the session and mark as inactive
        await stopSending();
        
        // End ALL active sessions due to low battery
        const activeSessions = sessions.filter(s => s.isActive);
        if (activeSessions.length > 0) {
          addLog(`🔋⚠️ Ending all ${activeSessions.length} active sessions due to low battery`);
          for (const session of activeSessions) {
            const stopBattery = await updateBatteryLevel();
            dispatch(
              transcriptionActions.endSession({
                sessionId: session.id,
                stopBattery,
              }),
            );
            addLog(`✅ Session ${session.id} ended due to low battery (${stopBattery}%)`);
          }
        }
        
        // Force update to ensure UI reflects the stopped state
        setElapsedMs(0);
        setSentCount(0);
        
        addLog(`🛑 All sessions stopped due to low battery`);
        return true; // Indicates session was stopped
      }
      
      return false; // Session continues
    } catch (error) {
      addLog(`❌ Failed to check battery for auto-stop: ${String(error)}`);
      return false;
    }
  };

  const getDetailedBatteryInfo = async () => {
    try {
      if (
        NativeModules.BatteryModule &&
        NativeModules.BatteryModule.getBatteryInfo
      ) {
        const batteryInfo = await NativeModules.BatteryModule.getBatteryInfo();
        addLog(`🔋 Detailed Battery Info: ${JSON.stringify(batteryInfo)}`);
        return batteryInfo;
      }
    } catch (error) {
      addLog(`⚠️ Failed to get detailed battery info: ${String(error)}`);
    }
  };





  // Update battery and chunk data only after server confirms receipt
  const updateBatteryAndChunkAfterServerAck = async (chunkId: number, sessionId: number) => {
    try {
      addLog(`🔄 Server confirmed chunk ${chunkId}, updating battery and session data...`);
      
      // Check battery level and auto-stop if necessary
      const wasStopped = await checkBatteryAndAutoStop();
      if (wasStopped) {
        addLog(`🛑 Session stopped due to low battery after chunk ${chunkId}`);
        return;
      }
      
      // Get current battery level after server confirmation
      const currentBattery = await updateBatteryLevel();
      addLog(`🔋 Battery updated after server ack for chunk ${chunkId}: ${currentBattery}%`);
      
      // Update session chunk information
      const now = Date.now();
      
      dispatch(
        transcriptionActions.updateSessionChunk({
          sessionId: sessionId,
          chunkCount: chunkId,
          lastChunkTime: now,
          currentBattery: currentBattery,
        }),
      );
      
      // Update the session's currentBattery field
      const existingSession = sessions.find(s => s.id === sessionId);
      if (existingSession) {
        const updatedSession: SessionData = {
          ...existingSession,
          currentBattery: currentBattery,
          chunksSent: chunkId,
          lastChunkSendTime: now,
        };
        dispatch(transcriptionActions.updateSession(updatedSession));
      }
      
      // Update local state to reflect successful chunk
      setSentCount(chunkId);
      
      addLog(`✅ Chunk ${chunkId} data updated after server confirmation`);
    } catch (error) {
      addLog(`❌ Failed to update chunk ${chunkId} data after server ack: ${String(error)}`);
    }
  };

  const connectWebSocket = async (): Promise<void> => {
    return new Promise((resolve, reject) => {
      try {
        addLog('🔌 Connecting to WebSocket...');
        setWsConnecting(true);
        setWsConnected(false);

        const wsUrl = getCustomPlatformWSUrl(customServerUrl);
        addLog(`🌐 WebSocket URL: ${wsUrl}`);

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          addLog('✅ WebSocket connected successfully');

          const initMessage = {
            type: 'init',
            username: username || 'unknown',
          };

          try {
            ws.send(JSON.stringify(initMessage));
            addLog(
              `📤 Sent initialization message with username: ${
                username || 'unknown'
              }`,
            );
          } catch (error) {
            addLog(`❌ Failed to send initialization message: ${error}`);
          }

          setWsConnected(true);
          setWsConnecting(false);
          resolve();
        };

        ws.onerror = error => {
          addLog(`❌ WebSocket connection error: ${error}`);
          setWsConnected(false);
          setWsConnecting(false);
          reject(new Error('WebSocket connection failed'));
        };

        ws.onclose = event => {
          addLog(`🔌 WebSocket closed: ${event.code} ${event.reason}`);
          setWsConnected(false);
          setWsConnecting(false);
        };

        ws.onmessage = event => {
          try {
            const message = JSON.parse(event.data);
            addLog(`📨 WebSocket message received: ${JSON.stringify(message)}`);

            if (message.type === 'transcription') {
              if (message.text) {
                dispatch(transcriptionActions.addTranscription(message.text));
                addLog(`📝 Transcription received: ${message.text}`);
              }
            } else if (message.type === 'audio_received') {
              addLog(`✅ Server acknowledged audio chunk: ${message.chunk}`);
              
              // Update battery level and session data only after server confirmation
              if (message.chunk && message.session_id) {
                updateBatteryAndChunkAfterServerAck(message.chunk, message.session_id);
              }
            } else if (message.type === 'session_complete') {
              addLog('✅ Session completed on server side');
            } else if (message.type === 'initialized') {
              addLog(
                `✅ Server initialized session for user: ${message.username}`,
              );
              addLog(
                `📊 Session info - ID: ${message.session_id}, Count: ${message.session_count}`,
              );
            }
          } catch (error) {
            addLog(`❌ Error parsing WebSocket message: ${error}`);
          }
        };

        setTimeout(() => {
          if (ws.readyState === WebSocket.CONNECTING) {
            ws.close();
            setWsConnected(false);
            setWsConnecting(false);
            reject(new Error('WebSocket connection timeout'));
          }
        }, 10000);
      } catch (error) {
        addLog(`❌ WebSocket connection failed: ${error}`);
        setWsConnected(false);
        setWsConnecting(false);
        reject(error);
      }
    });
  };

  const disconnectWebSocket = () => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
        wsRef.current = null;
        setWsConnected(false);
        setWsConnecting(false);
        addLog('🔌 WebSocket disconnected');
      } catch (error) {
        addLog(`⚠️ Error during WebSocket cleanup: ${error}`);
      }
    }
  };

  const sendAudioViaWebSocket = async (
    audioData: string,
    chunkId: number,
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      try {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          throw new Error('WebSocket not connected');
        }

        if (!audioData || audioData.length === 0) {
          throw new Error('No audio data to send');
        }

        addLog(`📤 Sending audio chunk ${chunkId} via WebSocket...`);
        addLog(`📊 Audio size: ${audioData.length} characters`);

        const audioMessage = {
          type: 'audio',
          data: audioData,
          chunk_id: chunkId,
          language: 'en',
        };

        wsRef.current.send(JSON.stringify(audioMessage));
        addLog(`✅ Audio chunk ${chunkId} sent via WebSocket`);

        resolve();
      } catch (error) {
        addLog(
          `❌ Failed to send audio chunk ${chunkId} via WebSocket: ${error}`,
        );
        reject(error);
      }
    });
  };

  const initSession = async (): Promise<{
    sessionId: string;
    sessionData: SessionData;
  } | null> => {
    try {
      if (!customServerUrl || !username) {
        addLog('Server URL or username not set');
        return null;
      }

      addLog('Initializing session...');
      const startBattery = await updateBatteryLevel();

      await connectWebSocket();
      addLog('✅ WebSocket connected for session initialization');

      // Get current sessions count and increment by 1 for new session ID
      const sid = sessions ? sessions.length + 1 : 1;
      const now = Date.now();

      const sessionData: SessionData = {
        id: sid,
        startTime: now,
        lastChunkSendTime: now,
        totalTiming: '00:00:00',
        startBattery,
        currentBattery: startBattery, // Initialize current battery with start battery
        isActive: true,
        chunksSent: 0,
        currentChunkStartTime: now,
        chunkInterval: parseInt(chunkIntervalSeconds) || 20, // Store the chunk interval
      };

      setSessionId(sid);
      dispatch(transcriptionActions.addSession(sessionData));
      addLog(
        `Session created: ${sid} (Battery: ${startBattery}%, Chunk Interval: ${sessionData.chunkInterval}s)`,
      );

      return {sessionId: sid.toString(), sessionData};
    } catch (error) {
      addLog(`Init error: ${String(error)}`);
      return null;
    }
  };

  const endSession = async (sid: number) => {
    try {
      const chunkCount = sentCount;
      const stopBattery = await updateBatteryLevel();

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        const endMessage = {
          type: 'end',
          session_id: sid,
        };
        wsRef.current.send(JSON.stringify(endMessage));
        addLog(`📤 Sent end message for session: ${sid}`);
      }

      dispatch(transcriptionActions.endSession({sessionId: sid, stopBattery}));
      addLog(`Session ended: ${sid} (Battery: ${stopBattery}%)`);

      disconnectWebSocket();
    } catch (error) {
      addLog(`End error: ${String(error)}`);
    }
  };

  const sendAudioFile = async (
    filePath: string,
    chunkId: number,
    sessionId: number,
  ) => {
    try {
      addLog(`Sending chunk ${chunkId}...`);

      // Check battery level before sending each chunk
      const wasStopped = await checkBatteryAndAutoStop();
      if (wasStopped) {
        addLog(`🛑 Session stopped due to low battery before sending chunk ${chunkId}`);
        return;
      }

      const base64Data = await RNFS.readFile(filePath, 'base64');

      if (!base64Data || base64Data.length === 0) {
        throw new Error('Audio file is empty or invalid');
      }

      await sendAudioViaWebSocket(base64Data, chunkId);

      setSentCount(prev => prev + 1);
      addLog(`✅ Sent chunk ${chunkId}`);

      // Don't update battery here - wait for server confirmation
      addLog(`📤 Chunk ${chunkId} sent, waiting for server confirmation...`);

      // Update session chunk information using the sessionId parameter
      const now = Date.now();

      // Only update basic chunk info here, battery will be updated after server ack
      dispatch(
        transcriptionActions.updateSessionChunk({
          sessionId: sessionId,
          chunkCount: chunkId,
          lastChunkTime: now,
          currentBattery: undefined, // Will be updated after server confirmation
        }),
      );

      addLog(
        `📊 Session ${sessionId} updated: Chunk ${chunkId}, waiting for server confirmation`,
      );

      // Force a re-render by updating local state
      setSentCount(chunkId);
    } catch (error) {
      addLog(`❌ Send failed chunk ${chunkId}: ${String(error)}`);
    } finally {
      // Always update battery and finalize chunk data regardless of success/failure
      try {
        addLog(`🔄 Finalizing chunk ${chunkId} data in finally block...`);
        
        // Get current battery level
        const currentBattery = await updateBatteryLevel();
        addLog(`🔋 Final battery level for chunk ${chunkId}: ${currentBattery}%`);
        
        // Check if battery is below threshold and stop session if needed
        if (currentBattery <= batteryThreshold) {
          addLog(`🔋⚠️ Battery level critical in finally block: ${currentBattery}% (threshold: ${batteryThreshold}%)`);
          addLog(`🛑 Auto-stopping session due to low battery in finally block`);
          
          // Immediately stop all running states
          setIsRunning(false);
          
          // Clear all intervals immediately
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          if (sendIntervalRef.current) {
            clearInterval(sendIntervalRef.current);
            sendIntervalRef.current = null;
          }
          
          // Stop the session and mark as inactive
          await stopSending();
          
          // End ALL active sessions due to low battery
          const activeSessions = sessions.filter(s => s.isActive);
          if (activeSessions.length > 0) {
            addLog(`🔋⚠️ Ending all ${activeSessions.length} active sessions due to low battery in finally block`);
            for (const session of activeSessions) {
              const stopBattery = await updateBatteryLevel();
              dispatch(
                transcriptionActions.endSession({
                  sessionId: session.id,
                  stopBattery,
                }),
              );
              addLog(`✅ Session ${session.id} ended due to low battery in finally block (${stopBattery}%)`);
            }
          }
          
          // Force update to ensure UI reflects the stopped state
          setElapsedMs(0);
          setSentCount(0);
          
          addLog(`🛑 All sessions stopped due to low battery in finally block`);
          return; // Exit early since session is stopped
        }
        
        const now = Date.now();
        
        // Update session with final battery level and chunk status
        const existingSession = sessions.find(s => s.id === sessionId);
        if (existingSession) {
          const updatedSession: SessionData = {
            ...existingSession,
            currentBattery: currentBattery,
            chunksSent: chunkId,
            lastChunkSendTime: now,
          };
          dispatch(transcriptionActions.updateSession(updatedSession));
        }
        
        // Update session chunk with final data
        dispatch(
          transcriptionActions.updateSessionChunk({
            sessionId: sessionId,
            chunkCount: chunkId,
            lastChunkTime: now,
            currentBattery: currentBattery,
          }),
        );
        
        addLog(`✅ Chunk ${chunkId} finalized with battery ${currentBattery}%`);
      } catch (finalizeError) {
        addLog(`⚠️ Error finalizing chunk ${chunkId}: ${String(finalizeError)}`);
      }
    }
  };

  const startSessionWithInterval = async () => {
    const interval = parseInt(chunkIntervalSeconds);
    if (isNaN(interval) || interval < 1) {
      Alert.alert('Invalid Interval', 'Please enter a valid number of seconds');
      return;
    }

    setShowChunkIntervalModal(false);

    if (!currentRecording) {
      Alert.alert('No Recording', 'Please record an audio file first');
      return;
    }

    await updateBatteryLevel();
    const initResult = await initSession();
    if (!initResult) return;

    const {sessionId: sid} = initResult;

    setIsRunning(true);
    setSentCount(0);
    chunkIdRef.current = 1;
    const localStart = Date.now();
    startRef.current = localStart;
    setElapsedMs(0);

    intervalRef.current = setInterval(() => {
      setElapsedMs(Date.now() - localStart);
    }, 1000);

    await sendAudioFile(currentRecording.uri, chunkIdRef.current, Number(sid));

    sendIntervalRef.current = setInterval(async () => {
      // Check battery before each interval
      const wasStopped = await checkBatteryAndAutoStop();
      if (wasStopped) {
        addLog(`🛑 Session stopped due to low battery during interval`);
        return;
      }
      
      chunkIdRef.current += 1;
      
      await sendAudioFile(
        currentRecording.uri,
        chunkIdRef.current,
        Number(sid),
      );
    }, interval * 1000);

    addLog(`Started sending chunks every ${interval} seconds`);
  };

  const stopSending = async () => {
    addLog('🛑 Stopping session...');
    setIsRunning(false);

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      addLog('⏱️ Elapsed time interval cleared');
    }

    if (sendIntervalRef.current) {
      clearInterval(sendIntervalRef.current);
      sendIntervalRef.current = null;
      addLog('📤 Send interval cleared');
    }

    // End the current active session if it exists
    if (currentSession && currentSession.isActive) {
      const stopBattery = await updateBatteryLevel();
      dispatch(
        transcriptionActions.endSession({
          sessionId: currentSession.id,
          stopBattery,
        }),
      );
      addLog(`✅ Session ${currentSession.id} marked as inactive (Battery: ${stopBattery}%)`);
    }

    // Also end session by ID if it exists
    if (sessionId) {
      await endSession(sessionId);
    }

    setSessionId(null);
    chunkIdRef.current = 1;
    setElapsedMs(0);
    setSentCount(0);
    addLog('✅ Session completely stopped');
  };

  // Update session timing in real-time
  useEffect(() => {
    if (currentSession && currentSession.isActive && isRunning) {
      const timer = setInterval(() => {
        // Double-check session is still active and running
        if (currentSession && currentSession.isActive && isRunning) {
          const now = Date.now();
          const totalDuration = now - currentSession.startTime;
          const totalTiming = formatHMS(totalDuration);
          const lastChunkSendTime = now;
          const updatedSession: SessionData = {
            ...currentSession,
            totalTiming,
            lastChunkSendTime,
          };
          dispatch(transcriptionActions.updateSession(updatedSession));
        }
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [currentSession, dispatch, isRunning]);

  // Clean up intervals on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (sendIntervalRef.current) clearInterval(sendIntervalRef.current);
      if (recordingIntervalRef.current)
        clearInterval(recordingIntervalRef.current);
      disconnectWebSocket();
    };
  }, []);

  // Battery level listener - prevents stale data by listening to system broadcasts
  useEffect(() => {
    let batterySubscription: any;
    let periodicRefreshInterval: any;

    const setupBatteryListener = async () => {
      try {
        // Get initial battery level
        const initialBattery = await getBatteryLevel();
        addLog(`🔋 Initial battery level: ${initialBattery}%`);

        // Set up listener for real-time battery updates
        batterySubscription = DeviceEventEmitter.addListener(
          'BatteryLevelChanged',
          (level: number) => {
            if (typeof level === 'number' && level >= 0 && level <= 100) {
              setCurrentBatteryLevel(level);
              addLog(`🔋 Listener update: ${level}%`);
            }
          }
        );

        // Set up periodic refresh every 30 seconds as a fallback
        periodicRefreshInterval = setInterval(async () => {
          try {
            const currentLevel = await getBatteryLevel();
            // Only log if there's a significant change to avoid spam
            if (currentBatteryLevel !== null && Math.abs(currentLevel - currentBatteryLevel) > 2) {
              addLog(`🔋 Periodic refresh detected change: ${currentBatteryLevel}% → ${currentLevel}%`);
            }
            
            // Check for auto-stop during active sessions
            if (isRunning && currentLevel <= batteryThreshold) {
              addLog(`🔋⚠️ Periodic check detected low battery: ${currentLevel}%`);
              await checkBatteryAndAutoStop();
            }
            
            // Also check for any active sessions even if not currently running
            const activeSessions = sessions.filter(s => s.isActive);
            if (activeSessions.length > 0 && currentLevel <= batteryThreshold) {
              addLog(`🔋⚠️ Periodic check: Ending all ${activeSessions.length} active sessions due to low battery`);
              for (const session of activeSessions) {
                const stopBattery = await updateBatteryLevel();
                dispatch(
                  transcriptionActions.endSession({
                    sessionId: session.id,
                    stopBattery,
                  }),
                );
                addLog(`✅ Session ${session.id} ended due to low battery (${stopBattery}%)`);
              }
            }
          } catch (error) {
            addLog(`⚠️ Periodic battery refresh failed: ${String(error)}`);
          }
        }, 30000); // 30 seconds

        addLog('✅ Battery listener and periodic refresh initialized');
      } catch (error) {
        addLog(`⚠️ Failed to setup battery listener: ${String(error)}`);
      }
    };

    setupBatteryListener();

    // Cleanup listener on unmount
    return () => {
      if (batterySubscription) {
        batterySubscription.remove();
        addLog('🧹 Battery listener cleaned up');
      }
      if (periodicRefreshInterval) {
        clearInterval(periodicRefreshInterval);
        addLog('🧹 Periodic battery refresh cleaned up');
      }
    };
  }, [currentBatteryLevel, isRunning, batteryThreshold, sessions, dispatch]);

  // Render item for session list
  const renderSessionItem = ({item}: {item: SessionData}) => (
    <View
      style={{
        backgroundColor: 'white',
        padding: 15,
        borderRadius: 8,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: '#e9ecef',
      }}>
      <Text
        style={{
          fontSize: 18,
          fontWeight: 'bold',
          color: '#007bff',
          marginBottom: 8,
        }}>
        ID: {item.id}
      </Text>
      <Text style={{fontSize: 14, color: '#333', marginBottom: 5}}>
        Status: {item.isActive ? '🟢 Active' : '🔴 Inactive'}
      </Text>
      <Text style={{fontSize: 14, color: '#333', marginBottom: 5}}>
        Chunks: {item.chunksSent}
      </Text>
      <Text style={{fontSize: 14, color: '#333', marginBottom: 5}}>
        Battery: {item.startBattery}% →{' '}
        {item.currentBattery !== undefined ? `${item.currentBattery}%` : 'Finalizing...'}
      </Text>
      <Text style={{fontSize: 14, color: '#333', marginBottom: 5}}>
        Duration: {item.totalTiming}
      </Text>
      <Text style={{fontSize: 14, color: '#333', marginBottom: 5}}>
        Chunk Interval: {item.chunkInterval || 'N/A'}s
      </Text>
      <Text style={{fontSize: 14, color: '#333', marginBottom: 5}}>
        Started: {formatDate(item.startTime)}
      </Text>
      <Text style={{fontSize: 14, color: '#333', marginBottom: 5}}>
        Last chunk: {formatDate(item.lastChunkSendTime)}
      </Text>
    </View>
  );

  // Group sessions by active/inactive
  const sessionSections = [
    {
      title: 'Active Session',
      data: sessions.filter(s => s.isActive),
    },
    {
      title: 'Past Sessions',
      data: sessions.filter(s => !s.isActive).sort((a, b) => b.id - a.id), // Sort by ID descending (newest first)
    },
  ];

  // Get the current active session (should be only one)
  const activeSession = sessions.find(s => s.isActive);

  return (
    <ScrollView style={{flex: 1, padding: 20, backgroundColor: '#f5f5f5'}}>
      <Text
        style={{
          fontSize: 24,
          fontWeight: 'bold',
          marginBottom: 20,
          textAlign: 'center',
          color: '#333',
        }}>
        Audio Recording & Testing
      </Text>

      {/* Recording Controls */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-around',
          marginBottom: 20,
        }}>
        <TouchableOpacity
          style={{
            backgroundColor: isRecording ? '#dc3545' : '#28a745',
            padding: 15,
            borderRadius: 8,
            minWidth: 150,
            alignItems: 'center',
            opacity: !audioRecordInitialized ? 0.6 : 1,
          }}
          onPress={isRecording ? stopRecording : startRecording}
          disabled={!audioRecordInitialized}>
          <Text style={{color: 'white', fontSize: 16, fontWeight: 'bold'}}>
            {isRecording ? '⏹️ Stop Recording' : '🎤 Start Recording'}
          </Text>
        </TouchableOpacity>

        {/* Battery Refresh Button */}
        <TouchableOpacity
          style={{
            backgroundColor: '#17a2b8',
            padding: 15,
            borderRadius: 8,
            minWidth: 120,
            alignItems: 'center',
          }}
          onPress={async () => {
            addLog('🔄 Manual battery refresh requested');
            const newLevel = await updateBatteryLevel();
            addLog(`🔋 Manual refresh result: ${newLevel}%`);
          }}>
          <Text style={{color: 'white', fontSize: 16, fontWeight: 'bold'}}>
            🔋 Refresh Battery
          </Text>
        </TouchableOpacity>
      </View>

      {/* Battery Status Display */}
      <View
        style={{
          backgroundColor: '#e8f5e8',
          padding: 15,
          borderRadius: 8,
          marginBottom: 20,
          alignItems: 'center',
        }}>
        <Text style={{fontSize: 16, color: '#333', marginBottom: 5}}>
          🔋 Current Battery: {currentBatteryLevel !== null ? `${currentBatteryLevel}%` : 'Loading...'}
        </Text>
        <Text style={{fontSize: 14, color: '#333', marginBottom: 5}}>
          ⚠️ Auto-stop threshold: {batteryThreshold}%
        </Text>
        <Text style={{fontSize: 12, color: '#666', fontStyle: 'italic'}}>
          Updates with each chunk + system broadcasts + periodic refresh every 30s
        </Text>
      </View>

      {/* Battery Threshold Configuration */}
      <View
        style={{
          backgroundColor: '#fff3cd',
          padding: 15,
          borderRadius: 8,
          marginBottom: 20,
          borderWidth: 1,
          borderColor: '#ffeaa7',
        }}>
        <Text style={{fontSize: 16, color: '#333', marginBottom: 10, fontWeight: 'bold'}}>
          🔋 Battery Auto-Stop Settings
        </Text>
        <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}}>
          <Text style={{fontSize: 14, color: '#333', flex: 1}}>
            Stop sending when battery reaches:
          </Text>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            <TouchableOpacity
              style={{
                backgroundColor: '#6c757d',
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 4,
                marginRight: 5,
              }}
              onPress={() => setBatteryThreshold(Math.max(1, batteryThreshold - 1))}>
              <Text style={{color: 'white', fontSize: 12}}>-</Text>
            </TouchableOpacity>
            <Text style={{fontSize: 16, color: '#333', marginHorizontal: 10, minWidth: 30, textAlign: 'center'}}>
              {batteryThreshold}%
            </Text>
            <TouchableOpacity
              style={{
                backgroundColor: '#6c757d',
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 4,
                marginLeft: 5,
              }}
              onPress={() => setBatteryThreshold(Math.min(100, batteryThreshold + 1))}>
              <Text style={{color: 'white', fontSize: 12}}>+</Text>
            </TouchableOpacity>
          </View>
        </View>
        <Text style={{fontSize: 12, color: '#666', marginTop: 5, fontStyle: 'italic'}}>
          Session will automatically stop when battery drops to {batteryThreshold}% or below
        </Text>
      </View>

      {!currentRecording && (
        <Text style={{color: '#888', fontStyle: 'italic', textAlign: 'center'}}>
          Please record an audio file first
        </Text>
      )}

      {currentRecording && (
        <View
          style={{
            backgroundColor: 'white',
            borderRadius: 16,
            padding: 24,
            width: '85%',
            alignSelf: 'center',
            marginBottom: 20,
            shadowColor: '#000',
            shadowOffset: {width: 0, height: 4},
            shadowOpacity: 0.15,
            shadowRadius: 6,
            elevation: 6,
          }}>
          {/* Title */}
          <Text
            style={{
              fontSize: 20,
              fontWeight: '700',
              textAlign: 'center',
              marginBottom: 8,
              color: '#222',
            }}>
            Set Chunk Interval
          </Text>

          {/* Subtitle */}
          <Text
            style={{
              fontSize: 15,
              color: '#666',
              textAlign: 'center',
              marginBottom: 20,
            }}>
            Seconds between sending each audio chunk
          </Text>

          {/* Input */}
          <TextInput
            style={{
              borderWidth: 1,
              borderColor: '#ccc',
              borderRadius: 10,
              paddingVertical: 12,
              paddingHorizontal: 16,
              fontSize: 16,
              marginBottom: 24,
              textAlign: 'center',
              backgroundColor: '#f9f9f9',
            }}
            value={chunkIntervalSeconds}
            onChangeText={setChunkIntervalSeconds}
            placeholder="Enter seconds (e.g., 20)"
            placeholderTextColor="#aaa"
            keyboardType="numeric"
            autoFocus
          />

          {/* Buttons */}
          <View style={{ justifyContent: 'space-between'}}>
          
            {/* Start */}
            <TouchableOpacity
              style={{
                backgroundColor: isRunning ? '#dc3545' : '#007bff',
                padding: 15,
                borderRadius: 8,
                minWidth: 150,
                alignItems: 'center',
              }}
              onPress={
                isRunning ? stopSending : () => startSessionWithInterval()
              }>
              <Text style={{color: 'white', fontSize: 16, fontWeight: 'bold'}}>
                {isRunning ? '⏹️ Stop Sending' : '▶️ Start Sending'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Recording Status */}
      <View
        style={{
          backgroundColor: '#f8f9fa',
          padding: 15,
          borderRadius: 8,
          marginBottom: 20,
          alignItems: 'center',
        }}>
        <Text style={{fontSize: 16, color: '#333', marginBottom: 5}}>
          {isRecording
            ? `Recording: ${formatDuration(recordingDuration)}`
            : 'Not recording'}
        </Text>
        {currentRecording && (
          <Text style={{fontSize: 16, color: '#333', marginBottom: 5}}>
            Selected: {currentRecording.name} (
            {formatHMS(currentRecording.duration)})
          </Text>
        )}
      </View>

      {/* Timing display */}
      {isRunning && (
        <View
          style={{
            backgroundColor: '#e3f2fd',
            padding: 15,
            borderRadius: 8,
            marginBottom: 20,
            alignItems: 'center',
          }}>
          <Text style={{fontSize: 16, color: '#1976d2', marginBottom: 5}}>
            Elapsed: {formatHMS(elapsedMs)}
          </Text>
          <Text style={{fontSize: 16, color: '#1976d2', marginBottom: 5}}>
            Sent: {sentCount} chunks
          </Text>
          <Text style={{fontSize: 14, color: '#666', fontStyle: 'italic'}}>
            Battery updates in finally block (always happens)
          </Text>
        </View>
      )}

      {/* Sessions List */}
      <View style={{marginBottom: 20}}>
        <Text
          style={{
            fontSize: 20,
            fontWeight: 'bold',
            marginBottom: 15,
            color: '#333',
          }}>
          All Sessions
        </Text>

        <SectionList
          sections={sessionSections}
          key={`sessions-${sessions.length}-${sessions.reduce(
            (sum, s) => sum + s.chunksSent,
            0,
          )}`}
          keyExtractor={item => item.id.toString()}
          renderItem={renderSessionItem}
          renderSectionHeader={({section: {title, data}}) => (
            <Text
              style={{
                fontSize: 18,
                fontWeight: 'bold',
                backgroundColor: '#e9ecef',
                padding: 10,
                color: '#495057',
              }}>
              {title} ({data.length})
            </Text>
          )}
          ListEmptyComponent={
            <Text
              style={{
                color: '#888',
                fontStyle: 'italic',
                textAlign: 'center',
                marginTop: 20,
              }}>
              No sessions yet
            </Text>
          }
        />
      </View>

      {/* Chunk Interval Modal */}
      {/* <Modal
        visible={showChunkIntervalModal}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowChunkIntervalModal(false)}> */}

      <TouchableOpacity
        style={{
          backgroundColor: '#dc3545',
          padding: 12,
          borderRadius: 8,
          marginBottom: 20,
          alignItems: 'center',
        }}
        onPress={() => {
          Alert.alert(
            'Clear All Sessions',
            'Are you sure you want to clear all sessions? This will remove all active and past sessions.',
            [
              {text: 'Cancel', style: 'cancel'},
              {
                text: 'Clear All',
                style: 'destructive',
                onPress: () => {
                  dispatch(transcriptionActions.clearSessions());
                  setSessionId(null);
                  setSentCount(0);
                  setProcessedCount(0);
                  setElapsedMs(0);
                  chunkIdRef.current = 1;
                  addLog('🗑️ All sessions cleared');
                },
              },
            ],
          );
        }}>
        <Text style={{color: 'white', fontWeight: 'bold', fontSize: 14}}>
          Clear All Sessions
        </Text>
      </TouchableOpacity>
      {/* Activity Log */}
      <Text style={{
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: 15,
        color: '#333',
      }}>
        Activity Log
      </Text>
      <ScrollView style={{
        backgroundColor: '#f8f9fa',
        padding: 15,
        borderRadius: 8,
        maxHeight: 200,
        borderWidth: 1,
        borderColor: '#e9ecef',
      }}>
        {logs.map((log, index) => (
          <Text key={index} style={{
            fontSize: 12,
            color: '#495057',
            marginBottom: 2,
            fontFamily: 'monospace',
          }}>
            {log}
          </Text>
        ))}
      </ScrollView>
    </ScrollView>
  );
}

// All styles are now inline - no external StyleSheet needed
