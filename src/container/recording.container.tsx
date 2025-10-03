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
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  FlatList,
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
import {
  transcriptionActions,
  selectTranscriptions,
} from '../redux/transcriptions.redux';
import {selectCustomServerUrl, serverActions} from '../redux/server.redux';
import {selectUsername} from '../redux/user.redux';
import {RootState} from '../redux/store.redux';

// Import GIF assets
const auxlinkBlueGif = require('../asserts/auxlink_blue.gif');
const auxlinkRedGif = require('../asserts/auxlink_red.gif');

// Patient data types
interface Patient {
  patientid: string;
  eventid: string;
  name: string;
  bed: string;
  bedid: string;
  room: string;
  ward: string;
  wardid: string;
  hr: string;
  sp02: string;
  bp: string;
  admission: string;
  age: string;
  gender: string;
  weight: string;
  diagnosis: string;
  nhino: string;
  dischargedate: string;
  ic: string;
  drname: string;
}

interface Ward {
  unitid: string;
  desc: string;
  code: string;
  capacity: string;
}

interface User {
  userid: string;
  loginname: string;
  groupname: string;
  rights: string;
  status: string;
  wards: string;
}

interface PatientListResponse {
  success: boolean;
  message: string;
  username: string;
  timestamp: string;
  summary: {
    total_wards: number;
    total_users: number;
    total_patients: number;
  };
  patient_list: Patient[];
  ward_list: Ward[];
  user_list: User[];
  jwt_token: string;
}
type RecordingContainerProps = CompositeScreenProps<
  BottomTabScreenProps<HomeModuleParamList, 'recording'>,
  NativeStackScreenProps<AppModuleParamList>
>;

