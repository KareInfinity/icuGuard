import React, {useRef, useState} from 'react';
import {
  View,
  Button,
  PermissionsAndroid,
  Platform,
  Text,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  StyleSheet,
  Alert,
} from 'react-native';
import AudioRecord from 'react-native-audio-record';
import RNFS from 'react-native-fs';

let chunkCounter = 0;

export default function App() {
  const [recording, setRecording] = useState(false);
  const [chunks, setChunks] = useState<string[]>([]);
  const [transcriptions, setTranscriptions] = useState<string[]>([]);
  const [ipAddress, setIpAddress] = useState('ws://vc2txt.quantosaas.com'); // Default IP:Port/ input

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

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
      initRecorder(filename);
      await AudioRecord.start();
    } catch (error) {
      Alert.alert('Recording error', 'Failed to start recording: ' + (error as Error).message);
    }
  };

  const stopChunkRecording = async () => {
    try {
      const file = await AudioRecord.stop();
      setChunks(prev => [...prev, file]);
      chunkCounter++;

      const base64Data = await RNFS.readFile(file, 'base64');

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'audio',
            data: base64Data,
          }),
        );
      }
      return file;
    } catch (error) {
      Alert.alert('Recording error', 'Failed to stop recording or send chunk: ' + (error as Error).message);
      throw error; // rethrow if you want to handle it upstream
    }
  };

  const startRecording = async () => {
    const granted = await requestPermission();
    if (!granted) return;

    try {
      let wsUrl =
        ipAddress.startsWith('ws://') || ipAddress.startsWith('wss://')
          ? ipAddress
          : `ws://${ipAddress}`;

      if (!wsUrl.endsWith('/ws/transcribe')) {
        wsUrl = wsUrl.replace(/\/$/, '') + '/ws/transcribe';
      }

      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = async () => {
        console.log('✅ WebSocket connected to', wsUrl);
        chunkCounter = 0;
        setChunks([]);
        setTranscriptions([]);
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
        }, 2000);
      };

      wsRef.current.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'transcription') {
            setTranscriptions(prev => [...prev, message.text]);
          }
        } catch (e) {
          Alert.alert('WebSocket error', 'Failed to parse message from server');
        }
      };

      wsRef.current.onerror = e => {
        Alert.alert('WebSocket error', 'WebSocket connection error occurred.');
        console.error('WebSocket error:', e);
      };

      wsRef.current.onclose = () => {
        console.log('WebSocket closed');
      };
    } catch (error) {
      Alert.alert('Connection error', 'Failed to connect WebSocket: ' + (error as Error).message);
    }
  };

  const stopRecording = async () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    try {
      await stopChunkRecording();
    } catch {
      // Already handled in stopChunkRecording
    }

    setRecording(false);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({type: 'end'}));
      wsRef.current.close();
      wsRef.current = null;
    }
  };

  return (
    <KeyboardAvoidingView style={{flex: 1}} behavior="padding">
      <View
        style={{
          padding: 20,
          flex: 1,
          justifyContent: 'flex-start',
          alignItems: 'center',
          backgroundColor: '#fff',
        }}>
        {/* <Text style={{marginBottom: 8, fontWeight: 'bold'}}>Enter Server IP and Port:</Text> */}
        {/* <TextInput
          style={styles.input}
          value={ipAddress}
          onChangeText={setIpAddress}
          placeholder="e.g. 192.168.1.3:8000"
          editable={!recording}
          keyboardType="default"
          autoCapitalize="none"
          autoCorrect={false}
        /> */}

        <Button
          title={recording ? 'Stop Recording' : 'Start 2s Chunk Recording'}
          onPress={recording ? stopRecording : startRecording}
        />

        <Text style={{marginTop: 20, fontWeight: 'bold'}}>Transcriptions:</Text>
        <ScrollView style={{flex: 1, width: '100%'}} contentContainerStyle={{padding: 10}}>
          {transcriptions.map((text, idx) => (
            <Text key={idx} style={{fontSize: 12, marginBottom: 4}}>
              {text}
            </Text>
          ))}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  input: {
    width: '100%',
    borderColor: '#999',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 20,
  },
});
