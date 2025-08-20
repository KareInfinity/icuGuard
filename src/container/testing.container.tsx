import * as React from 'react';
import {useEffect, useState, useRef} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  NativeModules,
  TextInput,
  Modal,
  FlatList,
  SectionList,
  Platform,
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
      const startBattery = await getBatteryLevel();

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
      addLog(`Session created: ${sid} (Battery: ${startBattery}%, Chunk Interval: ${sessionData.chunkInterval}s)`);

      return {sessionId: sid.toString(), sessionData};
    } catch (error) {
      addLog(`Init error: ${String(error)}`);
      return null;
    }
  };

  const endSession = async (sid: number) => {
    try {
      const chunkCount = sentCount;
      const stopBattery = await getBatteryLevel();

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

      const base64Data = await RNFS.readFile(filePath, 'base64');

      if (!base64Data || base64Data.length === 0) {
        throw new Error('Audio file is empty or invalid');
      }

      await sendAudioViaWebSocket(base64Data, chunkId);

      setSentCount(prev => prev + 1);
      addLog(`✅ Sent chunk ${chunkId}`);

      // Get current battery level for this chunk
      const currentBattery = await getBatteryLevel();
      addLog(`🔋 Battery at chunk ${chunkId}: ${currentBattery}%`);

      // Update session chunk information using the sessionId parameter
      const now = Date.now();
      
      dispatch(
        transcriptionActions.updateSessionChunk({
          sessionId: sessionId,
          chunkCount: chunkId,
          lastChunkTime: now,
          currentBattery: currentBattery, // Add current battery level
        }),
      );
      
      addLog(`📊 Session ${sessionId} updated: Chunk ${chunkId}, Battery ${currentBattery}%`);
      
      // Force a re-render by updating local state
      setSentCount(chunkId);
    } catch (error) {
      addLog(`❌ Send failed chunk ${chunkId}: ${String(error)}`);
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

    await getBatteryLevel();
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
      chunkIdRef.current += 1;
      await sendAudioFile(
        currentRecording.uri,
        chunkIdRef.current,
        Number(sid),
      );
      await getBatteryLevel();
    }, interval * 1000);

    addLog(`Started sending chunks every ${interval} seconds`);
  };

  const stopSending = async () => {
    setIsRunning(false);

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (sendIntervalRef.current) {
      clearInterval(sendIntervalRef.current);
      sendIntervalRef.current = null;
    }

    if (sessionId) {
      await endSession(sessionId);
    }

    // Also end the current active session if it exists
    if (currentSession && currentSession.isActive) {
      const stopBattery = await getBatteryLevel();
      dispatch(
        transcriptionActions.endSession({
          sessionId: currentSession.id,
          stopBattery,
        }),
      );
      addLog(`Session ${currentSession.id} ended when stopping`);
    }

    setSessionId(null);
    chunkIdRef.current = 1;
    addLog('Stopped sending chunks');
  };

  // Update session timing in real-time
  useEffect(() => {
    if (currentSession && currentSession.isActive) {
      const timer = setInterval(() => {
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
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [currentSession, dispatch]);

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

  // Render item for session list
  const renderSessionItem = ({item}: {item: SessionData}) => (
    <View style={styles.sessionItem}>
      <Text style={styles.sessionItemId}>ID: {item.id}</Text>
      <Text style={styles.sessionItemText}>
        Status: {item.isActive ? '🟢 Active' : '🔴 Inactive'}
      </Text>
      <Text style={styles.sessionItemText}>Chunks: {item.chunksSent}</Text>
      <Text style={styles.sessionItemText}>
        Battery: {item.startBattery}% → {item.currentBattery || item.stopBattery || 'N/A'}%
      </Text>
      <Text style={styles.sessionItemText}>Duration: {item.totalTiming}</Text>
      <Text style={styles.sessionItemText}>
        Chunk Interval: {item.chunkInterval || 'N/A'}s
      </Text>
      <Text style={styles.sessionItemText}>
        Started: {formatDate(item.startTime)}
      </Text>
      <Text style={styles.sessionItemText}>
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
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Audio Recording & Testing</Text>


      {/* Recording Controls */}
      <View style={styles.recordingContainer}>
        <TouchableOpacity
          style={[
            styles.button,
            isRecording ? styles.stopButton : styles.recordButton,
            !audioRecordInitialized && styles.disabledButton,
          ]}
          onPress={isRecording ? stopRecording : startRecording}
          disabled={!audioRecordInitialized}>
          <Text style={styles.buttonText}>
            {isRecording ? '⏹️ Stop Recording' : '🎤 Start Recording'}
          </Text>
        </TouchableOpacity>

     
        {currentRecording ? (
          <TouchableOpacity
            style={[
              styles.button,
              isRunning ? styles.stopButton : styles.startButton,
            ]}
            onPress={
              isRunning ? stopSending : () => setShowChunkIntervalModal(true)
            }>
            <Text style={styles.buttonText}>
              {isRunning ? '⏹️ Stop Sending' : '▶️ Start Sending'}
            </Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.noFileText}>
            Please record an audio file first
          </Text>
        )}
      </View>

      {/* Recording Status */}
      <View style={styles.statusContainer}>
        <Text style={styles.statusText}>
          {isRecording
            ? `Recording: ${formatDuration(recordingDuration)}`
            : 'Not recording'}
        </Text>
        {currentRecording && (
          <Text style={styles.statusText}>
            Selected: {currentRecording.name} (
            {formatHMS(currentRecording.duration)})
          </Text>
        )}
      </View>

      {/* Timing display */}
      {isRunning && (
        <View style={styles.timingContainer}>
          <Text style={styles.timingText}>Elapsed: {formatHMS(elapsedMs)}</Text>
          <Text style={styles.timingText}>Sent: {sentCount} chunks</Text>
        </View>
      )}

      {/* Sessions List */}

      <View style={styles.sessionsContainer}>
        <Text style={styles.sectionTitle}>All Sessions</Text>

        <SectionList
          sections={sessionSections}
          key={`sessions-${sessions.length}-${sessions.reduce(
            (sum, s) => sum + s.chunksSent,
            0,
          )}`}
          keyExtractor={item => item.id.toString()}
          renderItem={renderSessionItem}
          renderSectionHeader={({section: {title, data}}) => (
            <Text style={styles.sectionHeader}>
              {title} ({data.length})
            </Text>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No sessions yet</Text>
          }
        />
      </View>

      {/* Chunk Interval Modal */}
      <Modal
        visible={showChunkIntervalModal}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowChunkIntervalModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Set Chunk Interval</Text>
            <Text style={styles.modalSubtitle}>
              Seconds between sending each audio chunk:
            </Text>
            <TextInput
              style={styles.input}
              value={chunkIntervalSeconds}
              onChangeText={setChunkIntervalSeconds}
              placeholder="Enter seconds (e.g., 20)"
              keyboardType="numeric"
              autoFocus={true}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.button, styles.cancelButton]}
                onPress={() => setShowChunkIntervalModal(false)}>
                <Text style={styles.buttonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.confirmButton]}
                onPress={startSessionWithInterval}>
                <Text style={styles.buttonText}>Start Session</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <TouchableOpacity
        style={styles.clearSessionsButton}
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
        <Text style={styles.clearSessionsButtonText}>Clear All Sessions</Text>
      </TouchableOpacity>
      {/* Activity Log */}
      {/* <Text style={styles.logTitle}>Activity Log</Text>
      <ScrollView style={styles.logContainer}>
        {logs.map((log, index) => (
          <Text key={index} style={styles.logText}>
            {log}
          </Text>
        ))}
      </ScrollView> */}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
    color: '#333',
  },
  toggleButton: {
    backgroundColor: '#6c757d',
    padding: 10,
    borderRadius: 5,
    marginBottom: 15,
    alignItems: 'center',
  },
  toggleButtonText: {
    color: 'white',
    fontWeight: 'bold',
  },
  sessionsContainer: {
    marginBottom: 20,
    maxHeight: 300,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#333',
  },
  sectionHeader: {
    fontSize: 16,
    fontWeight: 'bold',
    backgroundColor: '#f0f0f0',
    padding: 10,
    color: '#333',
  },
  sessionItem: {
    backgroundColor: '#f8f9fa',
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#dee2e6',
  },
  sessionItemId: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#495057',
    marginBottom: 5,
  },
  sessionItemText: {
    fontSize: 12,
    color: '#6c757d',
    marginBottom: 2,
  },
  emptyText: {
    textAlign: 'center',
    padding: 20,
    color: '#6c757d',
    fontStyle: 'italic',
  },
  recordingContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 20,
  },
  sendContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  statusContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  statusText: {
    fontSize: 14,
    color: '#666',
    marginBottom: 5,
  },
  timingContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  timingText: {
    fontSize: 14,
    color: '#333',
    marginBottom: 5,
  },
  button: {
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderRadius: 5,
    minWidth: 120,
    alignItems: 'center',
  },
  buttonText: {
    color: 'white',
    fontWeight: 'bold',
  },
  recordButton: {
    backgroundColor: '#4CAF50',
  },
  stopButton: {
    backgroundColor: '#F44336',
  },
  startButton: {
    backgroundColor: '#2196F3',
  },
  deleteButton: {
    backgroundColor: '#FF9800',
  },
  cancelButton: {
    backgroundColor: '#9E9E9E',
  },
  confirmButton: {
    backgroundColor: '#4CAF50',
  },
  noFileText: {
    color: '#888',
    fontStyle: 'italic',
  },
  sessionInfo: {
    backgroundColor: '#e8f5e8',
    padding: 15,
    borderRadius: 8,
    marginBottom: 20,
    borderLeftWidth: 4,
    borderLeftColor: '#4CAF50',
  },
  sessionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#2e7d32',
    marginBottom: 10,
  },
  sessionText: {
    fontSize: 14,
    color: '#333',
    marginBottom: 5,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: 'white',
    borderRadius: 10,
    padding: 20,
    width: '80%',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 10,
  },
  modalSubtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginBottom: 20,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 5,
    padding: 10,
    fontSize: 16,
    marginBottom: 20,
    textAlign: 'center',
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  logTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  logContainer: {
    height: 200,
    backgroundColor: '#f5f5f5',
    padding: 10,
    borderRadius: 5,
  },
  logText: {
    fontSize: 12,
    color: '#333',
    marginBottom: 4,
    fontFamily: 'monospace',
  },
  activeSessionStatus: {
    backgroundColor: '#e8f5e8',
    padding: 15,
    borderRadius: 8,
    marginBottom: 15,
    borderLeftWidth: 4,
    borderLeftColor: '#4CAF50',
  },
  activeSessionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#2e7d32',
    marginBottom: 10,
  },
  activeSessionText: {
    fontSize: 14,
    color: '#333',
    marginBottom: 5,
  },
  noActiveSession: {
    backgroundColor: '#f5f5f5',
    padding: 15,
    borderRadius: 8,
    marginBottom: 15,
    alignItems: 'center',
  },
  noActiveSessionText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 5,
  },
  noActiveSessionSubtext: {
    fontSize: 14,
    color: '#999',
    fontStyle: 'italic',
  },
  clearSessionsButton: {
    backgroundColor: '#dc3545',
    padding: 12,
    borderRadius: 8,
    marginBottom: 20,
    alignItems: 'center',
  },
  clearSessionsButtonText: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 14,
  },
  batteryInfoButton: {
    backgroundColor: '#4CAF50',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
    alignItems: 'center',
  },
  batteryInfoButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
  },
  audioStatusContainer: {
    backgroundColor: '#f8f9fa',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
    alignItems: 'center',
  },
  audioStatusText: {
    fontSize: 14,
    color: '#333',
    marginBottom: 8,
    fontWeight: '500',
  },
  manualInitButton: {
    backgroundColor: '#007bff',
    padding: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  manualInitButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
  },
  disabledButton: {
    backgroundColor: '#ccc',
    opacity: 0.6,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginTop: 8,
  },
  permissionButton: {
    backgroundColor: '#17a2b8',
    padding: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  permissionButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
  },
  forceStopButton: {
    backgroundColor: '#dc3545',
    marginTop: 8,
  },
});
