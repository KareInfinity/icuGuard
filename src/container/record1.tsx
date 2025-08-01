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
import {getCustomPlatformWSUrl, getCustomPlatformAPIUrl, DEFAULT_SERVER_URL} from '../utils/serverUtils';
import {useDispatch, useSelector} from 'react-redux';
import {transcriptionActions, selectTranscriptions} from '../redux/transcriptions.redux';
import {selectCustomServerUrl, serverActions} from '../redux/server.redux';
import {RootState} from '../redux/store.redux';



type RecordingContainerProps = CompositeScreenProps<
  BottomTabScreenProps<HomeModuleParamList, 'home'>,
  NativeStackScreenProps<AppModuleParamList>
>;

export function RecordingContainer(props: RecordingContainerProps) {
  const dispatch = useDispatch();
  const transcriptions = useSelector(selectTranscriptions);
  const customServerUrl = useSelector(selectCustomServerUrl);
  
  const [recording, setRecording] = useState(false);
  const [chunks, setChunks] = useState<string[]>([]);
  const [ipAddress, setIpAddress] = useState(getCustomPlatformWSUrl(customServerUrl)); // Use Redux state
  const [showServerInput, setShowServerInput] = useState(false);
  const [serverUrlInput, setServerUrlInput] = useState(customServerUrl);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [retryCount, setRetryCount] = useState(0);
  const [maxRetries] = useState(3);
  const [audioChunksSent, setAudioChunksSent] = useState(0);
  const [performanceLogs, setPerformanceLogs] = useState<string[]>([]);
  const [audioRecordInitialized, setAudioRecordInitialized] = useState(false);
  const [isSendingAudio, setIsSendingAudio] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [errorCount, setErrorCount] = useState(0);


  // Audio recording state
  const fullAudioData = useRef<string>('');
  const isRecording = useRef<boolean>(false);
  const recordingStartTime = useRef<number | null>(null);

  const logPerformance = (message: string) => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    console.log(logEntry);
    setPerformanceLogs(prev => [...prev.slice(-50), logEntry]); // Keep last 50 logs
  };

  const handleError = (error: Error | string, context: string = 'Unknown') => {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const fullError = `${context}: ${errorMessage}`;
    
    console.error(`❌ ${fullError}`);
    setLastError(fullError);
    setErrorCount(prev => prev + 1);
    
    // Log error for debugging
    logPerformance(`[ERROR] ${fullError}`);
    
    return fullError;
  };

  const clearError = () => {
    setLastError(null);
    setErrorCount(0);
  };

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initialize audio recorder
  useEffect(() => {
    const initializeAudioRecord = async () => {
      try {
        console.log('🔧 Initializing AudioRecord...');
        const options = {
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
          wavFile: 'voice_recording.wav',
        };
        
        // Try to initialize with retry logic
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            await AudioRecord.init(options);
            setAudioRecordInitialized(true);
            console.log('✅ AudioRecord initialized successfully');
            return;
          } catch (initError) {
            retryCount++;
            console.warn(`❌ AudioRecord init attempt ${retryCount} failed:`, initError);
            
            if (retryCount >= maxRetries) {
              throw initError;
            }
            
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
          }
        }
      } catch (error) {
        console.error('❌ Failed to initialize AudioRecord after all retries:', error);
        setAudioRecordInitialized(false);
        Alert.alert('Audio Error', 'Failed to initialize audio recorder after multiple attempts. Please restart the app.');
      }
    };

    initializeAudioRecord();
  }, []);

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

  // Update WebSocket URL when custom server URL changes
  useEffect(() => {
    const wsUrl = getCustomPlatformWSUrl(customServerUrl);
    setIpAddress(wsUrl);
    console.log('🔧 WebSocket URL updated to:', wsUrl);
  }, [customServerUrl]);

  // Sync input field with Redux state
  useEffect(() => {
    setServerUrlInput(customServerUrl);
  }, [customServerUrl]);

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

  const startVoiceRecording = async () => {
    try {
      console.log('🎙️ Starting audio recording...');
      
      // Clear previous audio data
      fullAudioData.current = '';
      isRecording.current = true;
      recordingStartTime.current = Date.now();

      // Start recording
      await AudioRecord.start();
      console.log('✅ Audio recording started successfully');

    } catch (error) {
      console.error('❌ Failed to start audio recording:', error);
      Alert.alert('Recording error', 'Failed to start audio recording: ' + (error as Error).message);
    }
  };

  const stopVoiceRecording = async () => {
    try {
      console.log('🛑 Stopping voice recording...');
      
      isRecording.current = false;
      
      // Stop recording and get the full audio data
      try {
        const file = await AudioRecord.stop();
        console.log('📁 Audio file path:', file);
        
        // Read the audio file and validate it
        const base64Data = await RNFS.readFile(file, 'base64');
        
        // Validate audio data
        if (!base64Data || base64Data.length === 0) {
          throw new Error('Audio file is empty or invalid');
        }
        
        if (base64Data.length < 1000) {
          console.warn('⚠️ Audio file seems very small, may be empty recording');
        }
        
        // Store the full audio data
        fullAudioData.current = base64Data;
        
        const recordingDuration = Date.now() - (recordingStartTime.current || 0);
        console.log('📁 Full audio saved, size:', base64Data.length, 'characters');
        console.log('⏱️ Recording duration:', recordingDuration, 'ms');
        console.log('🔍 Audio data validation: OK');
        
        // Verify the audio data is properly set
        if (fullAudioData.current !== base64Data) {
          throw new Error('Audio data not properly stored in variable');
        }
        
        console.log('✅ Audio data verified and stored correctly');
        
        // Try to send audio via WebSocket with retry mechanism
        let sendSuccess = false;
        let retryCount = 0;
        const maxRetries = 3;
        
        while (!sendSuccess && retryCount < maxRetries) {
          try {
            console.log(`🔄 Attempting to send audio (attempt ${retryCount + 1}/${maxRetries})`);
            await sendAudioViaWebSocket(base64Data);
            sendSuccess = true;
            console.log('✅ Audio sent successfully via WebSocket');
            
            // Verify the audio was actually sent
            if (fullAudioData.current && fullAudioData.current.length > 0) {
              console.log('✅ Full audio data confirmed sent');
            } else {
              console.warn('⚠️ Audio data variable appears empty after sending');
            }
            
          } catch (error) {
            retryCount++;
            console.error(`❌ Audio send attempt ${retryCount} failed:`, error);
            
            if (retryCount < maxRetries) {
              console.log(`🔄 Retrying audio send in 2 seconds... (${retryCount}/${maxRetries})`);
              await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
              console.error('❌ All audio send attempts failed');
              handleError(error as Error, 'Audio Send Failed');
              Alert.alert('Send Failed', 'Failed to send audio after multiple attempts. Please try again.');
            }
          }
        }
        
      } catch (error) {
        console.error('❌ Error getting audio data:', error);
        handleError(error as Error, 'Audio Data Error');
        Alert.alert('Recording Error', 'Failed to get audio data: ' + (error as Error).message);
      }
      
      console.log('✅ Audio recording stopped successfully');
    } catch (error) {
      console.error('❌ Failed to stop audio recording:', error);
      handleError(error as Error, 'Recording Stop Error');
      Alert.alert('Recording error', 'Failed to stop audio recording: ' + (error as Error).message);
    }
  };

  const createWebSocket = (wsUrl: string): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      try {
        console.log('🔧 Creating WebSocket connection...');
        console.log('🌐 WebSocket URL:', wsUrl);
        console.log('📱 Platform:', Platform.OS);
        console.log('🔧 Development mode:', __DEV__);
        console.log('🌍 Network info - URL components:');
        console.log('   - Protocol:', wsUrl.startsWith('ws://') ? 'ws' : 'wss');
        console.log('   - Host:', wsUrl.replace(/^wss?:\/\//, '').split(':')[0]);
        console.log('   - Port:', wsUrl.match(/:(\d+)/)?.[1] || 'default');
        
        const ws = new WebSocket(wsUrl);
        console.log('🔌 WebSocket object created, readyState:', ws.readyState);
        
        // Set up event handlers with proper error handling
        ws.onopen = () => {
          console.log('✅ WebSocket connected successfully to', wsUrl);
          console.log('🔌 Final readyState:', ws.readyState);
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
              
              // Handle connection establishment
              if (message.type === 'connection_established') {
                console.log('✅ Connection established with session ID:', message.session_id);
                return;
              }
              
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
                
                // Force a re-render by updating a state
                setTimeout(() => {
                  console.log('🔍 Current transcriptions count after:', transcriptions.length);
                }, 100);
                
              } else if (message.type === 'pong') {
                console.log('🏓 Received pong from server, chunk ID:', message.chunk_id);
              } else if (message.type === 'audio_received') {
                console.log('📥 Server acknowledged audio chunk:', message.chunk);
              } else if (message.type === 'session_complete') {
                console.log('🏁 Session completed:', message);
              } else if (message.type === 'error') {
                console.error('❌ Server error:', message.message);
                Alert.alert('Server Error', `Server error: ${message.message}`);
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
          console.error('❌ WebSocket error event received:');
          console.error('   - Error object:', event);
          console.error('   - ReadyState at error:', ws.readyState);
          console.error('   - URL that failed:', wsUrl);
          console.error('   - Platform:', Platform.OS);
          console.error('   - Development mode:', __DEV__);
          
          // Log additional network info
          console.error('🌐 Network debugging info:');
          console.error('   - URL protocol:', wsUrl.startsWith('ws://') ? 'ws' : 'wss');
          console.error('   - URL host:', wsUrl.replace(/^wss?:\/\//, '').split(':')[0]);
          console.error('   - URL port:', wsUrl.match(/:(\d+)/)?.[1] || 'default');
          
          // Don't reject here, let onclose handle the failure
        };

        ws.onclose = (event) => {
          console.error('🔌 WebSocket closed:');
          console.error('   - Close code:', event.code);
          console.error('   - Close reason:', event.reason);
          console.error('   - ReadyState at close:', ws.readyState);
          console.error('   - URL that closed:', wsUrl);
          
          // Log close code meanings
          const closeCodeMeanings = {
            1000: 'Normal closure',
            1001: 'Going away',
            1002: 'Protocol error',
            1003: 'Unsupported data',
            1005: 'No status received',
            1006: 'Abnormal closure',
            1007: 'Invalid frame payload data',
            1008: 'Policy violation',
            1009: 'Message too big',
            1010: 'Client terminating',
            1011: 'Server error',
            1012: 'Service restart',
            1013: 'Try again later',
            1014: 'Bad gateway',
            1015: 'TLS handshake'
          };
          
          if (event.code && event.code in closeCodeMeanings) {
            console.error('   - Close code meaning:', closeCodeMeanings[event.code as keyof typeof closeCodeMeanings]);
          }
          
          setConnectionStatus('disconnected');
          
          // Only reject if this is the initial connection attempt
          if (ws.readyState === WebSocket.CONNECTING) {
            const errorMsg = `WebSocket connection failed: ${event.code || 'unknown'} - ${event.reason || (event.code && closeCodeMeanings[event.code as keyof typeof closeCodeMeanings]) || 'Unknown error'}`;
            console.error('❌ Rejecting connection with error:', errorMsg);
            reject(new Error(errorMsg));
          }
        };

        // Set a timeout for connection
        const connectionTimeout = setTimeout(() => {
          if (ws.readyState === WebSocket.CONNECTING) {
            console.error('⏰ WebSocket connection timeout after 10 seconds');
            console.error('   - URL:', wsUrl);
            console.error('   - ReadyState at timeout:', ws.readyState);
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
        console.error('❌ Error creating WebSocket:', error);
        console.error('   - URL:', wsUrl);
        console.error('   - Platform:', Platform.OS);
        reject(error);
      }
    });
  };

  const testDirectServerConnection = async () => {
    try {
      console.log('🔍 DIRECT SERVER TEST STARTING...');
      
      // Test 1: HTTP Health Check
      console.log('📡 Test 1: HTTP Health Check');
      const healthUrl = getCustomPlatformAPIUrl(customServerUrl, '/health');
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
      const wsUrl = getCustomPlatformWSUrl(customServerUrl);
      console.log('   URL:', wsUrl);
      console.log('   Platform:', Platform.OS);
      console.log('   Development mode:', __DEV__);
      
      try {
        console.log('   🔌 Creating WebSocket object...');
        const ws = new WebSocket(wsUrl);
        console.log('   🔌 WebSocket object created, readyState:', ws.readyState);
        
        ws.onopen = () => {
          console.log('   ✅ WebSocket CONNECTED!');
          console.log('   🔌 Final readyState:', ws.readyState);
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
          console.error('   ❌ WebSocket ERROR:');
          console.error('      - Error object:', error);
          console.error('      - ReadyState at error:', ws.readyState);
          console.error('      - URL:', wsUrl);
          console.error('      - Platform:', Platform.OS);
        };
        
        ws.onclose = (event) => {
          console.error('   🔌 WebSocket CLOSED:');
          console.error('      - Close code:', event.code);
          console.error('      - Close reason:', event.reason);
          console.error('      - ReadyState at close:', ws.readyState);
          console.error('      - URL:', wsUrl);
          
          // Log close code meanings
          const closeCodeMeanings = {
            1000: 'Normal closure',
            1001: 'Going away',
            1002: 'Protocol error',
            1003: 'Unsupported data',
            1005: 'No status received',
            1006: 'Abnormal closure',
            1007: 'Invalid frame payload data',
            1008: 'Policy violation',
            1009: 'Message too big',
            1010: 'Client terminating',
            1011: 'Server error',
            1012: 'Service restart',
            1013: 'Try again later',
            1014: 'Bad gateway',
            1015: 'TLS handshake'
          };
          
          if (event.code && event.code in closeCodeMeanings) {
            console.error('      - Close code meaning:', closeCodeMeanings[event.code as keyof typeof closeCodeMeanings]);
          }
        };
        
        // Timeout after 30 seconds
        setTimeout(() => {
          if (ws.readyState === WebSocket.CONNECTING) {
            console.error('   ⏰ WebSocket TIMEOUT after 30 seconds');
            console.error('      - URL:', wsUrl);
            console.error('      - ReadyState at timeout:', ws.readyState);
            ws.close();
            Alert.alert('WebSocket Timeout', 'WebSocket connection timed out after 30 seconds.\n\nCheck:\n1. Server is running\n2. Firewall allows port 8000\n3. Network connectivity\n4. Server WebSocket endpoint is enabled');
          }
        }, 30000);
        
      } catch (error) {
        console.error('   ❌ WebSocket FAILED:');
        console.error('      - Error:', error);
        console.error('      - Error message:', error instanceof Error ? error.message : 'Unknown error');
        console.error('      - URL:', wsUrl);
        console.error('      - Platform:', Platform.OS);
        Alert.alert('WebSocket Failed', `WebSocket connection failed:\n${error}`);
      }
      
    } catch (error) {
      console.error('❌ Direct test error:', error);
      Alert.alert('Test Error', `Error: ${error}`);
    }
  };



  const updateServerUrl = () => {
    if (serverUrlInput.trim()) {
      dispatch(serverActions.setCustomServerUrl(serverUrlInput));
      setShowServerInput(false);
      Alert.alert('Server Updated', `Server URL changed to: ${serverUrlInput}`);
      console.log('🔧 Server URL updated to:', serverUrlInput);
    } else {
      Alert.alert('Invalid URL', 'Please enter a valid server URL');
    }
  };

  const testServerConnection = async () => {
    try {
      const healthUrl = getCustomPlatformAPIUrl(customServerUrl, '/health');
      console.log('🔍 Testing server connection:', healthUrl);
      
      // Add timeout to health check
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(healthUrl, {
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        let errorMessage = `Server returned ${response.status}: ${response.statusText}`;
        
        switch (response.status) {
          case 404:
            errorMessage = 'Server endpoint not found. Please check server configuration.';
            break;
          case 500:
            errorMessage = 'Server internal error. Please try again later.';
            break;
          case 503:
            errorMessage = 'Server temporarily unavailable. Please try again later.';
            break;
          default:
            errorMessage = `Server error (${response.status}): ${response.statusText}`;
        }
        
        throw new Error(errorMessage);
      }
      
      const data = await response.json();
      console.log('✅ Server is running:', data);
      return true;
    } catch (error) {
      console.error('❌ Server connection failed:', error);
      
      let userMessage = 'Cannot connect to server';
      
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          userMessage = 'Connection timeout. Please check your internet connection and server status.';
        } else if (error.message.includes('Network request failed')) {
          userMessage = 'Network error. Please check your internet connection.';
        } else if (error.message.includes('fetch')) {
          userMessage = 'Connection failed. Please check server URL and network connection.';
        } else {
          userMessage = error.message;
        }
      }
      
      Alert.alert('Server Error', `${userMessage}\n\nServer URL: ${getCustomPlatformAPIUrl(customServerUrl)}`);
      return false;
    }
  };

  const startRecording = async () => {
    console.log('🎙️ START RECORDING PROCESS BEGINNING...');
    console.log('📱 Platform:', Platform.OS);
    console.log('🔧 Development mode:', __DEV__);
    console.log('🌐 Custom server URL:', customServerUrl);
    console.log('🔗 WebSocket URL:', ipAddress);
    
    // Check if AudioRecord is initialized
    if (!audioRecordInitialized) {
      Alert.alert('Audio Not Ready', 'Audio recorder is still initializing. Please wait a moment and try again.');
      console.log('❌ AudioRecord not initialized yet');
      return;
    }

    const granted = await requestPermission();
    if (!granted) {
      console.log('❌ Audio permission denied');
      return;
    }

    // Test server connection first
    console.log('🔍 Testing server connection before WebSocket...');
    const serverOk = await testServerConnection();
    if (!serverOk) {
      console.log('❌ Server connection test failed');
      return;
    }

    try {
      setConnectionStatus('connecting');
      
      // Use the platform-specific WebSocket URL
      const wsUrl = ipAddress;

      console.log('🌐 Attempting WebSocket connection to:', wsUrl);
      console.log('📱 Platform:', Platform.OS);
      console.log('🔧 Development mode:', __DEV__);
      console.log('🔄 Max retries:', maxRetries);

      // Try to establish WebSocket connection with retry logic
      let connected = false;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= maxRetries && !connected; attempt++) {
        if (attempt > 0) {
          console.log(`🔄 Retry attempt ${attempt}/${maxRetries}`);
          setRetryCount(attempt);
          const delay = 1000 * attempt;
          console.log(`⏱️ Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay)); // Exponential backoff
        }

        try {
          console.log(`🔌 Attempting WebSocket connection (attempt ${attempt + 1})...`);
          wsRef.current = await createWebSocket(wsUrl);
          connected = true;
          console.log('✅ WebSocket connection established successfully!');
        } catch (error) {
          lastError = error as Error;
          console.error(`❌ Connection attempt ${attempt + 1} failed:`, error);
          console.error(`   - Error message:`, error instanceof Error ? error.message : 'Unknown error');
          console.error(`   - Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
          
          if (attempt === maxRetries) {
            console.error('❌ Max retries reached, giving up');
            throw lastError;
          }
        }
      }

      if (!connected) {
        console.error('❌ Failed to establish WebSocket connection after all attempts');
        throw lastError || new Error('Failed to establish WebSocket connection');
      }

      console.log('🔧 Setting up ping/pong for connection stability...');
      // Set up ping/pong for connection stability
      pingIntervalRef.current = setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          try {
            wsRef.current.send(JSON.stringify({type: 'ping'}));
            console.log('🏓 Ping sent to server');
          } catch (error) {
            console.warn('❌ Failed to send ping:', error);
          }
        }
      }, 30000);

      console.log('🎙️ Starting audio recording...');
      // Start recording
      setChunks([]);
      setAudioChunksSent(0);
      dispatch(transcriptionActions.clearTranscriptions());
      setRecording(true);
      await startVoiceRecording();
      console.log('✅ Recording started successfully!');

    } catch (error) {
      console.error('❌ START RECORDING PROCESS FAILED:');
      console.error('   - Error:', error);
      console.error('   - Error message:', error instanceof Error ? error.message : 'Unknown error');
      console.error('   - Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      console.error('   - Platform:', Platform.OS);
      console.error('   - Development mode:', __DEV__);
      console.error('   - WebSocket URL:', ipAddress);
      console.error('   - Custom server URL:', customServerUrl);
      
      setConnectionStatus('error');
      const errorMessage = error instanceof Error ? error.message : 'Unknown connection error';
      
      let userMessage = 'Failed to connect to server';
      
      if (errorMessage.includes('timeout')) {
        userMessage = 'Connection timeout. Please check your internet connection and try again.';
      } else if (errorMessage.includes('WebSocket connection failed')) {
        userMessage = 'WebSocket connection failed. Please check server status and try again.';
      } else if (errorMessage.includes('Network request failed')) {
        userMessage = 'Network error. Please check your internet connection.';
      } else if (errorMessage.includes('1006')) {
        userMessage = 'Connection closed abnormally. Please check server status and try again.';
      } else if (errorMessage.includes('1002')) {
        userMessage = 'Protocol error. Please check server configuration.';
      } else {
        userMessage = `Connection error: ${errorMessage}`;
      }
      
      Alert.alert('Connection Error', `${userMessage}\n\nAttempts: ${retryCount + 1}/${maxRetries + 1}`);
      console.error('Connection error:', error);
    }
  };

  const stopRecording = async () => {
    setRecording(false);
    try {
      await stopVoiceRecording();
    } catch {
      // Already handled in stopVoiceRecording
    }
    
    // Close WebSocket after sending audio
    console.log('🔌 Closing WebSocket connection after audio sent...');
    cleanupWebSocket();
  };

  const testNetworkConnectivity = async () => {
    try {
      console.log('🌐 Testing network connectivity...');
      
      // Test different IP addresses using custom server URL and fallbacks
      const testUrls = [
        getCustomPlatformAPIUrl(customServerUrl, '/health'),  // Primary server from Redux
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
      const healthUrl = getCustomPlatformAPIUrl(customServerUrl, '/health');
      console.log('🔍 Testing health endpoint:', healthUrl);
      
      const healthResponse = await fetch(healthUrl);
      const healthData = await healthResponse.json();
      
      console.log('✅ Health check successful:', healthData);
      
      // Then test the transcriptions endpoint
      const transcriptionsUrl = getCustomPlatformAPIUrl(customServerUrl, '/list-transcriptions');
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

  const sendAudioViaWebSocket = async (audioData: string) => {
    // Validate input audio data
    if (!audioData || audioData.length === 0) {
      const error = 'No audio data to send via WebSocket';
      console.log('❌', error);
      throw new Error(error);
    }

    // Validate audio data size (should be reasonable for a recording)
    if (audioData.length < 1000) {
      console.warn('⚠️ Audio data seems very small, may be empty recording');
    }

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      const error = 'WebSocket is not connected, cannot send audio';
      console.error('❌', error);
      Alert.alert('Connection Error', 'WebSocket is not connected. Cannot send audio.');
      throw new Error(error);
    }

    setIsSendingAudio(true);

    try {
      console.log('📤 Sending audio via WebSocket...');
      console.log('📊 Audio size:', audioData.length, 'characters');
      console.log('🔌 WebSocket readyState:', wsRef.current.readyState);
      console.log('🔍 Audio data validation: Valid');
      
      const recordingDuration = Date.now() - (recordingStartTime.current || 0);
      logPerformance(`[CLIENT_SEND_WEBSOCKET] Size:${audioData.length}chars Duration:${recordingDuration}ms`);
      
      // Create audio message with full data
      const audioMessage = {
        type: 'audio',
        data: audioData, // Full audio data
        chunk_id: 0, // Single chunk for full audio
        client_timestamp: Date.now(),
        total_size: audioData.length,
        is_full_audio: true
      };
      
      console.log('📦 Audio message prepared:', {
        type: audioMessage.type,
        chunk_id: audioMessage.chunk_id,
        data_length: audioMessage.data.length,
        total_size: audioMessage.total_size,
        is_full_audio: audioMessage.is_full_audio
      });
      
      // Send with timeout protection
      const sendPromise = new Promise<void>((resolve, reject) => {
        try {
          wsRef.current!.send(JSON.stringify(audioMessage));
          console.log('✅ Audio sent via WebSocket successfully');
          resolve();
        } catch (sendError) {
          reject(sendError);
        }
      });
      
      // Wait for send with timeout
      await Promise.race([
        sendPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Send timeout')), 10000)
        )
      ]);
      
      // Wait for server acknowledgment with timeout
      const ackPromise = new Promise<void>((resolve, reject) => {
        const originalOnMessage = wsRef.current!.onmessage;
        const timeoutId = setTimeout(() => {
          wsRef.current!.onmessage = originalOnMessage;
          reject(new Error('Server acknowledgment timeout'));
        }, 15000);
        
        wsRef.current!.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'audio_received' || message.type === 'error') {
              clearTimeout(timeoutId);
              wsRef.current!.onmessage = originalOnMessage;
              if (message.type === 'error') {
                reject(new Error(`Server error: ${message.message}`));
              } else {
                resolve();
              }
            }
          } catch (parseError) {
            // Continue waiting for valid message
          }
        };
      });
      
      await Promise.race([
        ackPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Server acknowledgment timeout')), 15000)
        )
      ]);
      
      console.log('✅ Server acknowledged audio successfully');
      
      // Verify the audio data was sent correctly
      console.log('🔍 Verifying audio transmission:');
      console.log('   - Original audio size:', audioData.length);
      console.log('   - Audio data in variable:', fullAudioData.current?.length || 0);
      console.log('   - WebSocket still connected:', wsRef.current?.readyState === WebSocket.OPEN);
      
      if (fullAudioData.current && fullAudioData.current.length > 0) {
        console.log('✅ Full audio data confirmed available for future use');
      } else {
        console.warn('⚠️ Audio data variable may be empty');
      }
      
    } catch (error) {
      console.error('❌ Failed to send audio via WebSocket:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Handle specific error types
      if (errorMessage.includes('timeout')) {
        Alert.alert('Send Timeout', 'Server did not respond in time. Please try again.');
      } else if (errorMessage.includes('Server error')) {
        Alert.alert('Server Error', `Server returned an error: ${errorMessage}`);
      } else {
        Alert.alert('Send Error', `Failed to send audio: ${errorMessage}`);
      }
    } finally {
      setIsSendingAudio(false);
    }
  };

  const sendFullAudio = async () => {
    if (!fullAudioData.current || fullAudioData.current.length === 0) {
      Alert.alert('No Audio', 'No audio data to send. Please record audio first.');
      return;
    }

    setIsSendingAudio(true);

    try {
      console.log('📤 Sending full audio to server via HTTP...');
      console.log('📊 Audio size:', fullAudioData.current.length, 'characters');
      
      // Create FormData with base64 data
      const formData = new FormData();
      formData.append('audio_file', {
        uri: `data:audio/wav;base64,${fullAudioData.current}`,
        type: 'audio/wav',
        name: 'recording.wav'
      } as any);
      formData.append('language', 'en');
      
      // Get the API URL
      const apiUrl = getCustomPlatformAPIUrl(customServerUrl, '/transcribe/audio');
      console.log('🌐 Sending to:', apiUrl);
      
      const recordingDuration = Date.now() - (recordingStartTime.current || 0);
      logPerformance(`[CLIENT_SEND_FULL_HTTP] Size:${fullAudioData.current.length}chars Duration:${recordingDuration}ms`);
      
      // Send with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutes timeout
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        body: formData,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        
        // Handle specific HTTP error codes
        switch (response.status) {
          case 408:
            errorMessage = 'Request timeout - file too large or slow connection';
            break;
          case 413:
            errorMessage = 'File too large (max 50MB)';
            break;
          case 504:
            errorMessage = 'Server timeout - audio too long or server overloaded. Please try again.';
            break;
          case 500:
            errorMessage = 'Server internal error - please try again later';
            break;
          case 503:
            errorMessage = 'Server temporarily unavailable - please try again later';
            break;
          default:
            errorMessage = `Server error (${response.status}): ${errorText}`;
        }
        
        throw new Error(errorMessage);
      }
      
      const result = await response.json();
      console.log('✅ Transcription result:', result);
      
      if (result.text) {
        // Add the transcription to Redux
        dispatch(transcriptionActions.addTranscription(result.text));
        Alert.alert('Success', `Transcription received!\n\nText: ${result.text}`);
      } else {
        Alert.alert('No Transcription', 'Server returned no transcription text.');
      }
      
    } catch (error) {
      console.error('❌ Failed to send full audio:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Handle specific error types
      if (error instanceof Error && error.name === 'AbortError') {
        Alert.alert('Request Timeout', 'Request timed out. Please try again with a shorter audio recording.');
      } else if (errorMessage.includes('504')) {
        Alert.alert('Server Timeout', 'Server took too long to process. Please try again with a shorter audio recording.');
      } else if (errorMessage.includes('413')) {
        Alert.alert('File Too Large', 'Audio file is too large. Please record a shorter audio clip.');
      } else if (errorMessage.includes('408')) {
        Alert.alert('Connection Timeout', 'Connection timed out. Please check your internet connection and try again.');
      } else {
        Alert.alert('Send Error', `Failed to send audio: ${errorMessage}`);
      }
    } finally {
      setIsSendingAudio(false);
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

  const sendStoredFullAudio = async () => {
    if (!fullAudioData.current || fullAudioData.current.length === 0) {
      Alert.alert('No Audio', 'No audio data available to send. Please record audio first.');
      return;
    }

    console.log('📤 Manually sending stored full audio...');
    console.log('📊 Stored audio size:', fullAudioData.current.length, 'characters');
    
    try {
      await sendAudioViaWebSocket(fullAudioData.current);
      Alert.alert('Success', 'Stored full audio sent successfully!');
    } catch (error) {
      console.error('❌ Failed to send stored audio:', error);
      handleError(error as Error, 'Stored Audio Send Failed');
      Alert.alert('Send Failed', 'Failed to send stored audio: ' + (error as Error).message);
    }
  };

  const verifyAudioData = () => {
    console.log('🔍 Audio Data Verification:');
    console.log('   - Audio data exists:', !!fullAudioData.current);
    console.log('   - Audio data length:', fullAudioData.current?.length || 0);
    console.log('   - Audio data type:', typeof fullAudioData.current);
    
    if (fullAudioData.current && fullAudioData.current.length > 0) {
      console.log('✅ Audio data is valid and ready to send');
      Alert.alert('Audio Data Status', `Audio data is ready!\nSize: ${fullAudioData.current.length} characters`);
    } else {
      console.log('❌ No audio data available');
      Alert.alert('Audio Data Status', 'No audio data available. Please record audio first.');
    }
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
            {!audioRecordInitialized && (
              <View style={styles.audioStatus}>
                <View style={[styles.statusIndicator, styles.connecting]} />
                <Text style={styles.statusText}>Audio Initializing</Text>
              </View>
            )}
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
                value={serverUrlInput}
                onChangeText={setServerUrlInput}
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
                    dispatch(serverActions.resetServerUrl());
                    setServerUrlInput(DEFAULT_SERVER_URL);
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

        {/* Error Display */}
        {lastError && (
          <View style={styles.errorBar}>
            <View style={styles.errorContent}>
              <Text style={styles.errorText}>⚠️ {lastError}</Text>
              <TouchableOpacity onPress={clearError} style={styles.errorCloseButton}>
                <Text style={styles.errorCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Audio Chunks Sent Counter */}
        {recording && (
          <View style={styles.statsBar}>
            <View style={styles.statItem}>
              <Text style={styles.statLabel}>Audio Chunks Sent:</Text>
              <Text style={styles.statText}>{audioChunksSent}</Text>
            </View>
            {errorCount > 0 && (
              <View style={styles.statItem}>
                <Text style={styles.statLabel}>Errors:</Text>
                <Text style={[styles.statText, { color: '#dc3545' }]}>{errorCount}</Text>
              </View>
            )}
          </View>
        )}

        {/* Main Action Buttons */}
        <View style={styles.buttonGroup}>

          
          {!recording && (
            <View style={styles.testButtonGroup}>
              <TouchableOpacity 
                style={styles.testButton}
                onPress={testDirectServerConnection}
              >
                <Text style={styles.testButtonText}>TEST CONNECTION</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={[styles.testButton, { backgroundColor: '#17a2b8' }]}
                onPress={verifyAudioData}
              >
                <Text style={styles.testButtonText}>VERIFY AUDIO</Text>
              </TouchableOpacity>
              
              {fullAudioData.current && fullAudioData.current.length > 0 && (
                <TouchableOpacity 
                  style={[styles.testButton, { backgroundColor: '#28a745' }]}
                  onPress={sendStoredFullAudio}
                >
                  <Text style={styles.testButtonText}>SEND STORED AUDIO</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
          <TouchableOpacity 
            style={[
              styles.mainButton,
              recording ? styles.stopButton : styles.startButton,
              (!audioRecordInitialized || isSendingAudio) && styles.disabledButton
            ]}
            onPress={recording ? stopRecording : startRecording}
            disabled={!audioRecordInitialized || isSendingAudio}
          >
            {connectionStatus === 'connecting' ? (
              <ActivityIndicator color="#fff" />
            ) : !audioRecordInitialized ? (
              <Text style={styles.buttonText}>INITIALIZING...</Text>
            ) : isSendingAudio ? (
              <>
                <ActivityIndicator color="#fff" style={{marginRight: 10}} />
                <Text style={styles.buttonText}>SENDING AUDIO...</Text>
              </>
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
  audioStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 15,
  },
  statsBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    padding: 16,
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
    justifyContent: 'center',
    flex: 1,
  },
  statLabel: {
    fontSize: 14,
    color: '#6c757d',
    fontWeight: '500',
    marginRight: 8,
  },
  statText: {
    fontSize: 16,
    color: '#495057',
    fontWeight: '600',
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

  disabledButton: {
    backgroundColor: '#6c757d',
    opacity: 0.6,
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
  testButtonGroup: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
    flexWrap: 'wrap',
    gap: 8,
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
  errorBar: {
    backgroundColor: '#f8d7da',
    borderColor: '#f5c6cb',
    borderWidth: 1,
    borderRadius: 8,
    marginHorizontal: 20,
    marginTop: 10,
    padding: 12,
  },
  errorContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  errorText: {
    flex: 1,
    fontSize: 14,
    color: '#721c24',
    fontWeight: '500',
  },
  errorCloseButton: {
    backgroundColor: '#dc3545',
    borderRadius: 12,
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 10,
  },
  errorCloseText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  speakingText: {
    color: '#28a745',
    fontWeight: '700',
  },
  silentText: {
    color: '#6c757d',
    fontWeight: '500',
  },
});