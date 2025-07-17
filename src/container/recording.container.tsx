import * as React from 'react';
import {useRef, useState, useEffect} from 'react';
import {
  View,
  Button,
  PermissionsAndroid,
  Platform,
  Text,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Alert,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {BottomTabScreenProps} from '@react-navigation/bottom-tabs';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {CompositeScreenProps} from '@react-navigation/native';
import {HomeModuleParamList, AppModuleParamList} from '../app.navigation';
import AudioRecord from 'react-native-audio-record';
import RNFS from 'react-native-fs';
import {getPlatformWSUrl} from '../environment';
import {getAPIServer} from '../environment';
import {SERVER_CONFIG} from '../environment';
import {useDispatch, useSelector} from 'react-redux';
import {transcriptionActions, selectTranscriptions} from '../redux/transcriptions.redux';
import {RootState} from '../redux/store.redux';

let chunkCounter = 0;

type RecordingContainerProps = CompositeScreenProps<
  BottomTabScreenProps<HomeModuleParamList, 'home'>,
  NativeStackScreenProps<AppModuleParamList>
>;

export function RecordingContainer(props: RecordingContainerProps) {
  const dispatch = useDispatch();
  const transcriptions = useSelector(selectTranscriptions);
  
  const [recording, setRecording] = useState(false);
  const [chunks, setChunks] = useState<string[]>([]);
  const [ipAddress, setIpAddress] = useState(getPlatformWSUrl()); // Use environment config
  const [customServerUrl, setCustomServerUrl] = useState(SERVER_CONFIG.BASE_ADDRESS); // Use environment config
  const [showServerInput, setShowServerInput] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [retryCount, setRetryCount] = useState(0);
  const [maxRetries] = useState(3);
  const [debugInfo, setDebugInfo] = useState({ chunksSent: 0, transcriptionsReceived: 0 });
  const [performanceLogs, setPerformanceLogs] = useState<string[]>([]);

  const logPerformance = (message: string) => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    console.log(logEntry);
    setPerformanceLogs(prev => [...prev.slice(-50), logEntry]); // Keep last 50 logs
  };

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupWebSocket();
    };
  }, []);

  // Monitor transcriptions changes for debugging
  useEffect(() => {
    console.log('🔄 Transcriptions state updated:', transcriptions.length, 'items');
    if (transcriptions.length > 0) {
      console.log('📝 Latest transcription:', transcriptions[transcriptions.length - 1]);
    }
  }, [transcriptions]);

  const cleanupWebSocket = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;
        
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.close();
        }
        wsRef.current = null;
      } catch (error) {
        console.warn('Error during WebSocket cleanup:', error);
      }
    }
  };

  const requestPermission = async () => {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert('Permission denied', 'Cannot record audio without permission');
          return false;
        }
      }
      return true;
    } catch (error) {
      Alert.alert('Permission error', (error as Error).message);
      return false;
    }
  };

  const initRecorder = (filename: string) => {
    const options = {
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      wavFile: filename,
    };
    AudioRecord.init(options);
  };

  const startChunkRecording = async () => {
    try {
      const filename = `chunk_${chunkCounter}.wav`;
      console.log('🎙️ Starting chunk recording:', filename);
      initRecorder(filename);
      await AudioRecord.start();
      console.log('✅ Chunk recording started successfully');
    } catch (error) {
      console.error('❌ Failed to start chunk recording:', error);
      Alert.alert('Recording error', 'Failed to start recording: ' + (error as Error).message);
    }
  };

  const stopChunkRecording = async () => {
    try {
      console.log('🛑 Stopping chunk recording...');
      const file = await AudioRecord.stop();
      console.log('📁 Audio file saved:', file);
      setChunks(prev => [...prev, file]);
      chunkCounter++;

      console.log('📖 Reading audio file as base64...');
      const base64Data = await RNFS.readFile(file, 'base64');
      console.log('🎤 Audio chunk size:', base64Data.length, 'characters');

      // Skip very small audio chunks (likely silence)
      if (base64Data.length < 1000) {
        console.log('⏭️ Skipping small audio chunk (likely silence)');
        return file;
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        const audioMessage = {
          type: 'audio',
          data: base64Data,
          chunk_id: chunkCounter,
          client_timestamp: Date.now()
        };
        
        logPerformance(`[CLIENT_SEND] Chunk:${chunkCounter} Size:${base64Data.length}chars`);
        console.log('📤 Sending audio chunk to server...');
        wsRef.current.send(JSON.stringify(audioMessage));
        console.log('✅ Audio chunk sent successfully');
        setDebugInfo(prev => ({ ...prev, chunksSent: prev.chunksSent + 1 }));
      } else {
        console.warn('⚠️ WebSocket not ready, cannot send audio chunk');
        console.warn('WebSocket state:', wsRef.current?.readyState);
      }
      return file;
    } catch (error) {
      console.error('❌ Failed to stop chunk recording:', error);
      Alert.alert('Recording error', 'Failed to stop recording or send chunk: ' + (error as Error).message);
      throw error;
    }
  };

  const createWebSocket = (wsUrl: string): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(wsUrl);
        
        // Set up event handlers with proper error handling
        ws.onopen = () => {
          console.log('✅ WebSocket connected to', wsUrl);
          setConnectionStatus('connected');
          setRetryCount(0); // Reset retry count on successful connection
          resolve(ws);
        };

        ws.onmessage = (event) => {
          try {
            console.log('📨 Received WebSocket message:', event.data);
            if (event && event.data) {
              const message = JSON.parse(event.data);
              console.log('📝 Parsed message:', message);
              
              if (message.type === 'transcription') {
                const receiveTime = Date.now();
                const serverTimestamp = message.timestamp || 0;
                const roundTripTime = serverTimestamp > 0 ? receiveTime - serverTimestamp : 0;
                
                logPerformance(`[CLIENT_RECEIVE] Chunk:${message.chunk_id} Text:'${message.text}' RoundTrip:${roundTripTime}ms`);
                console.log('✅ Adding transcription:', message.text);
                console.log('📊 Chunk ID:', message.chunk_id);
                console.log('⏱️ Round trip time:', roundTripTime, 'ms');
                console.log('🔍 Current transcriptions count before:', transcriptions.length);
                
                // Add the transcription to Redux
                dispatch(transcriptionActions.addTranscription(message.text));
                setDebugInfo(prev => ({ ...prev, transcriptionsReceived: prev.transcriptionsReceived + 1 }));
                
                // Force a re-render by updating a state
                setTimeout(() => {
                  console.log('🔍 Current transcriptions count after:', transcriptions.length);
                }, 100);
                
                // // Show an alert for debugging (remove this later)
                // Alert.alert('Transcription Received', `Text: ${message.text}\nChunk: ${message.chunk_id}`);
                
              } else if (message.type === 'pong') {
                console.log('🏓 Received pong from server, chunk ID:', message.chunk_id);
              } else if (message.type === 'audio_received') {
                console.log('📥 Server acknowledged audio chunk:', message.chunk);
              } else if (message.type === 'session_complete') {
                console.log('🏁 Session completed:', message);
              } else {
                console.log('⚠️ Unknown message type:', message.type);
              }
            }
          } catch (e) {
            console.warn('❌ Failed to parse WebSocket message:', e);
            console.warn('Raw message data:', event.data);
          }
        };

        ws.onerror = (event) => {
          console.warn('WebSocket error event received:', event);
          // Don't reject here, let onclose handle the failure
        };

        ws.onclose = (event) => {
          console.log('WebSocket closed with code:', event.code, 'reason:', event.reason);
          setConnectionStatus('disconnected');
          
          // Only reject if this is the initial connection attempt
          if (ws.readyState === WebSocket.CONNECTING) {
            reject(new Error(`WebSocket connection failed: ${event.code} - ${event.reason}`));
          }
        };

        // Set a timeout for connection
        const connectionTimeout = setTimeout(() => {
          if (ws.readyState === WebSocket.CONNECTING) {
            ws.close();
            reject(new Error('WebSocket connection timeout'));
          }
        }, 10000); // 10 second timeout

        // Clear timeout when connection succeeds
        ws.onopen = () => {
          clearTimeout(connectionTimeout);
          console.log('✅ WebSocket connected to', wsUrl);
          setConnectionStatus('connected');
          setRetryCount(0);
          resolve(ws);
        };

      } catch (error) {
        reject(error);
      }
    });
  };

  const testDirectServerConnection = async () => {
    try {
      console.log('🔍 DIRECT SERVER TEST STARTING...');
      
      // Test 1: HTTP Health Check
      console.log('📡 Test 1: HTTP Health Check');
      const healthUrl = getAPIServer() + '/health';
      console.log('   URL:', healthUrl);
      
      try {
        const healthResponse = await fetch(healthUrl);
        const healthData = await healthResponse.json();
        console.log('   ✅ SUCCESS:', healthData);
        Alert.alert('HTTP Test Success', `Server is running!\nStatus: ${healthData.status}\nModel: ${healthData.model_loaded ? 'Loaded' : 'Not loaded'}`);
      } catch (error) {
        console.log('   ❌ FAILED:', error);
        Alert.alert('HTTP Test Failed', `Cannot reach server at ${healthUrl}\n\nError: ${error}`);
        return;
      }
      
      // Test 2: WebSocket Connection
      console.log('📡 Test 2: WebSocket Connection');
      const wsUrl = getPlatformWSUrl();
      console.log('   URL:', wsUrl);
      
      try {
        const ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
          console.log('   ✅ WebSocket CONNECTED!');
          Alert.alert('WebSocket Success', 'Direct WebSocket connection successful!\n\nServer is ready for audio transcription.');
          
          // Send a test message
          const testMessage = {
            type: 'ping',
            timestamp: new Date().toISOString()
          };
          ws.send(JSON.stringify(testMessage));
          console.log('   📤 Sent test ping message');
          
          // Close after 2 seconds
          setTimeout(() => {
            ws.close();
            console.log('   🔌 Test WebSocket closed');
          }, 2000);
        };
        
        ws.onmessage = (event) => {
          console.log('   📨 Received:', event.data);
        };
        
        ws.onerror = (error) => {
          console.log('   ❌ WebSocket ERROR:', error);
        };
        
        ws.onclose = (event) => {
          console.log('   🔌 WebSocket CLOSED:', event.code, event.reason);
        };
        
        // Timeout after 10 seconds
        setTimeout(() => {
          if (ws.readyState === WebSocket.CONNECTING) {
            console.log('   ⏰ WebSocket TIMEOUT');
            ws.close();
            Alert.alert('WebSocket Timeout', 'WebSocket connection timed out after 10 seconds.\n\nCheck:\n1. Server is running\n2. Firewall allows port 8000\n3. Network connectivity');
          }
        }, 10000);
        
      } catch (error) {
        console.log('   ❌ WebSocket FAILED:', error);
        Alert.alert('WebSocket Failed', `WebSocket connection failed:\n${error}`);
      }
      
    } catch (error) {
      console.error('❌ Direct test error:', error);
      Alert.alert('Test Error', `Error: ${error}`);
    }
  };



  const updateServerUrl = () => {
    if (customServerUrl.trim()) {
      // Update the WebSocket URL - use WSS for HTTPS domains, WS for HTTP
      const isSecure = customServerUrl.includes('https://') || customServerUrl.includes('quantosaas.com');
      const protocol = isSecure ? 'wss' : 'ws';
      const cleanUrl = customServerUrl.replace(/^https?:\/\//, ''); // Remove http/https prefix
      const wsUrl = `${protocol}://${cleanUrl}/ws/transcribe`;
      
      setIpAddress(wsUrl);
      setShowServerInput(false);
      Alert.alert('Server Updated', `Server URL changed to: ${customServerUrl}\nWebSocket: ${wsUrl}`);
      console.log('🔧 Server URL updated to:', wsUrl);
    } else {
      Alert.alert('Invalid URL', 'Please enter a valid server URL');
    }
  };

  const testServerConnection = async () => {
    try {
      // Use custom server URL if available, otherwise fall back to environment config
      const isSecure = customServerUrl.includes('https://') || customServerUrl.includes('quantosaas.com');
      const protocol = isSecure ? 'https' : 'http';
      const cleanUrl = customServerUrl.replace(/^https?:\/\//, ''); // Remove http/https prefix
      const baseUrl = customServerUrl ? `${protocol}://${cleanUrl}` : getAPIServer();
      const healthUrl = baseUrl + '/health';
      console.log('🔍 Testing server connection:', healthUrl);
      
      const response = await fetch(healthUrl);
      const data = await response.json();
      
      console.log('✅ Server is running:', data);
      return true;
    } catch (error) {
      console.error('❌ Server connection failed:', error);
      Alert.alert('Server Error', `Cannot connect to server. Please make sure the server is running on ${customServerUrl || getAPIServer()}`);
      return false;
    }
  };

  const startRecording = async () => {
    const granted = await requestPermission();
    if (!granted) return;

    // Test server connection first
    const serverOk = await testServerConnection();
    if (!serverOk) return;

    try {
      setConnectionStatus('connecting');
      
      // Use the platform-specific WebSocket URL
      const wsUrl = ipAddress;

      console.log('Connecting to:', wsUrl);
      console.log('Platform:', Platform.OS);
      console.log('Development mode:', __DEV__);

      // Try to establish WebSocket connection with retry logic
      let connected = false;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= maxRetries && !connected; attempt++) {
        if (attempt > 0) {
          console.log(`Retry attempt ${attempt}/${maxRetries}`);
          setRetryCount(attempt);
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
        }

        try {
          wsRef.current = await createWebSocket(wsUrl);
          connected = true;
        } catch (error) {
          lastError = error as Error;
          console.warn(`Connection attempt ${attempt + 1} failed:`, error);
          
          if (attempt === maxRetries) {
            throw lastError;
          }
        }
      }

      if (!connected) {
        throw lastError || new Error('Failed to establish WebSocket connection');
      }

      // Set up ping/pong for connection stability
      pingIntervalRef.current = setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          try {
            wsRef.current.send(JSON.stringify({type: 'ping'}));
          } catch (error) {
            console.warn('Failed to send ping:', error);
          }
        }
      }, 30000);

      // Start recording
      chunkCounter = 0;
      setChunks([]);
      setDebugInfo({ chunksSent: 0, transcriptionsReceived: 0 });
      dispatch(transcriptionActions.clearTranscriptions());
      setRecording(true);
      await startChunkRecording();

      intervalRef.current = setInterval(async () => {
        try {
          await stopChunkRecording();
          await startChunkRecording();
        } catch {
          // Already alerted inside stopChunkRecording
          stopRecording(); // Stop recording if errors occur repeatedly
        }
      }, 3000);

    } catch (error) {
      setConnectionStatus('error');
      const errorMessage = error instanceof Error ? error.message : 'Unknown connection error';
      Alert.alert('Connection Error', `Failed to connect after ${retryCount + 1} attempts: ${errorMessage}`);
      console.error('Connection error:', error);
    }
  };

  const stopRecording = async () => {
    cleanupWebSocket();
    setRecording(false);
    saveCurrentTranscriptions()
    try {
      await stopChunkRecording();
    } catch {
      // Already handled in stopChunkRecording
    }

    // Save transcriptions to file before clearing
    if (transcriptions.length > 0) {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `transcription_${timestamp}.txt`;
        const content = transcriptions.join('\n');
        
        console.log('Saving transcriptions...');
        console.log('Filename:', filename);
        console.log('Content length:', content.length);
        console.log('Save path:', RNFS.DocumentDirectoryPath);
        
        // Save to local device storage
        const filePath = `${RNFS.DocumentDirectoryPath}/${filename}`;
        await RNFS.writeFile(filePath, content, 'utf8');
        
        console.log('Transcription saved successfully:', filePath);
        Alert.alert('Success', `Transcription saved as ${filename}\nLocation: ${filePath}`);
        // Clear transcriptions after successful save
        dispatch(transcriptionActions.clearTranscriptions());
      } catch (error) {
        console.error('Error saving transcription:', error);
        Alert.alert('Error', 'Failed to save transcription: ' + (error as Error).message);
      }
    }
  };

  const testNetworkConnectivity = async () => {
    try {
      console.log('🌐 Testing network connectivity...');
      
      // Test different IP addresses using environment config
      const testUrls = [
        getAPIServer() + '/health',  // Primary server from environment
        'http://127.0.0.1:8000/health',  // Localhost fallback
        'http://10.0.2.2:8000/health',   // Android emulator fallback
      ];
      
      for (const url of testUrls) {
        try {
          console.log(`🔍 Testing: ${url}`);
          const response = await fetch(url);
          const data = await response.json();
          console.log(`✅ Success: ${url}`, data);
          Alert.alert('Network Test Success', `Server found at: ${url}\nStatus: ${data.status}`);
          return url.replace('/health', ''); // Return the base URL
        } catch (error) {
          console.log(`❌ Failed: ${url}`, error);
        }
      }
      
      Alert.alert('Network Test Failed', 'Could not reach server at any address.\n\nPlease check:\n1. Server is running\n2. Firewall settings\n3. Network connectivity');
      
    } catch (error) {
      console.error('❌ Network test error:', error);
      Alert.alert('Network Test Error', `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const testAPIConnection = async () => {
    try {
      // First test the health endpoint
      const healthUrl = getAPIServer() + '/health';
      console.log('🔍 Testing health endpoint:', healthUrl);
      
      const healthResponse = await fetch(healthUrl);
      const healthData = await healthResponse.json();
      
      console.log('✅ Health check successful:', healthData);
      
      // Then test the transcriptions endpoint
      const transcriptionsUrl = getAPIServer() + '/list-transcriptions';
      console.log('🔍 Testing transcriptions endpoint:', transcriptionsUrl);
      
      const transcriptionsResponse = await fetch(transcriptionsUrl);
      const transcriptionsData = await transcriptionsResponse.json();
      
      console.log('✅ Transcriptions test successful:', transcriptionsData);
      Alert.alert('API Test Success', 
        `Server is healthy!\n` +
        `Model loaded: ${healthData.model_loaded}\n` +
        `Found ${transcriptionsData.files?.length || 0} transcription files.`
      );
    } catch (error) {
      console.error('❌ API test failed:', error);
      Alert.alert('API Test Failed', `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const saveCurrentTranscriptions = async () => {
    if (transcriptions.length === 0) {
      // Alert.alert('No Transcriptions', 'No transcriptions to save');
      return;
    }

    // try {
    //   const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    //   const filename = `transcription_${timestamp}.txt`;
    //   const content = transcriptions.join('\n');
      
    //   console.log('Saving transcriptions...');
    //   console.log('Filename:', filename);
    //   console.log('Content length:', content.length);
    //   console.log('Save path:', RNFS.DocumentDirectoryPath);
      
    //   // Save to local device storage
    //   const filePath = `${RNFS.DocumentDirectoryPath}/${filename}`;
    //   await RNFS.writeFile(filePath, content, 'utf8');
      
    //   console.log('Transcription saved successfully:', filePath);
    //   Alert.alert('Success', `Transcription saved as ${filename}\nLocation: ${filePath}`);
    //   // Clear transcriptions after successful save
    //   dispatch(transcriptionActions.clearTranscriptions());
    // } catch (error) {
    //   console.error('Error saving transcription:', error);
    //   Alert.alert('Error', 'Failed to save transcription: ' + (error as Error).message);
    // }
  };

 
  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={styles.keyboardAvoid} behavior="padding">
        {/* Header Section */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Audio Transcription</Text>
          <View style={styles.connectionStatus}>
            <View style={[
              styles.statusIndicator,
              connectionStatus === 'connected' ? styles.connected : 
              connectionStatus === 'connecting' ? styles.connecting : 
              styles.disconnected
            ]} />
            <Text style={styles.statusText}>
              {connectionStatus === 'connected' ? 'Connected' : 
               connectionStatus === 'connecting' ? `Connecting${retryCount > 0 ? ` (${retryCount}/${maxRetries})` : ''}` : 
               'Disconnected'}
            </Text>
          </View>
        </View>

        {/* Server Configuration Section */}
        <View style={styles.serverConfig}>
          <View style={styles.serverConfigHeader}>
            <Text style={styles.serverConfigTitle}>Server Configuration</Text>
            <TouchableOpacity 
              onPress={() => setShowServerInput(!showServerInput)}
              style={styles.serverToggleButton}
            >
              <Text style={styles.serverToggleText}>
                {showServerInput ? 'Hide' : 'Change'}
              </Text>
            </TouchableOpacity>
          </View>
          
          {showServerInput && (
            <View style={styles.serverInputContainer}>
              <TextInput
                style={styles.serverInput}
                placeholder="Enter server URL (e.g., vc2txt.quantosaas.com)"
                placeholderTextColor="#999"
                value={customServerUrl}
                onChangeText={setCustomServerUrl}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity 
                  onPress={updateServerUrl}
                  style={styles.updateButton}
                >
                  <Text style={styles.updateButtonText}>Update</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  onPress={() => {
                    setCustomServerUrl(SERVER_CONFIG.BASE_ADDRESS);
                    setIpAddress(getPlatformWSUrl());
                    Alert.alert('Server Reset', `Server URL reset to default: ${SERVER_CONFIG.BASE_ADDRESS}`);
                  }}
                  style={[styles.updateButton, { backgroundColor: '#6c757d' }]}
                >
                  <Text style={styles.updateButtonText}>Reset</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          
          <Text style={styles.currentServerText}>
            Current: {customServerUrl}
          </Text>
        </View>

        {/* Stats Bar */}
        {recording && (
          <View style={styles.statsBar}>
            <View style={styles.statItem}>
              {/* <Icon name="file-upload" size={16} color="#555" /> */}
              <Text style={styles.statText}>{debugInfo.chunksSent}</Text>
            </View>
            <View style={styles.statItem}>
              {/* <Icon name="text-snippet" size={16} color="#555" /> */}
              <Text style={styles.statText}>{debugInfo.transcriptionsReceived}</Text>
            </View>
            <View style={styles.statItem}>
              {/* <Icon name="timer" size={16} color="#555" /> */}
              <Text style={styles.statText}>{transcriptions.length}</Text>
            </View>
          </View>
        )}

        {/* Main Action Buttons */}
        <View style={styles.buttonGroup}>

          
          {!recording && (
            <TouchableOpacity 
              style={styles.testButton}
              onPress={testDirectServerConnection}
            >
              {/* <Icon name="wifi-tethering" size={20} color="#fff" /> */}
              <Text style={styles.testButtonText}>TEST CONNECTION</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity 
            style={[
              styles.mainButton,
              recording ? styles.stopButton : styles.startButton
            ]}
            onPress={recording ? stopRecording : startRecording}
          >
            {connectionStatus === 'connecting' ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                {/* <Icon 
                  name={recording ? "stop" : "mic"} 
                  size={24} 
                  color="#fff" 
                  style={styles.buttonIcon}
                /> */}
                <Text style={styles.buttonText}>
                  {recording ? 'STOP RECORDING' : 'START RECORDING'}
                </Text>
              </>
            )}
          </TouchableOpacity>

        </View>

       

        {/* Transcription List */}
     
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  keyboardAvoid: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingBottom: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e9ecef',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: '#212529',
  },
  connectionStatus: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 8,
  },
  connected: {
    backgroundColor: '#28a745',
  },
  connecting: {
    backgroundColor: '#ffc107',
  },
  disconnected: {
    backgroundColor: '#dc3545',
  },
  statusText: {
    fontSize: 14,
    color: '#6c757d',
  },
  statsBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    padding: 12,
    backgroundColor: '#fff',
    marginHorizontal: 20,
    marginTop: 10,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statText: {
    marginLeft: 6,
    fontSize: 14,
    color: '#495057',
    fontWeight: '500',
  },
  buttonGroup: {
    padding: 20,
    paddingTop: 10,
  },
  mainButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 15,
    borderRadius: 10,
    marginBottom: 15,
  },
  startButton: {
    backgroundColor: '#0d6efd',
  },
  stopButton: {
    backgroundColor: '#dc3545',
  },
  buttonIcon: {
    marginRight: 10,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  testButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 12,
    backgroundColor: '#6c757d',
    borderRadius: 10,
    marginBottom: 15,
  },
  testButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 8,
  },
  transcriptionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#212529',
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#198754',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 5,
  },
  transcriptionList: {
    flex: 1,
    paddingHorizontal: 15,
  },
  transcriptionContent: {
    paddingBottom: 20,
  },
  transcriptionItem: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    padding: 15,
    borderRadius: 8,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  itemBullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#0d6efd',
    marginTop: 6,
    marginRight: 10,
  },
  transcriptionText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: '#212529',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyText: {
    fontSize: 16,
    color: '#6c757d',
    marginTop: 15,
    marginBottom: 5,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#adb5bd',
    textAlign: 'center',
  },
  serverConfig: {
    backgroundColor: '#fff',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e9ecef',
  },
  serverConfigHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  serverConfigTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#212529',
  },
  serverToggleButton: {
    backgroundColor: '#6c757d',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  serverToggleText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  serverInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  serverInput: {
    flex: 1,
    backgroundColor: '#f8f9fa',
    borderWidth: 1,
    borderColor: '#dee2e6',
    borderRadius: 6,
    padding: 10,
    fontSize: 14,
    color: '#212529',
  },
  updateButton: {
    backgroundColor: '#007bff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
  },
  updateButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  currentServerText: {
    fontSize: 12,
    color: '#6c757d',
    fontFamily: 'monospace',
  },
});