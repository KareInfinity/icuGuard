import * as React from 'react';
import {useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useDispatch} from 'react-redux';
import {userActions} from '../redux/user.redux';

interface UsernamePromptProps {
  onComplete: () => void;
}

export function UsernamePromptContainer({onComplete}: UsernamePromptProps) {
  const [username, setUsername] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dispatch = useDispatch();

  const handleSubmit = () => {
    const trimmedUsername = username.trim();
    
    if (!trimmedUsername) {
      Alert.alert('Username Required', 'Please enter a username to continue.');
      return;
    }
    
    if (trimmedUsername.length < 2) {
      Alert.alert('Username Too Short', 'Username must be at least 2 characters long.');
      return;
    }
    
    if (trimmedUsername.length > 20) {
      Alert.alert('Username Too Long', 'Username must be 20 characters or less.');
      return;
    }
    
    setIsSubmitting(true);
    
    try {
      // Store username in Redux
      dispatch(userActions.setUsername(trimmedUsername));
      
      // Call the completion callback
      onComplete();
    } catch (error) {
      console.error('Error saving username:', error);
      Alert.alert('Error', 'Failed to save username. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSkip = () => {
    Alert.alert(
      'Skip Username',
      'You can always set your username later in the Account section. Continue without username?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Skip',
          onPress: () => {
            dispatch(userActions.completeSetup());
            onComplete();
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView 
        style={styles.keyboardAvoid} 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.content}>
          {/* Welcome Header */}
          <View style={styles.header}>
            <Text style={styles.welcomeText}>Welcome to WhisperRN</Text>
            <Text style={styles.subtitleText}>
              Your personal audio transcription assistant
            </Text>
          </View>

          {/* Username Input Section */}
          <View style={styles.inputSection}>
            <Text style={styles.inputLabel}>What should we call you?</Text>
            <Text style={styles.inputDescription}>
              This helps personalize your experience
            </Text>
            
            <TextInput
              style={styles.textInput}
              placeholder="Enter your name"
              placeholderTextColor="#999"
              value={username}
              onChangeText={setUsername}
              autoFocus={true}
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={20}
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
            />
            
            <Text style={styles.characterCount}>
              {username.length}/20 characters
            </Text>
          </View>

          {/* Action Buttons */}
          <View style={styles.buttonSection}>
            <TouchableOpacity
              style={[
                styles.primaryButton,
                (!username.trim() || isSubmitting) && styles.disabledButton
              ]}
              onPress={handleSubmit}
              disabled={!username.trim() || isSubmitting}
            >
              <Text style={styles.primaryButtonText}>
                {isSubmitting ? 'Setting up...' : 'Get Started'}
              </Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={handleSkip}
              disabled={isSubmitting}
            >
              <Text style={styles.secondaryButtonText}>Skip for now</Text>
            </TouchableOpacity>
          </View>

          {/* App Features Preview */}
          <View style={styles.featuresSection}>
            <Text style={styles.featuresTitle}>What you can do:</Text>
            <View style={styles.featureItem}>
              <Text style={styles.featureIcon}>🎤</Text>
              <Text style={styles.featureText}>Record and transcribe audio in real-time</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureIcon}>💾</Text>
              <Text style={styles.featureText}>Save and manage your transcriptions</Text>
            </View>
            <View style={styles.featureItem}>
              <Text style={styles.featureIcon}>🔧</Text>
              <Text style={styles.featureText}>Customize server settings</Text>
            </View>
          </View>
        </View>
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
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 48,
  },
  welcomeText: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#212529',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitleText: {
    fontSize: 16,
    color: '#6c757d',
    textAlign: 'center',
  },
  inputSection: {
    marginBottom: 40,
  },
  inputLabel: {
    fontSize: 18,
    fontWeight: '600',
    color: '#212529',
    marginBottom: 8,
  },
  inputDescription: {
    fontSize: 14,
    color: '#6c757d',
    marginBottom: 16,
  },
  textInput: {
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#dee2e6',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: '#212529',
    marginBottom: 8,
  },
  characterCount: {
    fontSize: 12,
    color: '#6c757d',
    textAlign: 'right',
  },
  buttonSection: {
    marginBottom: 40,
  },
  primaryButton: {
    backgroundColor: '#0d6efd',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  disabledButton: {
    backgroundColor: '#6c757d',
    opacity: 0.6,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#6c757d',
    fontSize: 14,
    fontWeight: '500',
  },
  featuresSection: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: '#e9ecef',
  },
  featuresTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#212529',
    marginBottom: 16,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  featureIcon: {
    fontSize: 20,
    marginRight: 12,
  },
  featureText: {
    fontSize: 14,
    color: '#495057',
    flex: 1,
  },
}); 