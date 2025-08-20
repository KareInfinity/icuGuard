# Session Management System

This document describes the Redux-based session management system for tracking recording sessions with clear functionality.

## Overview

The session management system provides comprehensive tracking of all recording sessions, including:
- Active sessions (recording, paused)
- Session history (completed, cancelled)
- Session metadata (notes, device info, location)
- Battery level tracking
- Transcription statistics
- Clear options for all sessions

## Files

- `session.redux.tsx` - Main Redux slice for session management
- `session.hook.tsx` - Custom hook for easy session management
- `session-list.container.tsx` - UI component for displaying and managing sessions
- `session-example.container.tsx` - Example implementation

## Features

### Session States
- **Active**: Currently recording or processing
- **Paused**: Temporarily stopped, can be resumed
- **Completed**: Finished successfully
- **Cancelled**: Stopped without completion

### Session Data
- Unique ID and timestamps
- Duration tracking
- Battery level monitoring
- Transcription count and character length
- Custom metadata (notes, device info, location)

### Clear Options
- **Clear All**: Removes all sessions and history
- **Clear History**: Removes only completed/cancelled sessions
- **Clear Active**: Removes only current sessions
- **Delete Individual**: Remove specific sessions

## Usage

### Basic Session Management

```typescript
import { useSession } from '../redux/session.hook';

const MyComponent = () => {
  const {
    startSession,
    endSession,
    pauseSession,
    resumeSession,
    currentSession,
    allSessions,
    sessionHistory
  } = useSession();

  // Start a new session
  const handleStart = () => {
    startSession({
      id: `session_${Date.now()}`,
      startTime: Date.now(),
      transcriptionCount: 0,
      totalTranscriptionLength: 0,
      startBattery: 85,
      metadata: {
        notes: 'Meeting recording',
        deviceInfo: 'iPhone 12'
      }
    });
  };

  // End current session
  const handleEnd = () => {
    if (currentSession) {
      endSession(currentSession.id, Date.now(), 75);
    }
  };
};
```

### Session Actions

```typescript
// Pause/Resume
pauseSession(sessionId);
resumeSession(sessionId);

// Cancel session
cancelSession(sessionId);

// Update session info
updateSessionTranscription(sessionId, count, totalLength);
updateSessionBattery(sessionId, batteryLevel, isCharging);
updateSessionMetadata(sessionId, { notes: 'Updated notes' });

// Clear operations
clearAllSessions();
clearSessionHistory();
clearActiveSessions();
deleteSessionFromHistory(sessionId);
```

### Utility Functions

```typescript
// Get sessions by criteria
const pausedSessions = getSessionsByStatus('paused');
const recentSessions = getSessionsByDateRange(startDate, endDate);
const longSessions = getSessionsByDuration(300000); // 5+ minutes

// Statistics
const totalChars = getTotalTranscriptionLength();
const avgDuration = getAverageSessionDuration();
```

## Integration with Existing Code

### Update Store
The session reducer is already added to the main store:

```typescript
// store.redux.tsx
import { sessionReducers } from './session.redux';

const rootReducer = combineReducers({
  // ... other reducers
  session: sessionReducers,
});
```

### Link with Transcriptions
Sessions can be linked to transcriptions via `sessionId`:

```typescript
// When creating a transcription
const transcription = {
  id: 'trans_123',
  text: 'Hello world',
  sessionId: currentSession.id, // Link to session
  timestamp: Date.now()
};
```

## UI Components

### SessionListContainer
Main component for viewing and managing all sessions:
- Displays active sessions and history
- Clear buttons for bulk operations
- Individual session actions (pause, resume, delete)
- Session details and statistics

### SessionExampleContainer
Example implementation showing:
- Session controls (start, pause, resume, end)
- Real-time session information
- Statistics display
- Notes input for sessions

## Best Practices

1. **Session Lifecycle**: Always start a session before recording, end it when complete
2. **Battery Tracking**: Update battery levels periodically during long sessions
3. **Metadata**: Use notes and device info for better session organization
4. **Clear Operations**: Use confirmation dialogs for destructive operations
5. **Error Handling**: Check for current session before performing actions

## Data Persistence

Sessions are automatically persisted using Redux Persist with AsyncStorage, ensuring data survives app restarts.

## Performance Considerations

- Sessions are stored in memory for active use
- History is moved to a separate array when sessions complete
- Large numbers of sessions may impact performance
- Consider implementing pagination for very long histories

## Future Enhancements

- Session export/import functionality
- Advanced filtering and search
- Session templates and presets
- Cloud synchronization
- Analytics and reporting