export function RecordingContainer(props: RecordingContainerProps) {
  const dispatch = useDispatch();
  const transcriptions = useSelector(selectTranscriptions);
  const customServerUrl = useSelector(selectCustomServerUrl);
  const username = useSelector(selectUsername);

  const [recording, setRecording] = useState(false);
  const [chunks, setChunks] = useState<string[]>([]);
  const [ipAddress, setIpAddress] = useState(
    getCustomPlatformWSUrl(customServerUrl),
  );
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

  // Patient data state
  const [patientData, setPatientData] = useState<PatientListResponse | null>(null);
  const [loadingPatients, setLoadingPatients] = useState(false);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [selectedWard, setSelectedWard] = useState<Ward | null>(null);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<'patients' | 'wards' | 'users'>('patients');
  const [showIndividualModal, setShowIndividualModal] = useState(false);

  // Audio recording state
  const fullAudioData = useRef<string>('');
  const isRecording = useRef<boolean>(false);
  const recordingStartTime = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioPreparationTimeout = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Animation values
  const pulseAnimation = useRef(new Animated.Value(0)).current;
  const recordAnimation = useRef(new Animated.Value(0)).current;
  const waveformAnimations = useRef([
    new Animated.Value(10),
    new Animated.Value(10),
    new Animated.Value(10),
    new Animated.Value(10),
    new Animated.Value(10),
  ]).current;

  const logPerformance = (message: string) => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    console.log(logEntry);
    setPerformanceLogs(prev => [...prev.slice(-50), logEntry]);
  };

  // Start pulse animation
  const startPulseAnimation = () => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnimation, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: false,
        }),
        Animated.timing(pulseAnimation, {
          toValue: 0,
          duration: 1500,
          useNativeDriver: false,
        }),
      ]),
    ).start();
  };

  // Start recording animation
  const startRecordingAnimation = () => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(recordAnimation, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: false,
        }),
        Animated.timing(recordAnimation, {
          toValue: 0,
          duration: 1000,
          useNativeDriver: false,
        }),
      ]),
    ).start();
  };

  // Start waveform animation
  const startWaveformAnimation = () => {
    waveformAnimations.forEach((anim, index) => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: 20,
            duration: 1000,
            delay: index * 200,
            useNativeDriver: false,
          }),
          Animated.timing(anim, {
            toValue: 10,
            duration: 1000,
            useNativeDriver: false,
          }),
        ]),
      ).start();
    });
  };

  // Stop all animations
  const stopAnimations = () => {
    pulseAnimation.stopAnimation();
    recordAnimation.stopAnimation();
    waveformAnimations.forEach(anim => anim.stopAnimation());
  };

  // Get current animation styles
  const getLogoStyle = () => {
    if (recording) {
      return {
        transform: [
          {
            scale: recordAnimation.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 1.1],
            }),
          },
        ],
        shadowOpacity: recordAnimation.interpolate({
          inputRange: [0, 1],
          outputRange: [0.3, 0.8],
        }),
        shadowRadius: recordAnimation.interpolate({
          inputRange: [0, 1],
          outputRange: [10, 20],
        }),
      };
    } else {
      // Always show pulse effect when not recording
      return {
        transform: [
          {
            scale: pulseAnimation.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 1.05],
            }),
          },
        ],
        shadowOpacity: pulseAnimation.interpolate({
          inputRange: [0, 1],
          outputRange: [0.1, 0.4],
        }),
      };
    }
  };

  const getWaveformStyle = (index: number) => {
    return {
      height: waveformAnimations[index].interpolate({
        inputRange: [0, 1],
        outputRange: [10, 20],
      }),
    };
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

  const loadPatientData = async () => {
    try {
      console.log('🏥 Loading patient data from ICU endpoint...');
      setLoadingPatients(true);
      clearError();

      const apiUrl = getCustomPlatformAPIUrl(customServerUrl, '/icu/patient-list');
      
      // Create query parameters for GET request
      const params = new URLSearchParams({
        username: 'tony',
        password: 'icu@123',
        code: '',
        shift_start: '2025-09-26 14:00',
        shift_end: '2025-09-26 22:00',
      });

      const fullUrl = `${apiUrl}?${params.toString()}`;
      console.log('🌐 ICU API URL:', fullUrl);
      console.log('🔧 Custom Server URL:', customServerUrl);
      console.log('🔧 Base API URL:', apiUrl);
      console.log('🔧 Query Params:', params.toString());
      
      // Test with hardcoded URL to verify server is reachable
      const testUrl = 'http://192.168.1.16:8111/icu/patient-list?username=tony&password=icu%40123&code=&shift_start=2025-09-26%2014:00&shift_end=2025-09-26%2022:00';
      console.log('🧪 Test URL:', testUrl);

      let response = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      // If the constructed URL fails, try the hardcoded URL
      if (!response.ok && response.status === 404) {
        console.log('🔄 Constructed URL failed, trying hardcoded URL...');
        response = await fetch(testUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: PatientListResponse = await response.json();
      console.log('✅ Patient data loaded successfully:', data);

      if (data.success) {
        setPatientData(data);
        console.log(`📊 Loaded ${data.summary.total_patients} patients, ${data.summary.total_wards} wards, ${data.summary.total_users} users`);
        Alert.alert(
          'Data Loaded Successfully',
          `Loaded ${data.summary.total_patients} patients, ${data.summary.total_wards} wards, and ${data.summary.total_users} users. You can now select from the options below.`,
        );
      } else {
        throw new Error(data.message || 'Failed to load patient data');
      }
    } catch (error) {
      console.error('❌ Failed to load patient data:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      handleError(errorMessage, 'Patient Data Load Failed');
      Alert.alert(
        'Load Failed',
        `Failed to load patient data: ${errorMessage}`,
      );
    } finally {
      setLoadingPatients(false);
    }
  };

  const selectPatient = (patient: Patient) => {
    setSelectedPatient(patient);
    console.log('👤 Selected patient:', patient.name);
    Alert.alert(
      'Patient Selected',
      `Selected: ${patient.name}\nBed: ${patient.bed}\nRoom: ${patient.room}\nWard: ${patient.ward}`,
    );
  };

  const selectWard = (ward: Ward) => {
    setSelectedWard(ward);
    console.log('🏥 Selected ward:', ward.desc);
    Alert.alert(
      'Ward Selected',
      `Selected: ${ward.desc}\nCode: ${ward.code}\nCapacity: ${ward.capacity}`,
    );
  };

  const selectUser = (user: User) => {
    setSelectedUser(user);
    console.log('👨‍⚕️ Selected user:', user.loginname);
    Alert.alert(
      'User Selected',
      `Selected: ${user.loginname}\nGroup: ${user.groupname}\nStatus: ${user.status}`,
    );
  };


  const openIndividualModal = (type: 'patients' | 'wards' | 'users') => {
    if (!patientData) {
      Alert.alert('No Data', 'Please load ICU data first');
      return;
    }
    setActiveTab(type);
    setShowIndividualModal(true);
  };

  const closeIndividualModal = () => {
    setShowIndividualModal(false);
  };

  const sendStoredFullAudio = async () => {
    if (!fullAudioData.current || fullAudioData.current.length === 0) {
      Alert.alert(
        'No Audio',
        'No audio data available to send. Please record audio first.',
      );
      return;
    }

    console.log('📤 Manually sending stored full audio...');
    console.log(
      '📊 Stored audio size:',
      fullAudioData.current.length,
      'characters',
    );

    try {
      await sendAudioViaWebSocket();
      Alert.alert('Success', 'Stored full audio sent successfully!');
    } catch (error) {
      console.error('❌ Failed to send stored audio:', error);
      handleError(error as Error, 'Stored Audio Send Failed');
      Alert.alert(
        'Send Failed',
        'Failed to send stored audio: ' + (error as Error).message,
      );
    }
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

          // Send initialization message with username
          const initMessage = {
            type: 'init',
            username: username || 'unknown',
          };

          try {
            ws.send(JSON.stringify(initMessage));
            console.log(
              '📤 Sent initialization message with username:',
              username || 'unknown',
            );
          } catch (error) {
            console.error('❌ Failed to send initialization message:', error);
          }

          setWsConnected(true);
          setWsConnecting(false);
          resolve();
        };

        ws.onerror = error => {
          console.error('❌ WebSocket connection error:', error);
          setWsConnected(false);
          setWsConnecting(false);
          reject(new Error('WebSocket connection failed'));
        };

        ws.onclose = event => {
          console.log('🔌 WebSocket closed:', event.code, event.reason);
          setWsConnected(false);
          setWsConnecting(false);
        };

        ws.onmessage = event => {
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
            } else if (message.type === 'initialized') {
              console.log(
                '✅ Server initialized session for user:',
                message.username,
              );
              console.log(
                '📊 Session info - ID:',
                message.session_id,
                'Count:',
                message.session_count,
              );
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
        console.log(
          '📊 Audio size:',
          fullAudioData.current.length,
          'characters',
        );

        // Send audio data with selected ICU information
        const audioMessage = {
          type: 'audio',
          data: fullAudioData.current,
          language: 'en',
          // Include selected ICU data
          patient: selectedPatient ? {
            patientid: selectedPatient.patientid,
            name: selectedPatient.name,
            bed: selectedPatient.bed,
            room: selectedPatient.room,
            ward: selectedPatient.ward,
            age: selectedPatient.age,
            gender: selectedPatient.gender,
            diagnosis: selectedPatient.diagnosis,
            admission: selectedPatient.admission,
            hr: selectedPatient.hr,
            sp02: selectedPatient.sp02,
            bp: selectedPatient.bp,
            weight: selectedPatient.weight,
            nhino: selectedPatient.nhino,
            dischargedate: selectedPatient.dischargedate,
            ic: selectedPatient.ic,
            drname: selectedPatient.drname
          } : null,
          ward: selectedWard ? {
            unitid: selectedWard.unitid,
            desc: selectedWard.desc,
            code: selectedWard.code,
            capacity: selectedWard.capacity
          } : null,
          user: selectedUser ? {
            userid: selectedUser.userid,
            loginname: selectedUser.loginname,
            groupname: selectedUser.groupname,
            rights: selectedUser.rights,
            status: selectedUser.status,
            wards: selectedUser.wards
          } : null,
          // Include username for session tracking
          username: username || 'unknown'
        };

        wsRef.current.send(JSON.stringify(audioMessage));
        console.log('✅ Audio sent via WebSocket');

        // Send end message
        const endMessage = {
          type: 'end',
          session_id: Date.now().toString(),
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

  // Initialize animations
  useEffect(() => {
    startPulseAnimation();
    return () => stopAnimations();
  }, []);

  // Update animations based on recording state
  useEffect(() => {
    if (recording) {
      // Stop pulse and start recording animations
      pulseAnimation.stopAnimation();
      startRecordingAnimation();
      startWaveformAnimation();
    } else {
      // Stop recording animations and restart pulse
      recordAnimation.stopAnimation();
      waveformAnimations.forEach(anim => anim.stopAnimation());
      startPulseAnimation();
    }
  }, [recording]);

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
            console.warn(
              `❌ AudioRecord init attempt ${retryCount} failed:`,
              initError,
            );

            if (retryCount >= maxRetries) {
              throw initError;
            }

            await new Promise(resolve =>
              setTimeout(() => resolve(undefined), 1000 * retryCount),
            );
          }
        }
      } catch (error) {
        console.error(
          '❌ Failed to initialize AudioRecord after all retries:',
          error,
        );
        setAudioRecordInitialized(false);
        Alert.alert(
          'Audio Error',
          'Failed to initialize audio recorder after multiple attempts. Please restart the app.',
        );
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
    console.log(
      '🔄 Transcriptions state updated:',
      transcriptions.length,
      'items',
    );
    if (transcriptions.length > 0) {
      console.log(
        '📝 Latest transcription:',
        transcriptions[transcriptions.length - 1],
      );
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
          Alert.alert(
            'Permission denied',
            'Cannot record audio without permission',
          );
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
      Alert.alert(
        'Recording error',
        'Failed to start audio recording: ' + (error as Error).message,
      );
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
          console.warn(
            '⚠️ Audio file seems very small, may be empty recording',
          );
        }

        // Store the full audio data
        fullAudioData.current = base64Data;

        const recordingDuration =
          Date.now() - (recordingStartTime.current || 0);
        console.log(
          '📁 Full audio stored, size:',
          base64Data.length,
          'characters',
        );
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
          audioPreparationTimeout.current = setTimeout(
            () => resolve(undefined),
            1000,
          );
        });

        console.log('✅ Audio preparation complete, sending via WebSocket...');

        // Send audio via WebSocket only
        try {
          await sendAudioViaWebSocket();
          console.log('✅ Audio sent successfully through WebSocket');
          Alert.alert(
            '✅ Success!',
            'Audio sent to server successfully!\n\n🎤 Recording completed and processed.',
          );
        } catch (wsError) {
          console.error('❌ WebSocket failed:', wsError);
          handleError(wsError as Error, 'WebSocket Audio Send Failed');
          Alert.alert(
            '❌ Send Failed',
            'Failed to send audio via WebSocket. Please check your connection and try again.',
          );
        }
      } catch (error) {
        console.error('❌ Error getting audio data:', error);
        handleError(error as Error, 'Audio Data Error');
        Alert.alert(
          'Recording Error',
          'Failed to get audio data: ' + (error as Error).message,
        );
      } finally {
        setIsSendingAudio(false);
      }

      console.log('✅ Audio recording stopped successfully');
    } catch (error) {
      console.error('❌ Failed to stop audio recording:', error);
      handleError(error as Error, 'Recording Stop Error');
      Alert.alert(
        'Recording error',
        'Failed to stop audio recording: ' + (error as Error).message,
      );
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
        console.log(
          '   🔌 WebSocket object created, readyState:',
          ws.readyState,
        );

        ws.onopen = () => {
          console.log('   ✅ WebSocket CONNECTED!');
          console.log('   🔌 Final readyState:', ws.readyState);

          // Send initialization message with username
          const initMessage = {
            type: 'init',
            username: username || 'unknown',
          };
          ws.send(JSON.stringify(initMessage));
          console.log(
            '   📤 Sent initialization message with username:',
            username || 'unknown',
          );

          // Send a test message
          const testMessage = {
            type: 'ping',
            timestamp: new Date().toISOString(),
          };
          ws.send(JSON.stringify(testMessage));
          console.log('   📤 Sent test ping message');

          Alert.alert(
            'WebSocket Success',
            `Direct WebSocket connection successful!\n\nServer is ready for audio transcription.\nUsername: ${
              username || 'unknown'
            }`,
          );

          // Close after 2 seconds
          setTimeout(() => {
            ws.close();
            console.log('   🔌 Test WebSocket closed');
          }, 2000);
        };

        ws.onmessage = event => {
          console.log('   📨 Received:', event.data);
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'initialized') {
              console.log(
                '   ✅ Server initialized session for user:',
                message.username,
              );
              console.log(
                '   📊 Session info - ID:',
                message.session_id,
                'Count:',
                message.session_count,
              );
            }
          } catch (error) {
            console.log('   📨 Raw message (not JSON):', event.data);
          }
        };

        ws.onerror = error => {
          console.error('   ❌ WebSocket ERROR:', error);
        };

        ws.onclose = event => {
          console.error('   🔌 WebSocket CLOSED:', event.code, event.reason);
        };

        // Timeout after 30 seconds
        setTimeout(() => {
          if (ws.readyState === WebSocket.CONNECTING) {
            console.error('   ⏰ WebSocket TIMEOUT after 30 seconds');
            ws.close();
            Alert.alert(
              'WebSocket Timeout',
              'WebSocket connection timed out after 30 seconds.\n\nCheck:\n1. Server is running\n2. Firewall allows port 8000\n3. Network connectivity\n4. Server WebSocket endpoint is enabled',
            );
          }
        }, 30000);
      } catch (error) {
        console.error('   ❌ WebSocket FAILED:', error);
        Alert.alert(
          'WebSocket Failed',
          `WebSocket connection failed:\n${error}`,
        );
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
      Alert.alert(
        'Audio Not Ready',
        'Audio recorder is still initializing. Please wait a moment and try again.',
      );
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
      console.log(
        '✅ Recording started successfully with WebSocket connection!',
      );
    } catch (error) {
      console.error('❌ START RECORDING PROCESS FAILED:', error);

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown connection error';

      let userMessage = 'Failed to connect to server';

      if (errorMessage.includes('timeout')) {
        userMessage =
          'Connection timeout. Please check your internet connection and try again.';
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
      Alert.alert(
        'Audio Data Status',
        `Audio data is ready!\nSize: ${fullAudioData.current.length} characters`,
      );
    } else {
      console.log('❌ No audio data available');
      Alert.alert(
        'Audio Data Status',
        'No audio data available. Please record audio first.',
      );
    }
  };

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: '#f9f9f9'}}>
      <ScrollView 
        style={{flex: 1}}
        showsVerticalScrollIndicator={true}
        keyboardShouldPersistTaps="handled">
        <KeyboardAvoidingView
          style={{margin: 10, justifyContent: 'center'}}
          behavior="padding">
        {/* Server Configuration */}
        <View
          style={{
            backgroundColor: '#fff',
            padding: 16,
            borderRadius: 10,
            marginHorizontal: 3,
            marginBottom: 20,
            shadowColor: '#000',
            shadowOffset: {width: 0, height: 2},
            shadowOpacity: 0.1,
            shadowRadius: 4,
            elevation: 2,
          }}>
            
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}>
            <Text style={{fontSize: 16, fontWeight: '600', color: '#212529'}}>
              Server Configuration
            </Text>
            
            <TouchableOpacity
              onPress={() => setShowServerInput(!showServerInput)}
              style={{
                backgroundColor: '#6c757d',
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
              }}>
              <Text style={{color: '#fff', fontSize: 12, fontWeight: '500'}}>
                {showServerInput ? 'Hide' : 'Change'}
              </Text>
            </TouchableOpacity>
          </View>
               <Text
            style={{fontSize: 12, color: '#6c757d', fontFamily: 'monospace',   marginBottom: 10,}}>
            Current: {customServerUrl}
          </Text>

          {showServerInput && (
            <View style={{marginBottom: 8}}>
              <TextInput
                style={{
                  backgroundColor: '#f8f9fa',
                  borderWidth: 1,
                  borderColor: '#dee2e6',
                  borderRadius: 6,
                  padding: 10,
                  fontSize: 14,
                  color: '#212529',
                  marginBottom: 8,
                }}
                placeholder="Enter server URL (e.g., vc2txt.quantosaas.com)"
                placeholderTextColor="#999"
                value={serverUrlInput}
                onChangeText={setServerUrlInput}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={{flexDirection: 'row', gap: 8}}>
                <TouchableOpacity
                  onPress={updateServerUrl}
                  style={{
                    backgroundColor: '#007bff',
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    borderRadius: 6,
                    flex: 1,
                    alignItems: 'center',
                  }}>
                  <Text
                    style={{color: '#fff', fontSize: 12, fontWeight: '500'}}>
                    Update
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    dispatch(serverActions.resetServerUrl());
                    setServerUrlInput(DEFAULT_SERVER_URL);
                  }}
                  style={{
                    backgroundColor: '#6c757d',
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    borderRadius: 6,
                    flex: 1,
                    alignItems: 'center',
                  }}>
                  <Text
                    style={{color: '#fff', fontSize: 12, fontWeight: '500'}}>
                    Reset
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

     
        </View>

        {/* Test Buttons */}
        <View style={{marginBottom: 20, gap: 10}}>
          <TouchableOpacity
            style={{
              backgroundColor: '#6c757d',
              paddingVertical: 12,
              paddingHorizontal: 20,
              borderRadius: 10,
            }}
            onPress={testWebSocketConnection}>
            <Text
              style={{
                color: '#fff',
                fontSize: 14,
                fontWeight: '600',
                textAlign: 'center',
              }}>
              Test WebSocket Connection
            </Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={{
              backgroundColor: '#007bff',
              paddingVertical: 12,
              paddingHorizontal: 20,
              borderRadius: 10,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onPress={loadPatientData}
            disabled={loadingPatients}>
            {loadingPatients ? (
              <ActivityIndicator size="small" color="#fff" style={{marginRight: 8}} />
            ) : null}
            <Text
              style={{
                color: '#fff',
                fontSize: 14,
                fontWeight: '600',
                textAlign: 'center',
              }}>
              {loadingPatients ? 'Loading Patients...' : 'Load ICU Patients'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ICU Selection Buttons - Only show when data is loaded */}
        {patientData && (
          <View style={{marginBottom: 20, gap: 10}}>
            <Text style={{fontSize: 16, fontWeight: '600', color: '#333', textAlign: 'center', marginBottom: 10}}>
              Select ICU Data
            </Text>
            
            <TouchableOpacity
              style={{
                backgroundColor: '#e3f2fd',
                paddingVertical: 15,
                paddingHorizontal: 20,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: '#2196f3',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
              onPress={() => openIndividualModal('patients')}>
              <View style={{flexDirection: 'row', alignItems: 'center'}}>
                <Text style={{fontSize: 24, marginRight: 10}}>👤</Text>
                <View>
                  <Text style={{fontSize: 16, fontWeight: '600', color: '#1976d2'}}>
                    Select Patient
                  </Text>
                  <Text style={{fontSize: 12, color: '#666'}}>
                    {patientData.summary.total_patients} patients available
                  </Text>
                </View>
              </View>
              <Text style={{fontSize: 16, color: '#1976d2'}}>→</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{
                backgroundColor: '#e8f5e8',
                paddingVertical: 15,
                paddingHorizontal: 20,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: '#4caf50',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
              onPress={() => openIndividualModal('wards')}>
              <View style={{flexDirection: 'row', alignItems: 'center'}}>
                <Text style={{fontSize: 24, marginRight: 10}}>🏥</Text>
                <View>
                  <Text style={{fontSize: 16, fontWeight: '600', color: '#2e7d32'}}>
                    Select Ward
                  </Text>
                  <Text style={{fontSize: 12, color: '#666'}}>
                    {patientData.summary.total_wards} wards available
                  </Text>
                </View>
              </View>
              <Text style={{fontSize: 16, color: '#2e7d32'}}>→</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{
                backgroundColor: '#fff3e0',
                paddingVertical: 15,
                paddingHorizontal: 20,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: '#ff9800',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
              onPress={() => openIndividualModal('users')}>
              <View style={{flexDirection: 'row', alignItems: 'center'}}>
                <Text style={{fontSize: 24, marginRight: 10}}>👨‍⚕️</Text>
                <View>
                  <Text style={{fontSize: 16, fontWeight: '600', color: '#f57c00'}}>
                    Select User
                  </Text>
                  <Text style={{fontSize: 12, color: '#666'}}>
                    {patientData.summary.total_users} users available
                  </Text>
                </View>
              </View>
              <Text style={{fontSize: 16, color: '#f57c00'}}>→</Text>
            </TouchableOpacity>

            {/* Selected Items Summary */}
            <View
              style={{
                padding: 15,
                backgroundColor: '#f8f9fa',
                borderRadius: 10,
                borderWidth: 1,
                borderColor: '#e0e0e0',
                marginTop: 10,
              }}>
              <Text style={{fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 8}}>
                Selected Items:
              </Text>
              <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 8}}>
                {selectedPatient && (
                  <View
                    style={{
                      backgroundColor: '#e3f2fd',
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 15,
                      borderWidth: 1,
                      borderColor: '#2196f3',
                    }}>
                    <Text style={{fontSize: 12, color: '#1976d2', fontWeight: '500'}}>
                      👤 {selectedPatient.name}
                    </Text>
                  </View>
                )}
                {selectedWard && (
                  <View
                    style={{
                      backgroundColor: '#e8f5e8',
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 15,
                      borderWidth: 1,
                      borderColor: '#4caf50',
                    }}>
                    <Text style={{fontSize: 12, color: '#2e7d32', fontWeight: '500'}}>
                      🏥 {selectedWard.desc}
                    </Text>
                  </View>
                )}
                {selectedUser && (
                  <View
                    style={{
                      backgroundColor: '#fff3e0',
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 15,
                      borderWidth: 1,
                      borderColor: '#ff9800',
                    }}>
                    <Text style={{fontSize: 12, color: '#f57c00', fontWeight: '500'}}>
                      👨‍⚕️ {selectedUser.loginname}
                    </Text>
                  </View>
                )}
              </View>
              {!selectedPatient && !selectedWard && !selectedUser && (
                <Text style={{fontSize: 12, color: '#666', fontStyle: 'italic'}}>
                  No items selected
                </Text>
              )}
            </View>
          </View>
        )}

        {/* Error Display */}
        {lastError && (
          <View
            style={{
              backgroundColor: '#f8d7da',
              borderColor: '#f5c6cb',
              borderWidth: 1,
              borderRadius: 8,
              marginHorizontal: 20,
              marginBottom: 20,
              padding: 12,
            }}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
              <Text
                style={{
                  flex: 1,
                  fontSize: 14,
                  color: '#721c24',
                  fontWeight: '500',
                }}>
                ⚠️ {lastError}
              </Text>
              <TouchableOpacity
                onPress={clearError}
                style={{
                  backgroundColor: '#dc3545',
                  borderRadius: 12,
                  width: 24,
                  height: 24,
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginLeft: 10,
                }}>
                <Text style={{color: '#fff', fontSize: 12, fontWeight: 'bold'}}>
                  ✕
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Username Display */}
        {username && (
          <View style={{alignItems: 'center', marginBottom: 20}}>
            <Text style={{fontSize: 16, color: '#0066cc', fontWeight: '600'}}>
              Welcome, {username}!
            </Text>
          </View>
        )}

        {/* Main Logo Button */}
        <View
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 30,
          }}>
          <TouchableOpacity
            style={{
              width: 150,
              height: 150,
              borderRadius: 75,
              backgroundColor: '#fff',
              alignItems: 'center',
              justifyContent: 'center',
                             shadowColor: recording
                 ? '#8B0000'  // Darker red
                 : '#0b37e9ff',  // Darker blue
               
              shadowOffset: {width: 0, height: 0},
              shadowOpacity: recording
                ? 0.8
                : !audioRecordInitialized
                ? 0.7
                : 0.5,
              shadowRadius: recording ? 20 : !audioRecordInitialized ? 15 : 15,
              elevation: recording ? 13 : !audioRecordInitialized ? 11 : 10,
            }}
            onPress={recording ? stopRecording : startRecording}
            disabled={!audioRecordInitialized || isSendingAudio}
          >
            <Animated.View
              style={[
                {
                  width: '100%',
                  height: '100%',
                  borderRadius: 75,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: '#fff',
                  overflow: 'hidden',
                },
                getLogoStyle(),
              ]}>
              {!audioRecordInitialized ? (
                <Text style={{fontSize: 60}}>⏳</Text>
              ) : (
                <View style={{alignItems: 'center'}}>
                  <Image
                    source={require('../asserts/aixelink-logo.png')}
                    style={{
                      width: 40, // set fixed size instead of % for consistent rendering
                      height: 40,
                      borderRadius: 40, // half of width/height for circle
                      marginBottom: 8, // space between image and text
                    }}
                    resizeMode="cover"
                  />

                  <Text
                    style={{
                      fontSize: 18,
                      color: '#28308bff',
                      textShadowColor: '#063160',
                      // textShadowOffset: {width: 1, height: 1},
                      textShadowRadius: 1,
                      zIndex: 1,
                    }}>
                    Aixelink
                  </Text>
                </View>
              )}
            </Animated.View>
          </TouchableOpacity>
        </View>



        {/* Status Text */}
        <View style={{alignItems: 'center', marginBottom: 20}}>
          <Text
            style={{
              fontSize: 18,
              color: '#555',
              textAlign: 'center',
              fontWeight: '500',
            }}>
            {!audioRecordInitialized
              ? 'Initializing...'
              : recording
              ? 'Recording... Tap to stop.'
              : isSendingAudio
              ? 'Sending audio...'
              : 'Tap to start recording'}
          </Text>
        </View>

    

        {/* Connection Status */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-around',
            width: '100%',
            paddingHorizontal: 20,
            marginBottom: 20,
          }}>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            <View
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                marginRight: 8,
                backgroundColor: audioRecordInitialized ? '#28a745' : '#ffc107',
              }}
            />
            <Text style={{fontSize: 12, color: '#666'}}>
              Audio: {audioRecordInitialized ? 'Ready' : 'Initializing'}
            </Text>
          </View>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            <View
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                marginRight: 8,
                backgroundColor: wsConnected
                  ? '#28a745'
                  : wsConnecting
                  ? '#ffc107'
                  : '#dc3545',
              }}
            />
            <Text style={{fontSize: 12, color: '#666'}}>
              Server:{' '}
              {wsConnected
                ? 'Connected'
                : wsConnecting
                ? 'Connecting...'
                : 'Disconnected'}
            </Text>
          </View>
        </View>


        {/* Individual Selection Modal */}
        <Modal
          visible={showIndividualModal}
          animationType="slide"
          transparent={true}
          onRequestClose={closeIndividualModal}>
          <View
            style={{
              flex: 1,
              backgroundColor: 'rgba(0,0,0,0.5)',
              justifyContent: 'flex-end',
            }}>
            <View
              style={{
                backgroundColor: '#fff',
                borderTopLeftRadius: 20,
                borderTopRightRadius: 20,
                maxHeight: '80%',
                minHeight: '60%',
              }}>
              {/* Modal Header */}
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: 20,
                  borderBottomWidth: 1,
                  borderBottomColor: '#e0e0e0',
                }}>
                <Text
                  style={{
                    fontSize: 18,
                    fontWeight: '600',
                    color: '#333',
                  }}>
                  Select {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
                </Text>
                <TouchableOpacity
                  onPress={closeIndividualModal}
                  style={{
                    backgroundColor: '#dc3545',
                    borderRadius: 15,
                    width: 30,
                    height: 30,
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}>
                  <Text style={{color: '#fff', fontSize: 16, fontWeight: 'bold'}}>
                    ×
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Content based on active tab */}
              <View style={{flex: 1}}>
                {activeTab === 'patients' && (
                  <FlatList
                    data={patientData?.patient_list || []}
                    keyExtractor={(item) => item.patientid}
                    style={{flex: 1}}
                    renderItem={({item}) => (
                      <TouchableOpacity
                        style={{
                          padding: 15,
                          borderBottomWidth: 1,
                          borderBottomColor: '#f0f0f0',
                          backgroundColor: selectedPatient?.patientid === item.patientid ? '#e3f2fd' : '#fff',
                        }}
                        onPress={() => {
                          selectPatient(item);
                          closeIndividualModal();
                        }}>
                        <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start'}}>
                          <View style={{flex: 1}}>
                            <Text
                              style={{
                                fontSize: 16,
                                fontWeight: '600',
                                color: '#333',
                                marginBottom: 4,
                              }}>
                              {item.name || 'Unknown Patient'}
                            </Text>
                            <Text style={{fontSize: 14, color: '#666', marginBottom: 2}}>
                              Bed: {item.bed} • Room: {item.room}
                            </Text>
                            <Text style={{fontSize: 12, color: '#888'}}>
                              Ward: {item.ward} • Age: {item.age} • Gender: {item.gender}
                            </Text>
                            {item.diagnosis && (
                              <Text style={{fontSize: 12, color: '#666', marginTop: 4, fontStyle: 'italic'}}>
                                Diagnosis: {item.diagnosis}
                              </Text>
                            )}
                          </View>
                          {selectedPatient?.patientid === item.patientid && (
                            <View
                              style={{
                                backgroundColor: '#28a745',
                                borderRadius: 10,
                                paddingHorizontal: 8,
                                paddingVertical: 4,
                              }}>
                              <Text style={{color: '#fff', fontSize: 12, fontWeight: '600'}}>
                                SELECTED
                              </Text>
                            </View>
                          )}
                        </View>
                      </TouchableOpacity>
                    )}
                    ListEmptyComponent={
                      <View style={{padding: 20, alignItems: 'center'}}>
                        <Text style={{fontSize: 16, color: '#666'}}>
                          No patients found
                        </Text>
                      </View>
                    }
                  />
                )}

                {activeTab === 'wards' && (
                  <FlatList
                    data={patientData?.ward_list || []}
                    keyExtractor={(item) => item.unitid}
                    style={{flex: 1}}
                    renderItem={({item}) => (
                      <TouchableOpacity
                        style={{
                          padding: 15,
                          borderBottomWidth: 1,
                          borderBottomColor: '#f0f0f0',
                          backgroundColor: selectedWard?.unitid === item.unitid ? '#e3f2fd' : '#fff',
                        }}
                        onPress={() => {
                          selectWard(item);
                          closeIndividualModal();
                        }}>
                        <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start'}}>
                          <View style={{flex: 1}}>
                            <Text
                              style={{
                                fontSize: 16,
                                fontWeight: '600',
                                color: '#333',
                                marginBottom: 4,
                              }}>
                              {item.desc || 'Unknown Ward'}
                            </Text>
                            <Text style={{fontSize: 14, color: '#666', marginBottom: 2}}>
                              Code: {item.code} • Capacity: {item.capacity}
                            </Text>
                            <Text style={{fontSize: 12, color: '#888'}}>
                              Unit ID: {item.unitid}
                            </Text>
                          </View>
                          {selectedWard?.unitid === item.unitid && (
                            <View
                              style={{
                                backgroundColor: '#28a745',
                                borderRadius: 10,
                                paddingHorizontal: 8,
                                paddingVertical: 4,
                              }}>
                              <Text style={{color: '#fff', fontSize: 12, fontWeight: '600'}}>
                                SELECTED
                              </Text>
                            </View>
                          )}
                        </View>
                      </TouchableOpacity>
                    )}
                    ListEmptyComponent={
                      <View style={{padding: 20, alignItems: 'center'}}>
                        <Text style={{fontSize: 16, color: '#666'}}>
                          No wards found
                        </Text>
                      </View>
                    }
                  />
                )}

                {activeTab === 'users' && (
                  <FlatList
                    data={patientData?.user_list || []}
                    keyExtractor={(item) => item.userid}
                    style={{flex: 1}}
                    renderItem={({item}) => (
                      <TouchableOpacity
                        style={{
                          padding: 15,
                          borderBottomWidth: 1,
                          borderBottomColor: '#f0f0f0',
                          backgroundColor: selectedUser?.userid === item.userid ? '#e3f2fd' : '#fff',
                        }}
                        onPress={() => {
                          selectUser(item);
                          closeIndividualModal();
                        }}>
                        <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start'}}>
                          <View style={{flex: 1}}>
                            <Text
                              style={{
                                fontSize: 16,
                                fontWeight: '600',
                                color: '#333',
                                marginBottom: 4,
                              }}>
                              {item.loginname || 'Unknown User'}
                            </Text>
                            <Text style={{fontSize: 14, color: '#666', marginBottom: 2}}>
                              Group: {item.groupname} • Status: {item.status}
                            </Text>
                            <Text style={{fontSize: 12, color: '#888'}}>
                              User ID: {item.userid} • Rights: {item.rights}
                            </Text>
                            {item.wards && (
                              <Text style={{fontSize: 12, color: '#666', marginTop: 4, fontStyle: 'italic'}}>
                                Wards: {item.wards}
                              </Text>
                            )}
                          </View>
                          {selectedUser?.userid === item.userid && (
                            <View
                              style={{
                                backgroundColor: '#28a745',
                                borderRadius: 10,
                                paddingHorizontal: 8,
                                paddingVertical: 4,
                              }}>
                              <Text style={{color: '#fff', fontSize: 12, fontWeight: '600'}}>
                                SELECTED
                              </Text>
                            </View>
                          )}
                        </View>
                      </TouchableOpacity>
                    )}
                    ListEmptyComponent={
                      <View style={{padding: 20, alignItems: 'center'}}>
                        <Text style={{fontSize: 16, color: '#666'}}>
                          No users found
                        </Text>
                      </View>
                    }
                  />
                )}
              </View>
            </View>
          </View>
        </Modal>
        </KeyboardAvoidingView>
      </ScrollView>
    </SafeAreaView>
  );
}
