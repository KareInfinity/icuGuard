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
} from 'react-native';
import {BottomTabScreenProps} from '@react-navigation/bottom-tabs';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {CompositeScreenProps} from '@react-navigation/native';
import {HomeModuleParamList, AppModuleParamList} from '../app.navigation';
import RNFS from 'react-native-fs';
import { useSelector } from 'react-redux';
import { selectUsername } from '../redux/user.redux';
import { selectCustomServerUrl } from '../redux/server.redux';

type HomeContainerProps = CompositeScreenProps<
  BottomTabScreenProps<HomeModuleParamList, 'home'>,
  NativeStackScreenProps<AppModuleParamList>
>;

export function HomeContainer(props: HomeContainerProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [wavFiles, setWavFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [newFilesDetected, setNewFilesDetected] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const chunkIdRef = useRef<number>(1);
  const messagesPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [sentCount, setSentCount] = useState<number>(0);
  const [processedCount, setProcessedCount] = useState<number>(0);
  const [startTimestampMs, setStartTimestampMs] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [lastDurationHours, setLastDurationHours] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);

  // Load WAV files on mount
  useEffect(() => {
    const listWavFiles = async () => {
      try {
        // Use the same path as recording container
        const path = RNFS.DocumentDirectoryPath;
        console.log('📁 Looking for WAV files in:', path);
        
        const files = await RNFS.readDir(path);
        const wavs = files.filter(file => file.name.endsWith('.wav'));
        const filePaths = wavs.map(file => file.path);
        
        console.log('📁 Found WAV files:', wavs.map(f => f.name));
        
        // Check if new files were detected
        if (wavFiles.length > 0 && filePaths.length > wavFiles.length) {
          setNewFilesDetected(true);
          addLog(`New WAV files detected! Total: ${filePaths.length}`);
        }
        
        setWavFiles(filePaths);
      } catch (err) {
        console.error('❌ Error listing WAV files:', err);
      }
    };

    listWavFiles();
    
    // Set up periodic refresh to catch new recordings
    const refreshInterval = setInterval(listWavFiles, 5000); // Refresh every 5 seconds
    
    return () => clearInterval(refreshInterval);
  }, [wavFiles.length]); // Add wavFiles.length as dependency to detect changes
  const username = useSelector(selectUsername);

  const addLog = (message: string) => {
    const timestamp = new Date().toISOString().substr(11, 8);
    const logMessage = `[${timestamp}] ${message}`;
    setLogs(prev => [logMessage, ...prev].slice(0, 100));
    console.log(logMessage);
  };

  const customServerUrl = useSelector(selectCustomServerUrl);
  
  const initSession = async (): Promise<{ sessionId: string; sessionCount: number } | null> => {
    try {
      if (!customServerUrl) {
        addLog('Server URL not set');
        return null;
      }
      if (!username) {
        addLog('Username not set');
        return null;
      }
      const formData = new FormData();
      formData.append('type', 'init');
      formData.append('username', username);
      const resp = await fetch(`http://${customServerUrl}/transcribe`, {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();
      if (!resp.ok) {
        addLog(`Init failed: ${data?.error || 'unknown error'}`);
        return null;
      }
      const sid = data.session_id as string;
      const sc = data.session_count as number;
      setSessionId(sid);
      setSessionCount(sc);
      return { sessionId: sid, sessionCount: sc };
    } catch (e: any) {
      addLog(`Init error: ${e?.message || String(e)}`);
      return null;
    }
  };

  const endSession = async (sid: string) => {
    try {
      const formData = new FormData();
      formData.append('type', 'end');
      formData.append('session_id', sid);
      const resp = await fetch(`http://${customServerUrl}/transcribe`, {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();
      if (!resp.ok) {
        addLog(`End failed: ${data?.error || 'unknown error'}`);
      }
    } catch (e: any) {
      addLog(`End error: ${e?.message || String(e)}`);
    }
  };

  const fetchMessages = async (sid: string): Promise<number> => {
    try {
      const formData = new FormData();
      formData.append('type', 'get_messages');
      formData.append('session_id', sid);
      const resp = await fetch(`http://${customServerUrl}/transcribe`, {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();
      if (resp.ok && Array.isArray(data?.messages)) {
        return data.messages.length as number;
      }
    } catch (e: any) {
      // silent
    }
    return 0;
  };

  const logBatteryStatus = async (prefix: string = 'Battery') => {
    try {
      // Avoid importing if native module not linked yet
      if (!(NativeModules as any)?.RNDeviceInfo) {
        return;
      }
      // Load device-info lazily only when native module exists
      const DeviceInfo = (await import('react-native-device-info')).default as any;
      if (!DeviceInfo || !DeviceInfo.getBatteryLevel) {
        return;
      }
      const level = await DeviceInfo.getBatteryLevel();
      const isCharging = await DeviceInfo.isBatteryCharging();
      const pct = Math.round(level * 100);
      const line = `${prefix}: ${pct}% ${isCharging ? '(charging)' : '(not charging)'}`;
      const path = `${RNFS.DocumentDirectoryPath}/battery_log.txt`;
      const timestamp = new Date().toISOString();
      await RNFS.appendFile(path, `${timestamp} - ${line}\n`, 'utf8');
    } catch (e: any) {
      // silent
    }
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
  const sendAudioFile = async (
    filePath: string,
    chunkId: number,
    sessionId: string,
  ) => {
  
    try {

      // Read as base64
      const fileContent = await RNFS.readFile(filePath, 'base64');

      // No need to convert base64 to Blob in React Native; use the file URI directly

      // Construct FormData
      const formData = new FormData();
      formData.append('type', 'audio');
      // username is not required by server for audio step
      formData.append('session_id', sessionId);
      formData.append('chunk_id', chunkId.toString());
      formData.append('audio', {
        uri: `file://${filePath}`,
        name: `chunk_${chunkId}.wav`,
        type: 'audio/wav',
      });

      const response = await fetch(`http://${customServerUrl}/transcribe`, {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (response.ok) {
        setSentCount(prev => prev + 1);
        addLog(`Sent chunk ${chunkId}`);
      } else {
        addLog(`Send failed chunk ${chunkId}: ${result.error}`);
      }
    } catch (error) {
      addLog(`Send failed chunk ${chunkId}: ${String(error)}`);
    }
  };
  
  const sendSelectedOnce = async () => {
    if (!selectedFile) {
      Alert.alert('No File Selected', 'Please select a WAV file first');
      return;
    }
    if (!customServerUrl) {
      Alert.alert('Server URL missing', 'Set the server URL first');
      return;
    }
    setIsRunning(true);
    try {
      let sid = sessionId;
      if (!sid) {
        const init = await initSession();
        if (!init) {
          setIsRunning(false);
          return;
        }
        sid = init.sessionId;
      }
      const chunkId = 1;
      await sendAudioFile(selectedFile, chunkId, sid!);

      // Begin short polling for messages for a few seconds
      let polls = 0;
      const maxPolls = 15; // ~15 seconds
      const pollInterval = setInterval(async () => {
        polls += 1;
        await fetchMessages(sid!);
        if (polls >= maxPolls) {
          clearInterval(pollInterval);
        }
      }, 1000);

      // End the session in background after upload
      endSession(sid!);
    } finally {
      // Keep running state simple; user can re-run as needed
      setTimeout(() => setIsRunning(false), 500);
    }
  };
  // Start/stop sending the selected file in a loop (every 20s)
  const toggleFileSending = async () => {
    if (!selectedFile) {
      Alert.alert('No File Selected', 'Please select a WAV file first');
      return;
    }
    if (!customServerUrl) {
      Alert.alert('Server URL missing', 'Set the server URL first');
      return;
    }

    if (!isRunning) {
      await logBatteryStatus('Start');

      // Ensure session exists
      let sid = sessionId;
      if (!sid) {
        const init = await initSession();
        if (!init) return;
        sid = init.sessionId;
      }

      // Start
      setIsRunning(true);
      setSentCount(0);
      setProcessedCount(0);
      chunkIdRef.current = 1;
      const localStart = Date.now();
      startRef.current = localStart;
      setStartTimestampMs(localStart);
      setElapsedMs(0);
      // 1s UI timer
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => {
        const base = startRef.current ?? localStart;
        setElapsedMs(Date.now() - base);
      }, 1000);

      // Send immediately first time
      await sendAudioFile(selectedFile, chunkIdRef.current, sid);
      await logBatteryStatus('After send');

      // Start polling processed messages every 2 seconds
      messagesPollRef.current = setInterval(async () => {
        const got = await fetchMessages(sid!);
        if (got > 0) setProcessedCount(prev => prev + got);
      }, 2000);

      // Then set up interval for continuous sending
      sendIntervalRef.current = setInterval(async () => {
        if (!sid) return;
        chunkIdRef.current += 1;
        await sendAudioFile(selectedFile, chunkIdRef.current, sid);
        await logBatteryStatus('After send');
      }, 20000); // every 20 seconds
    } else {
      await logBatteryStatus('Stop');
      setIsRunning(false);
      // compute total hours
      const endMs = Date.now();
      const base = startRef.current ?? startTimestampMs ?? endMs;
      const durationMs = endMs - base;
      setLastDurationHours(+((durationMs || 0) / 3600000).toFixed(2));
      setStartTimestampMs(null);
      startRef.current = null;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (sendIntervalRef.current) {
        clearInterval(sendIntervalRef.current);
        sendIntervalRef.current = null;
      }
      if (messagesPollRef.current) {
        clearInterval(messagesPollRef.current);
        messagesPollRef.current = null;
      }
      if (sessionId) {
        endSession(sessionId);
      }
      setSessionId(null);
      setSessionCount(null);
      chunkIdRef.current = 1;
    }
  };

  // Text chunk rotation logic
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (sendIntervalRef.current) clearInterval(sendIntervalRef.current);
      if (messagesPollRef.current) clearInterval(messagesPollRef.current);
    };
  }, [isRunning]);

  return (
    <View style={{flex: 1, padding: 20}}>
      <Text style={{fontSize: 16, fontWeight: 'bold', marginTop: 20}}>
        Available WAV Files:
      </Text>

      {/* Manual Refresh Button */}
      <TouchableOpacity
        style={{
          backgroundColor: '#007bff',
          paddingHorizontal: 15,
          paddingVertical: 8,
          borderRadius: 6,
          alignSelf: 'flex-start',
          marginBottom: 10,
        }}
        onPress={() => {
          const listWavFiles = async () => {
            try {
              const path = RNFS.DocumentDirectoryPath;
              console.log('📁 Manually refreshing WAV files from:', path);
              
              const files = await RNFS.readDir(path);
              const wavs = files.filter(file => file.name.endsWith('.wav'));
              const filePaths = wavs.map(file => file.path);
              
              console.log('📁 Found WAV files:', wavs.map(f => f.name));
              setWavFiles(filePaths);
            } catch (err) {
              console.error('❌ Error refreshing WAV files:', err);
            }
          };
          listWavFiles();
        }}
      >
        <Text style={{color: 'white', fontWeight: '600'}}>🔄 Refresh Files</Text>
      </TouchableOpacity>

      {/* New Files Notification */}
      {newFilesDetected && (
        <View style={{
          backgroundColor: '#d4edda',
          borderColor: '#c3e6cb',
          borderWidth: 1,
          borderRadius: 6,
          padding: 10,
          marginBottom: 10,
        }}>
          <Text style={{color: '#155724', fontSize: 14, fontWeight: '500'}}>
            🎉 New WAV files detected! Total: {wavFiles.length}
          </Text>
          <TouchableOpacity
            style={{
              backgroundColor: '#28a745',
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 4,
              alignSelf: 'flex-start',
              marginTop: 5,
            }}
            onPress={() => setNewFilesDetected(false)}
          >
            <Text style={{color: 'white', fontSize: 12, fontWeight: '600'}}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView style={{maxHeight: 100, marginVertical: 10}}>
        {wavFiles.length === 0 ? (
          <Text>No .wav files found</Text>
        ) : (
          wavFiles.map((file, index) => (
            <TouchableOpacity
              key={index}
              onPress={() => {
                setSelectedFile(file);
                addLog(`Selected file: ${file}`);
              }}
              style={{
                backgroundColor: selectedFile === file ? '#ddd' : 'transparent',
                padding: 5,
              }}>
              <Text style={{fontSize: 12, color: '#000'}}>
                {file.split('/').pop()}
                {selectedFile === file ? ' (SELECTED)' : ''}
              </Text>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>

      <View style={styles.buttonContainer}>
        {selectedFile ? (
          <TouchableOpacity
            style={isRunning ? styles.buttonRed : styles.buttonGreen}
            onPress={toggleFileSending}
            disabled={!selectedFile}>
            <Text style={styles.buttonText}>
              {isRunning ? 'Stop' : 'Start'}
            </Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.noFileText}>Please select a file above</Text>
        )}
      </View>

      {/* Timing display */}
      <View style={{marginTop: 10}}>
        {isRunning ? (
          <>
            <Text style={{fontSize: 14, color: '#000'}}>Start: {startTimestampMs ? new Date(startTimestampMs).toLocaleTimeString() : '-'}</Text>
          
          </>
        ) : lastDurationHours !== null ? (
          <Text style={{fontSize: 14, color: '#000'}}>Last duration: {lastDurationHours} hours</Text>
        ) : null}
      </View>

      <View style={{marginTop: 10}}>
        <Text style={{fontSize: 14, color: '#000'}}>Sent: {sentCount} | Processed: {processedCount}</Text>
      </View>

      <Text style={styles.logTitle}>Activity Log:</Text>
      <ScrollView style={styles.logContainer}>
        {logs.map((log, index) => (
          <Text key={index} style={styles.logText}>
            {log}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 20,
  },
  buttonGreen: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 5,
    backgroundColor: '#4CAF50',
  },
  buttonRed: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 5,
    backgroundColor: '#F44336',
  },
  buttonText: {
    color: 'white',
    fontWeight: 'bold',
  },
  noFileText: {
    color: '#888',
    fontStyle: 'italic',
  },
  currentChunkText: {
    fontSize: 24,
    marginVertical: 20,
    textAlign: 'center',
    fontWeight: 'bold',
  },
  logTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: 30,
  },
  logContainer: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    padding: 20,
    borderRadius: 8,
    marginTop: 5,

  },
  logText: {
    fontSize: 12,
    color: '#333',
    marginBottom: 4,
    fontFamily: 'monospace',
  },
});
