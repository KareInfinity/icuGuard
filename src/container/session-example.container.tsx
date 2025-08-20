import * as React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  TextInput,
} from 'react-native';
import {useSession} from '../redux/session.hook';

const SessionExampleContainer: React.FC = () => {
  const {
    allSessions,
    activeSessions,
    sessionHistory,
    currentSession,
    sessionCount,
    totalCount,
    startSession,
    endSession,
    pauseSession,
    resumeSession,
    clearAllSessions,
    getTotalTranscriptionLength,
    getAverageSessionDuration,
  } = useSession();

  const [notes, setNotes] = React.useState('');

  const handleStartSession = () => {
    const sessionData = {
      id: `session_${Date.now()}`,
      startTime: Date.now(),
      transcriptionCount: 0,
      totalTranscriptionLength: 0,
      startBattery: 85, // Example battery level
      metadata: {
        notes: notes.trim() || undefined,
        deviceInfo: 'React Native App',
      },
    };

    startSession(sessionData);
    setNotes('');
    Alert.alert('Session Started', 'New recording session has been created!');
  };

  const handleEndCurrentSession = () => {
    if (currentSession) {
      endSession(currentSession.id, Date.now(), 80); // Example end battery
      Alert.alert('Session Ended', 'Current session has been completed!');
    } else {
      Alert.alert('No Active Session', 'There is no active session to end.');
    }
  };

  const handlePauseCurrentSession = () => {
    if (currentSession) {
      pauseSession(currentSession.id);
      Alert.alert('Session Paused', 'Current session has been paused.');
    } else {
      Alert.alert('No Active Session', 'There is no active session to pause.');
    }
  };

  const handleResumeCurrentSession = () => {
    if (currentSession) {
      resumeSession(currentSession.id);
      Alert.alert('Session Resumed', 'Current session has been resumed.');
    } else {
      Alert.alert('No Active Session', 'There is no active session to resume.');
    }
  };

  const formatDuration = (duration: number): string => {
    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Session Management Example</Text>
        <Text style={styles.subtitle}>
          Total: {totalCount} | Active: {sessionCount} | History: {sessionHistory.length}
        </Text>
      </View>

      <View style={styles.statsContainer}>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Total Characters</Text>
          <Text style={styles.statValue}>{getTotalTranscriptionLength().toLocaleString()}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Avg Duration</Text>
          <Text style={styles.statValue}>{formatDuration(getAverageSessionDuration())}</Text>
        </View>
      </View>

      <View style={styles.controlsContainer}>
        <Text style={styles.sectionTitle}>Session Controls</Text>
        
        <TextInput
          style={styles.notesInput}
          placeholder="Add session notes (optional)"
          value={notes}
          onChangeText={setNotes}
          multiline
        />

        <View style={styles.buttonRow}>
          <TouchableOpacity style={[styles.button, styles.startButton]} onPress={handleStartSession}>
            <Text style={styles.buttonText}>Start New Session</Text>
          </TouchableOpacity>
        </View>

        {currentSession && (
          <View style={styles.currentSessionInfo}>
            <Text style={styles.currentSessionTitle}>Current Session</Text>
            <Text style={styles.currentSessionText}>
              Started: {formatDate(currentSession.startTime)}
            </Text>
            <Text style={styles.currentSessionText}>
              Duration: {formatDuration(currentSession.duration)}
            </Text>
            <Text style={styles.currentSessionText}>
              Transcriptions: {currentSession.transcriptionCount}
            </Text>
            
            <View style={styles.buttonRow}>
              <TouchableOpacity 
                style={[styles.button, styles.pauseButton]} 
                onPress={handlePauseCurrentSession}
              >
                <Text style={styles.buttonText}>Pause</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={[styles.button, styles.resumeButton]} 
                onPress={handleResumeCurrentSession}
              >
                <Text style={styles.buttonText}>Resume</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={[styles.button, styles.endButton]} 
                onPress={handleEndCurrentSession}
              >
                <Text style={styles.buttonText}>End</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <TouchableOpacity 
          style={[styles.button, styles.clearButton]} 
          onPress={() => {
            Alert.alert(
              'Clear All Sessions',
              'Are you sure you want to clear all sessions?',
              [
                {text: 'Cancel', style: 'cancel'},
                {text: 'Clear All', style: 'destructive', onPress: clearAllSessions},
              ]
            );
          }}
        >
          <Text style={styles.buttonText}>Clear All Sessions</Text>
        </TouchableOpacity>
      </View>

      {activeSessions.length > 0 && (
        <View style={styles.sessionsContainer}>
          <Text style={styles.sectionTitle}>Active Sessions</Text>
          {activeSessions.map((session, index) => (
            <View key={session.id} style={styles.sessionItem}>
              <Text style={styles.sessionTitle}>Session {index + 1}</Text>
              <Text style={styles.sessionText}>Started: {formatDate(session.startTime)}</Text>
              <Text style={styles.sessionText}>Status: {session.status}</Text>
              <Text style={styles.sessionText}>
                Transcriptions: {session.transcriptionCount}
              </Text>
              {session.metadata?.notes && (
                <Text style={styles.sessionText}>Notes: {session.metadata.notes}</Text>
              )}
            </View>
          ))}
        </View>
      )}

      {sessionHistory.length > 0 && (
        <View style={styles.sessionsContainer}>
          <Text style={styles.sectionTitle}>Recent History</Text>
          {sessionHistory.slice(0, 3).map((session, index) => (
            <View key={session.id} style={styles.sessionItem}>
              <Text style={styles.sessionTitle}>History {index + 1}</Text>
              <Text style={styles.sessionText}>Started: {formatDate(session.startTime)}</Text>
              <Text style={styles.sessionText}>Duration: {formatDuration(session.duration)}</Text>
              <Text style={styles.sessionText}>Status: {session.status}</Text>
              <Text style={styles.sessionText}>
                Transcriptions: {session.transcriptionCount}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    padding: 20,
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
  },
  statsContainer: {
    flexDirection: 'row',
    marginBottom: 20,
    gap: 10,
  },
  statItem: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 12,
    color: '#666',
    marginBottom: 5,
  },
  statValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  controlsContainer: {
    backgroundColor: '#fff',
    padding: 20,
    borderRadius: 12,
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 15,
  },
  notesInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    marginBottom: 15,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 15,
  },
  button: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  startButton: {
    backgroundColor: '#4CAF50',
  },
  pauseButton: {
    backgroundColor: '#FF9800',
  },
  resumeButton: {
    backgroundColor: '#2196F3',
  },
  endButton: {
    backgroundColor: '#F44336',
  },
  clearButton: {
    backgroundColor: '#9C27B0',
  },
  buttonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  currentSessionInfo: {
    backgroundColor: '#f0f8ff',
    padding: 15,
    borderRadius: 8,
    marginBottom: 15,
  },
  currentSessionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 10,
  },
  currentSessionText: {
    fontSize: 14,
    color: '#666',
    marginBottom: 5,
  },
  sessionsContainer: {
    backgroundColor: '#fff',
    padding: 20,
    borderRadius: 12,
    marginBottom: 20,
  },
  sessionItem: {
    backgroundColor: '#f9f9f9',
    padding: 15,
    borderRadius: 8,
    marginBottom: 10,
  },
  sessionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 8,
  },
  sessionText: {
    fontSize: 14,
    color: '#666',
    marginBottom: 3,
  },
});

export default SessionExampleContainer;
