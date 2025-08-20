import {useSelector, useDispatch} from 'react-redux';
import {RootState} from './store.redux';
import {
  sessionActions,
  selectAllSessions,
  selectActiveSessions,
  selectPausedSessions,
  selectSessionHistory,
  selectCurrentSession,
  selectSessionCount,
  selectHistoryCount,
  selectTotalSessionCount,
  Session,
} from './session.redux';

export const useSession = () => {
  const dispatch = useDispatch();

  // Selectors
  const allSessions = useSelector(selectAllSessions);
  const activeSessions = useSelector(selectActiveSessions);
  const pausedSessions = useSelector(selectPausedSessions);
  const sessionHistory = useSelector(selectSessionHistory);
  const currentSession = useSelector(selectCurrentSession);
  const sessionCount = useSelector(selectSessionCount);
  const historyCount = useSelector(selectHistoryCount);
  const totalCount = useSelector(selectTotalSessionCount);

  // Actions
  const startSession = (sessionData: Omit<Session, 'endTime' | 'duration' | 'status'>) => {
    dispatch(sessionActions.startSession(sessionData));
  };

  const endSession = (id: string, endTime: number, endBattery?: number) => {
    dispatch(sessionActions.endSession({id, endTime, endBattery}));
  };

  const pauseSession = (id: string) => {
    dispatch(sessionActions.pauseSession(id));
  };

  const resumeSession = (id: string) => {
    dispatch(sessionActions.resumeSession(id));
  };

  const cancelSession = (id: string) => {
    dispatch(sessionActions.cancelSession(id));
  };

  const updateSessionTranscription = (id: string, transcriptionCount: number, totalLength: number) => {
    dispatch(sessionActions.updateSessionTranscription({id, transcriptionCount, totalLength}));
  };

  const updateSessionBattery = (id: string, batteryLevel: number, isCharging?: boolean) => {
    dispatch(sessionActions.updateSessionBattery({id, batteryLevel, isCharging}));
  };

  const updateSessionMetadata = (id: string, metadata: Partial<Session['metadata']>) => {
    dispatch(sessionActions.updateSessionMetadata({id, metadata}));
  };

  const clearAllSessions = () => {
    dispatch(sessionActions.clearAllSessions());
  };

  const clearSessionHistory = () => {
    dispatch(sessionActions.clearSessionHistory());
  };

  const clearActiveSessions = () => {
    dispatch(sessionActions.clearActiveSessions());
  };

  const deleteSessionFromHistory = (id: string) => {
    dispatch(sessionActions.deleteSessionFromHistory(id));
  };

  const restoreSessionFromHistory = (id: string) => {
    dispatch(sessionActions.restoreSessionFromHistory(id));
  };

  // Utility functions
  const getSessionById = (id: string) => {
    return allSessions.find(s => s.id === id) || sessionHistory.find(s => s.id === id);
  };

  const getSessionsByStatus = (status: Session['status']) => {
    return allSessions.filter(s => s.status === status);
  };

  const getSessionsByDateRange = (startDate: Date, endDate: Date) => {
    const startTime = startDate.getTime();
    const endTime = endDate.getTime();
    
    return [...allSessions, ...sessionHistory].filter(s => 
      s.startTime >= startTime && s.startTime <= endTime
    );
  };

  const getSessionsByDuration = (minDuration: number, maxDuration?: number) => {
    return [...allSessions, ...sessionHistory].filter(s => {
      if (maxDuration) {
        return s.duration >= minDuration && s.duration <= maxDuration;
      }
      return s.duration >= minDuration;
    });
  };

  const getTotalTranscriptionLength = () => {
    return [...allSessions, ...sessionHistory].reduce((total, s) => total + s.totalTranscriptionLength, 0);
  };

  const getAverageSessionDuration = () => {
    const sessions = [...allSessions, ...sessionHistory];
    if (sessions.length === 0) return 0;
    
    const totalDuration = sessions.reduce((total, s) => total + s.duration, 0);
    return totalDuration / sessions.length;
  };

  return {
    // State
    allSessions,
    activeSessions,
    pausedSessions,
    sessionHistory,
    currentSession,
    sessionCount,
    historyCount,
    totalCount,
    
    // Actions
    startSession,
    endSession,
    pauseSession,
    resumeSession,
    cancelSession,
    updateSessionTranscription,
    updateSessionBattery,
    updateSessionMetadata,
    clearAllSessions,
    clearSessionHistory,
    clearActiveSessions,
    deleteSessionFromHistory,
    restoreSessionFromHistory,
    
    // Utility functions
    getSessionById,
    getSessionsByStatus,
    getSessionsByDateRange,
    getSessionsByDuration,
    getTotalTranscriptionLength,
    getAverageSessionDuration,
  };
};
