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
import {getCustomPlatformWSUrl, DEFAULT_SERVER_URL} from '../utils/serverUtils';
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
  const [ipAddress, setIpAddress] = useState(getCustomPlatformWSUrl(customServerUrl));
  const [showServerInput, setShowServerInput] = useState(false);
  const [serverUrlInput, setServerUrlInput] = useState(customServerUrl);
  const [audioChunksSent, setAudioChunksSent] = useState(0);
  const [performanceLogs, setPerformanceLogs] = useState<string[]>([]);
  const [audioRecordInitialized, setAudioRecordInitialized] = useState(false);
  const [isSendingAudio, setIsSendingAudio] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [errorCount, setErrorCount] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [wsConnecting, setWsConnecting] = useState(false);

  // Audio recording state
  const fullAudioData = useRef<string>('');
  const isRecording = useRef<boolean>(false);
  const recordingStartTime = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioPreparationTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const logPerformance = (message: string) => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    console.log(logEntry);
    setPerformanceLogs(prev => [...prev.slice(-50), logEntry]);
  };

  const handleError = (error: Error | string, context: string = 'Unknown') => {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const fullError = `${context}: ${errorMessage}`;
    
    console.error(`❌ ${fullError}`);
    setLastError(fullError);
    setErrorCount(prev => prev + 1);
    
    logPerformance(`[ERROR] ${fullError}`);
    
    return fullError;
  };

  const clearError = () => {
    setLastError(null);
    setErrorCount(0);
  };

  const connectWebSocket = async (): Promise<void> => {
    return new Promise((resolve, reject) => {
      try {
        console.log('🔌 Connecting to WebSocket...');
        setWsConnecting(true);
        setWsConnected(false);
        
        const wsUrl = getCustomPlatformWSUrl(customServerUrl);
        console.log('🌐 WebSocket URL:', wsUrl);
        
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        
        ws.onopen = () => {
          console.log('✅ WebSocket connected successfully');
          setWsConnected(true);
          setWsConnecting(false);
          resolve();
        };
        
        ws.onerror = (error) => {
          console.error('❌ WebSocket connection error:', error);
          setWsConnected(false);
          setWsConnecting(false);
          reject(new Error('WebSocket connection failed'));
        };
        
        ws.onclose = (event) => {
          console.log('🔌 WebSocket closed:', event.code, event.reason);
          setWsConnected(false);
          setWsConnecting(false);
        };
        
        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            console.log('📨 WebSocket message received:', message);
            
            if (message.type === 'transcription') {
              // Handle real-time transcription updates
              if (message.text) {
                dispatch(transcriptionActions.addTranscription(message.text));
              }
            } else if (message.type === 'audio_received') {
              console.log('✅ Server acknowledged audio chunk:', message.chunk);
            } else if (message.type === 'session_complete') {
              console.log('✅ Session completed on server side');
            }
          } catch (error) {
            console.error('❌ Error parsing WebSocket message:', error);
          }
        };
        
        // Timeout after 10 seconds
        setTimeout(() => {
          if (ws.readyState === WebSocket.CONNECTING) {
            ws.close();
            setWsConnected(false);
            setWsConnecting(false);
            reject(new Error('WebSocket connection timeout'));
          }
        }, 10000);
        
      } catch (error) {
        console.error('❌ WebSocket connection failed:', error);
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
        console.log('🔌 WebSocket disconnected');
      } catch (error) {
        console.warn('Error during WebSocket cleanup:', error);
      }
    }
  };

  const sendAudioViaWebSocket = async (): Promise<void> => {
    return new Promise((resolve, reject) => {
      try {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          throw new Error('WebSocket not connected');
        }
        
        if (!fullAudioData.current || fullAudioData.current.length === 0) {
          throw new Error('No audio data to send');
        }
        
        console.log('📤 Sending full audio via WebSocket...');
        console.log('📊 Audio size:', fullAudioData.current.length, 'characters');
        
        // Send audio data
        const audioMessage = {
          type: 'audio',
          data: fullAudioData.current,
          language: 'en'
        };
        
        wsRef.current.send(JSON.stringify(audioMessage));
        console.log('✅ Audio sent via WebSocket');
        
        // Send end message
        const endMessage = {
          type: 'end',
          session_id: Date.now().toString()
        };
        
        wsRef.current.send(JSON.stringify(endMessage));
        console.log('✅ End message sent');
        
        // Wait a moment for server to process, then close connection
        setTimeout(() => {
          disconnectWebSocket();
          resolve();
        }, 2000);
        
      } catch (error) {
        console.error('❌ Failed to send audio via WebSocket:', error);
        disconnectWebSocket();
        reject(error);
      }
    });
  };

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
      disconnectWebSocket();
      if (audioPreparationTimeout.current) {
        clearTimeout(audioPreparationTimeout.current);
      }
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
        console.log('📁 Full audio stored, size:', base64Data.length, 'characters');
        console.log('⏱️ Recording duration:', recordingDuration, 'ms');
        console.log('🔍 Audio data validation: OK');
        
        // Verify the audio data is properly stored
        if (fullAudioData.current !== base64Data) {
          throw new Error('Audio data not properly stored in variable');
        }
        
        console.log('✅ Audio data verified and stored');
        
        // Wait for audio preparation (give time for file system operations)
        console.log('⏳ Waiting for audio preparation...');
        setIsSendingAudio(true);
        
        // Wait 1 second for audio preparation
        await new Promise(resolve => {
          audioPreparationTimeout.current = setTimeout(resolve, 1000);
        });
        
        console.log('✅ Audio preparation complete, sending via WebSocket...');
        
        // Send audio via WebSocket only
        try {
          await sendAudioViaWebSocket();
          console.log('✅ Audio sent successfully through WebSocket');
          Alert.alert('✅ Success!', 'Audio sent to server successfully!\n\n🎤 Recording completed and processed.');
          
        } catch (wsError) {
          console.error('❌ WebSocket failed:', wsError);
          handleError(wsError as Error, 'WebSocket Audio Send Failed');
          Alert.alert('❌ Send Failed', 'Failed to send audio via WebSocket. Please check your connection and try again.');
        }
        
      } catch (error) {
        console.error('❌ Error getting audio data:', error);
        handleError(error as Error, 'Audio Data Error');
        Alert.alert('Recording Error', 'Failed to get audio data: ' + (error as Error).message);
      } finally {
        setIsSendingAudio(false);
      }
      
      console.log('✅ Audio recording stopped successfully');
    } catch (error) {
      console.error('❌ Failed to stop audio recording:', error);
      handleError(error as Error, 'Recording Stop Error');
      Alert.alert('Recording error', 'Failed to stop audio recording: ' + (error as Error).message);
      setIsSendingAudio(false);
    }
  };

  const testWebSocketConnection = async () => {
    try {
      console.log('🔍 WEBSOCKET CONNECTION TEST STARTING...');
      
      // Test WebSocket Connection
      console.log('📡 Testing WebSocket Connection');
      const wsUrl = getCustomPlatformWSUrl(customServerUrl);
      console.log('   URL:', wsUrl);
      
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
          console.error('   ❌ WebSocket ERROR:', error);
        };
        
        ws.onclose = (event) => {
          console.error('   🔌 WebSocket CLOSED:', event.code, event.reason);
        };
        
        // Timeout after 30 seconds
        setTimeout(() => {
          if (ws.readyState === WebSocket.CONNECTING) {
            console.error('   ⏰ WebSocket TIMEOUT after 30 seconds');
            ws.close();
            Alert.alert('WebSocket Timeout', 'WebSocket connection timed out after 30 seconds.\n\nCheck:\n1. Server is running\n2. Firewall allows port 8000\n3. Network connectivity\n4. Server WebSocket endpoint is enabled');
          }
        }, 30000);
        
      } catch (error) {
        console.error('   ❌ WebSocket FAILED:', error);
        Alert.alert('WebSocket Failed', `WebSocket connection failed:\n${error}`);
      }
      
    } catch (error) {
      console.error('❌ WebSocket test error:', error);
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



  const startRecording = async () => {
    console.log('🎙️ START RECORDING PROCESS BEGINNING...');
    console.log('📱 Platform:', Platform.OS);
    console.log('🔧 Development mode:', __DEV__);
    console.log('🌐 Custom server URL:', customServerUrl);
    
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

    try {
      console.log('🔌 Connecting to WebSocket before starting recording...');
      
      // Connect to WebSocket first
      await connectWebSocket();
      console.log('✅ WebSocket connected successfully');
      
      // Start recording
      console.log('🎙️ Starting audio recording...');
      setChunks([]);
      setAudioChunksSent(0);
      dispatch(transcriptionActions.clearTranscriptions());
      setRecording(true);
      await startVoiceRecording();
      console.log('✅ Recording started successfully with WebSocket connection!');

    } catch (error) {
      console.error('❌ START RECORDING PROCESS FAILED:', error);
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown connection error';
      
      let userMessage = 'Failed to connect to server';
      
      if (errorMessage.includes('timeout')) {
        userMessage = 'Connection timeout. Please check your internet connection and try again.';
      } else if (errorMessage.includes('Network request failed')) {
        userMessage = 'Network error. Please check your internet connection.';
      } else {
        userMessage = `Connection error: ${errorMessage}`;
      }
      
      Alert.alert('Connection Error', userMessage);
      console.error('Connection error:', error);
      
      // Clean up any partial connection
      disconnectWebSocket();
    }
  };

  const stopRecording = async () => {
    setRecording(false);
    try {
      await stopVoiceRecording();
    } catch {
      // Already handled in stopVoiceRecording
    }
    
    console.log('✅ Recording stopped, audio sent via WebSocket');
  };







  const saveCurrentTranscriptions = async () => {
    if (transcriptions.length === 0) {
      return;
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
            {!audioRecordInitialized && (
              <View style={styles.audioStatus}>
                <View style={[styles.statusIndicator, styles.connecting]} />
                <Text style={styles.statusText}>Audio Initializing</Text>
              </View>
            )}
            {wsConnecting && (
              <View style={styles.audioStatus}>
                <View style={[styles.statusIndicator, styles.connecting]} />
                <Text style={styles.statusText}>Connecting...</Text>
              </View>
            )}
            {wsConnected && (
              <View style={styles.audioStatus}>
                <View style={[styles.statusIndicator, styles.connected]} />
                <Text style={styles.statusText}>Connected</Text>
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

        {/* Main Action Buttons */}
        <View style={styles.buttonGroup}>
          {!recording && (
            <TouchableOpacity 
              style={[styles.testButton]}
              onPress={testWebSocketConnection}
            >
              <Text style={styles.testButtonText}>TEST WEBSOCKET</Text>
            </TouchableOpacity>
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
            {!audioRecordInitialized ? (
              <Text style={styles.buttonText}>INITIALIZING...</Text>
            ) : isSendingAudio ? (
              <>
                <ActivityIndicator color="#fff" style={{marginRight: 10}} />
                <Text style={styles.buttonText}>SENDING AUDIO...</Text>
              </>
            ) : (
              <>
                <Text style={styles.buttonText}>
                  {recording ? 'STOP RECORDING' : 'START RECORDING'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Transcription List */}
        <View style={styles.transcriptionHeader}>
          <Text style={styles.sectionTitle}>Transcriptions</Text>
          {transcriptions.length > 0 && (
            <TouchableOpacity onPress={saveCurrentTranscriptions} style={styles.saveButton}>
              <Text style={styles.saveButtonText}>Save</Text>
            </TouchableOpacity>
          )}
        </View>

        <ScrollView style={styles.transcriptionList} contentContainerStyle={styles.transcriptionContent}>
          {transcriptions.length > 0 ? (
            transcriptions.map((transcription, index) => (
              <View key={index} style={styles.transcriptionItem}>
                <View style={styles.itemBullet} />
                <Text style={styles.transcriptionText}>{transcription}</Text>
              </View>
            ))
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No transcriptions yet</Text>
              <Text style={styles.emptySubtext}>Start recording to see transcriptions here</Text>
            </View>
          )}
        </ScrollView>
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
    textAlign: 'center',
    justifyContent:'center'
    
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
  sendButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#28a745',
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: 10,
    marginHorizontal: 20,
    marginTop: 10,
    marginBottom: 15,
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
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