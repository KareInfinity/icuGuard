import * as React from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  ScrollView,
} from 'react-native';
import {useSelector, useDispatch} from 'react-redux';
import {RootState} from '../redux/store.redux';
import {
  selectAllSessions,
  selectSessionHistory,
  selectTotalSessionCount,
  sessionActions,
} from '../redux/session.redux';

const SessionListContainer: React.FC = () => {
  const dispatch = useDispatch();
  const activeSessions = useSelector(selectAllSessions);
  const sessionHistory = useSelector(selectSessionHistory);
  const totalCount = useSelector(selectTotalSessionCount);

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

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'active':
        return '#4CAF50';
      case 'paused':
        return '#FF9800';
      case 'completed':
        return '#2196F3';
      case 'cancelled':
        return '#F44336';
      default:
        return '#9E9E9E';
    }
  };

  const handleClearAll = () => {
    Alert.alert(
      'Clear All Sessions',
      'Are you sure you want to clear all sessions and history? This action cannot be undone.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: () => dispatch(sessionActions.clearAllSessions()),
        },
      ],
    );
  };

  const handleClearHistory = () => {
    Alert.alert(
      'Clear History',
      'Are you sure you want to clear session history? This action cannot be undone.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Clear History',
          style: 'destructive',
          onPress: () => dispatch(sessionActions.clearSessionHistory()),
        },
      ],
    );
  };

  const handleClearActive = () => {
    Alert.alert(
      'Clear Active Sessions',
      'Are you sure you want to clear all active sessions? This action cannot be undone.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Clear Active',
          style: 'destructive',
          onPress: () => dispatch(sessionActions.clearActiveSessions()),
        },
      ],
    );
  };

  const handleDeleteSession = (sessionId: string, sessionType: 'active' | 'history') => {
    Alert.alert(
      'Delete Session',
      'Are you sure you want to delete this session?',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            if (sessionType === 'history') {
              dispatch(sessionActions.deleteSessionFromHistory(sessionId));
            } else {
              dispatch(sessionActions.cancelSession(sessionId));
            }
          },
        },
      ],
    );
  };

  const renderSessionItem = ({item, index}: {item: any; index: number}) => (
    <View style={styles.sessionItem}>
      <View style={styles.sessionHeader}>
        <Text style={styles.sessionId}>Session {index + 1}</Text>
        <View style={[styles.statusBadge, {backgroundColor: getStatusColor(item.status)}]}>
          <Text style={styles.statusText}>{item.status.toUpperCase()}</Text>
        </View>
      </View>
      
      <View style={styles.sessionDetails}>
        <Text style={styles.detailText}>
          <Text style={styles.label}>Started: </Text>
          {formatDate(item.startTime)}
        </Text>
        
        {item.endTime && (
          <Text style={styles.detailText}>
            <Text style={styles.label}>Ended: </Text>
            {formatDate(item.endTime)}
          </Text>
        )}
        
        <Text style={styles.detailText}>
          <Text style={styles.label}>Duration: </Text>
          {formatDuration(item.duration)}
        </Text>
        
        <Text style={styles.detailText}>
          <Text style={styles.label}>Transcriptions: </Text>
          {item.transcriptionCount} ({item.totalTranscriptionLength} chars)
        </Text>
        
        <Text style={styles.detailText}>
          <Text style={styles.label}>Battery: </Text>
          {item.startBattery}% → {item.endBattery || 'N/A'}%
        </Text>
        
        {item.metadata?.notes && (
          <Text style={styles.detailText}>
            <Text style={styles.label}>Notes: </Text>
            {item.metadata.notes}
          </Text>
        )}
      </View>
      
      <View style={styles.sessionActions}>
        <TouchableOpacity
          style={[styles.actionButton, styles.deleteButton]}
          onPress={() => handleDeleteSession(item.id, 'active')}
        >
          <Text style={styles.actionButtonText}>Delete</Text>
        </TouchableOpacity>
        
        {item.status === 'paused' && (
          <TouchableOpacity
            style={[styles.actionButton, styles.resumeButton]}
            onPress={() => dispatch(sessionActions.resumeSession(item.id))}
          >
            <Text style={styles.actionButtonText}>Resume</Text>
          </TouchableOpacity>
        )}
        
        {item.status === 'active' && (
          <TouchableOpacity
            style={[styles.actionButton, styles.pauseButton]}
            onPress={() => dispatch(sessionActions.pauseSession(item.id))}
          >
            <Text style={styles.actionButtonText}>Pause</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  const renderHistoryItem = ({item, index}: {item: any; index: number}) => (
    <View style={styles.sessionItem}>
      <View style={styles.sessionHeader}>
        <Text style={styles.sessionId}>History {index + 1}</Text>
        <View style={[styles.statusBadge, {backgroundColor: getStatusColor(item.status)}]}>
          <Text style={styles.statusText}>{item.status.toUpperCase()}</Text>
        </View>
      </View>
      
      <View style={styles.sessionDetails}>
        <Text style={styles.detailText}>
          <Text style={styles.label}>Started: </Text>
          {formatDate(item.startTime)}
        </Text>
        
        {item.endTime && (
          <Text style={styles.detailText}>
            <Text style={styles.label}>Ended: </Text>
            {formatDate(item.endTime)}
          </Text>
        )}
        
        <Text style={styles.detailText}>
          <Text style={styles.label}>Duration: </Text>
          {formatDuration(item.duration)}
        </Text>
        
        <Text style={styles.detailText}>
          <Text style={styles.label}>Transcriptions: </Text>
          {item.transcriptionCount} ({item.totalTranscriptionLength} chars)
        </Text>
        
        <Text style={styles.detailText}>
          <Text style={styles.label}>Battery: </Text>
          {item.startBattery}% → {item.endBattery || 'N/A'}%
        </Text>
      </View>
      
      <View style={styles.sessionActions}>
        <TouchableOpacity
          style={[styles.actionButton, styles.deleteButton]}
          onPress={() => handleDeleteSession(item.id, 'history')}
        >
          <Text style={styles.actionButtonText}>Delete</Text>
        </TouchableOpacity>
        
        <TouchableOpacity
          style={[styles.actionButton, styles.restoreButton]}
          onPress={() => dispatch(sessionActions.restoreSessionFromHistory(item.id))}
        >
          <Text style={styles.actionButtonText}>Restore</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Session Management</Text>
        <Text style={styles.subtitle}>
          Total Sessions: {totalCount} (Active: {activeSessions.length}, History: {sessionHistory.length})
        </Text>
      </View>

      <View style={styles.clearButtons}>
        <TouchableOpacity style={[styles.clearButton, styles.clearAllButton]} onPress={handleClearAll}>
          <Text style={styles.clearButtonText}>Clear All</Text>
        </TouchableOpacity>
        
        <TouchableOpacity style={[styles.clearButton, styles.clearHistoryButton]} onPress={handleClearHistory}>
          <Text style={styles.clearButtonText}>Clear History</Text>
        </TouchableOpacity>
        
        <TouchableOpacity style={[styles.clearButton, styles.clearActiveButton]} onPress={handleClearActive}>
          <Text style={styles.clearButtonText}>Clear Active</Text>
        </TouchableOpacity>
      </View>

      {/* Always show Active Sessions section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Active Sessions ({activeSessions.length})</Text>
        {activeSessions.length > 0 ? (
          <FlatList
            data={activeSessions}
            renderItem={renderSessionItem}
            keyExtractor={(item) => item.id}
            scrollEnabled={false}
          />
        ) : (
          <View style={styles.emptySection}>
            <Text style={styles.emptySectionText}>No active sessions</Text>
            <Text style={styles.emptySectionSubtext}>Start recording to create a new session</Text>
          </View>
        )}
      </View>

      {/* Always show Session History section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Session History ({sessionHistory.length})</Text>
        {sessionHistory.length > 0 ? (
          <FlatList
            data={sessionHistory}
            renderItem={renderHistoryItem}
            keyExtractor={(item) => item.id}
            scrollEnabled={false}
          />
        ) : (
          <View style={styles.emptySection}>
            <Text style={styles.emptySectionText}>No session history</Text>
            <Text style={styles.emptySectionSubtext}>Complete a session to see it here</Text>
          </View>
        )}
      </View>

      {/* Show overall empty state only when there are truly no sessions */}
      {totalCount === 0 && (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateText}>No sessions found</Text>
          <Text style={styles.emptyStateSubtext}>Start recording to create your first session</Text>
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    padding: 20,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
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
  clearButtons: {
    flexDirection: 'row',
    padding: 20,
    gap: 10,
  },
  clearButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  clearAllButton: {
    backgroundColor: '#F44336',
  },
  clearHistoryButton: {
    backgroundColor: '#FF9800',
  },
  clearActiveButton: {
    backgroundColor: '#2196F3',
  },
  clearButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    padding: 20,
    paddingBottom: 10,
    backgroundColor: '#fff',
  },
  emptySection: {
    backgroundColor: '#fff',
    marginHorizontal: 20,
    padding: 20,
    alignItems: 'center',
    borderRadius: 8,
  },
  emptySectionText: {
    fontSize: 16,
    color: '#666',
    marginBottom: 5,
  },
  emptySectionSubtext: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
  },
  sessionItem: {
    backgroundColor: '#fff',
    marginHorizontal: 20,
    marginBottom: 10,
    borderRadius: 12,
    padding: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  sessionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sessionId: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  sessionDetails: {
    marginBottom: 16,
  },
  detailText: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
  label: {
    fontWeight: '600',
    color: '#333',
  },
  sessionActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    flex: 1,
    padding: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  deleteButton: {
    backgroundColor: '#F44336',
  },
  resumeButton: {
    backgroundColor: '#4CAF50',
  },
  pauseButton: {
    backgroundColor: '#FF9800',
  },
  restoreButton: {
    backgroundColor: '#2196F3',
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  emptyState: {
    alignItems: 'center',
    padding: 40,
  },
  emptyStateText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#666',
    marginBottom: 8,
  },
  emptyStateSubtext: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
  },
});

export default SessionListContainer;
