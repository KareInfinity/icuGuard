import * as React from 'react';
import { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { CompositeScreenProps } from '@react-navigation/native';
import { useFocusEffect } from '@react-navigation/native';
import { HomeModuleParamList, AppModuleParamList } from '../app.navigation';
import {getAPIServer} from '../environment';
import { useSelector } from 'react-redux';
import { selectTranscriptions } from '../redux/transcriptions.redux';

type AccountContainerProps = CompositeScreenProps<
  BottomTabScreenProps<HomeModuleParamList, 'account'>,
  NativeStackScreenProps<AppModuleParamList>
>;

type TranscriptionFile = {
  name: string;
  size?: string;
  date?: string;
  content?: string;
  content_length?: number;
  filename?: string;
  lines?: number;
};

export function AccountContainer(props: AccountContainerProps) {
  const transcriptions = useSelector(selectTranscriptions);
  const [files, setFiles] = useState<TranscriptionFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<TranscriptionFile | null>(null);
  const [showFileContent, setShowFileContent] = useState(false);
  const [loadingFileContent, setLoadingFileContent] = useState(false);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filteredFiles, setFilteredFiles] = useState<TranscriptionFile[]>([]);
  
  // Refs to track and abort ongoing requests
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      const loadData = async () => {
        try {
          // First test server connection (non-blocking)
          testServerConnection().catch(error => {
            console.warn('Server connection test failed:', error);
          });
          
          // Then fetch files with a small delay to avoid race conditions
          setTimeout(() => {
            fetchTranscriptionFiles().catch(error => {
              console.error('Failed to fetch transcription files:', error);
            });
          }, 100);
        } catch (error) {
          console.error('Error in loadData:', error);
        }
      };
      
      loadData();
    }, [])
  );

  const testServerConnection = async () => {
    try {
      const healthUrl = getAPIServer() + '/health';
      console.log('Testing server connection to:', healthUrl);
      
      // Abort any existing request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      
      // Create new AbortController
      abortControllerRef.current = new AbortController();
      const timeoutId = setTimeout(() => abortControllerRef.current?.abort(), 5000); // 5 second timeout
      
      const response = await fetch(healthUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        signal: abortControllerRef.current.signal,
      });
      
      clearTimeout(timeoutId); // Clear timeout if request completes
      
      if (!isMountedRef.current) return false; // Component unmounted
      
      if (response.ok) {
        const healthData = await response.json();
        console.log('Server health check successful:', healthData);
        return true;
      } else {
        console.warn('Server health check failed:', response.status);
        return false;
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Server connection test was aborted');
        return false;
      }
      console.error('Server connection test failed:', error);
      return false;
    }
  };

  useEffect(() => {
    // Filter files based on search query
    if (searchQuery.trim() === '') {
      setFilteredFiles(files);
    } else {
      const filtered = files.filter(file => 
        file.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (file.content && file.content.toLowerCase().includes(searchQuery.toLowerCase()))
      );
      setFilteredFiles(filtered);
    }
  }, [files, searchQuery]);

  const fetchTranscriptionFiles = async () => {
    try {
      setLoading(true);
      const apiUrl = getAPIServer() + '/transcription-files';
      console.log('Fetching transcription files from:', apiUrl);
      
      // Abort any existing request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      
      // Create new AbortController
      abortControllerRef.current = new AbortController();
      const timeoutId = setTimeout(() => abortControllerRef.current?.abort(), 10000); // 10 second timeout
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        signal: abortControllerRef.current.signal,
      });
      
      clearTimeout(timeoutId); // Clear timeout if request completes
      
      if (!isMountedRef.current) return; // Component unmounted
      
      console.log('Response status:', response.status);
      console.log('Response headers:', response.headers);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Server error response:', errorText);
        throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
      }
      
      const data = await response.json();
      console.log('Response data:', data);
      
      if (!isMountedRef.current) return; // Component unmounted
      
      if (data.success) {
        console.log('Transcription files found:', data.files.length);
        setFiles(data.files);
      } else {
        throw new Error(data.message || 'Failed to fetch files from server');
      }
    } catch (error) {
      if (!isMountedRef.current) return; // Component unmounted
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Detailed error fetching files:', error);
      
      // Don't show alert for timeout/abort errors when navigating between screens
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Request was aborted (likely due to navigation)');
        return;
      }
      
      Alert.alert(
        "Connection Error", 
        `Failed to fetch transcription files: ${errorMessage}\n\nPlease check:\n• Server is running on ${getAPIServer()}\n• Network connection\n• Server IP address`
      );
      setFiles([]); // Clear files on error
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  };

  const refreshFiles = () => {
    fetchTranscriptionFiles();
  };

  const viewFileContent = async (filename: string) => {
    try {
      setLoadingFileContent(true);
      const apiUrl = getAPIServer() + `/transcription-file/${encodeURIComponent(filename)}`;
      console.log('Fetching file content from:', apiUrl);
      
      const response = await fetch(apiUrl);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (data.success) {
        setSelectedFile(data);
        setShowFileContent(true);
      } else {
        throw new Error(data.message || 'Failed to fetch file content');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Alert.alert("Error", `Failed to read file content: ${errorMessage}`);
      console.error('Error reading file:', error);
    } finally {
      setLoadingFileContent(false);
    }
  };

  const deleteFile = async (filename: string) => {
    Alert.alert(
      "Delete File",
      `Are you sure you want to delete "${filename}"?`,
      [
        {
          text: "Cancel",
          style: "cancel"
        },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              setDeletingFile(filename);
              const apiUrl = getAPIServer() + `/delete-transcription/${encodeURIComponent(filename)}`;
              console.log('Deleting file from:', apiUrl);
              
              const response = await fetch(apiUrl, {
                method: 'DELETE',
              });
              
              if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
              }
              
              const data = await response.json();
              
              if (data.success) {
                Alert.alert("Success", `File "${filename}" deleted successfully`);
                // Refresh the file list
                fetchTranscriptionFiles();
              } else {
                throw new Error(data.message || 'Failed to delete file');
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              Alert.alert("Error", `Failed to delete file: ${errorMessage}`);
              console.error('Error deleting file:', error);
            } finally {
              setDeletingFile(null);
            }
          }
        }
      ]
    );
  };

  const renderFileItem = ({ item }: { item: TranscriptionFile }) => (
    <TouchableOpacity 
      style={{
        backgroundColor: 'white',
        padding: 16,
        marginBottom: 12,
        borderRadius: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 2,
        borderLeftWidth: 4,
        borderLeftColor: '#007AFF',
      }}
      onPress={() => viewFileContent(item.name)}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Text style={{
            fontSize: 16,
            fontWeight: '600',
            color: '#333',
            marginBottom: 6,
          }}>{item.name}</Text>
          
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            {item.size && (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={{
                  fontSize: 12,
                  color: '#666',
                  backgroundColor: '#f0f0f0',
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
                }}>📄 {item.size}</Text>
              </View>
            )}
            {item.date && (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={{
                  fontSize: 12,
                  color: '#666',
                  backgroundColor: '#f0f0f0',
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
                }}>📅 {item.date}</Text>
              </View>
            )}
            {item.content_length !== undefined && (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={{
                  fontSize: 12,
                  color: '#666',
                  backgroundColor: '#f0f0f0',
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
                }}>📝 {item.content_length} chars</Text>
              </View>
            )}
          </View>
        </View>
        
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity 
            onPress={() => viewFileContent(item.name)}
            style={{
              backgroundColor: '#007AFF',
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 12,
            }}
          >
            <Text style={{
              color: 'white',
              fontSize: 10,
              fontWeight: '500',
            }}>VIEW</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            onPress={() => deleteFile(item.name)}
            disabled={deletingFile === item.name}
            style={{
              backgroundColor: deletingFile === item.name ? '#ccc' : '#ff4444',
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 12,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {deletingFile === item.name ? (
              <ActivityIndicator size="small" color="white" />
            ) : null}
            <Text style={{
              color: 'white',
              fontSize: 10,
              fontWeight: '500',
            }}>{deletingFile === item.name ? 'DELETING' : 'DELETE'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderFileContent = () => {
    if (!selectedFile) return null;

    return (
      <View 
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.8)',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
        }}
      >
        <TouchableOpacity 
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
          }}
          activeOpacity={1}
          onPress={() => setShowFileContent(false)}
        />
        <View 
          style={{
            backgroundColor: 'white',
            margin: 20,
            borderRadius: 12,
            padding: 20,
            maxHeight: '80%',
            minHeight: '80%',
            width: '90%',
          }}
        >
          <View style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
            borderBottomWidth: 1,
            borderBottomColor: '#eee',
            paddingBottom: 8,
          }}>
            <View style={{ flex: 1 }}>
              <Text style={{
                fontSize: 18,
                fontWeight: 'bold',
                color: '#333',
              }}>{selectedFile.filename || selectedFile.name}</Text>
              <Text style={{
                fontSize: 12,
                color: '#666',
                marginTop: 2,
              }}>
                {selectedFile.content_length} characters • {selectedFile.lines || 'N/A'} lines
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity 
                onPress={() => {
                  // Copy to clipboard functionality
                  Alert.alert('Copy', 'Copy functionality can be added with react-native-clipboard');
                }}
                style={{
                  backgroundColor: '#007AFF',
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 6,
                }}
              >
                <Text style={{
                  color: 'white',
                  fontSize: 12,
                  fontWeight: '500',
                }}>Copy</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                onPress={() => setShowFileContent(false)}
                style={{
                  backgroundColor: '#ff4444',
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 6,
                }}
              >
                <Text style={{
                  color: 'white',
                  fontSize: 12,
                  fontWeight: '500',
                }}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
          
          <ScrollView 
            style={{ flex: 1, backgroundColor: '#f8f9fa', borderRadius: 8, padding: 12 }}
            showsVerticalScrollIndicator={true}
            nestedScrollEnabled={true}
          >
            {loadingFileContent ? (
              <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="small" color="#0000ff" />
              </View>
            ) : (
              <Text style={{
                fontSize: 14,
                color: '#333',
                lineHeight: 20,
                fontFamily: 'monospace',
              }}>{selectedFile.content}</Text>
            )}
          </ScrollView>
          
          <View style={{
            marginTop: 12,
            paddingTop: 8,
            borderTopWidth: 1,
            borderTopColor: '#eee',
            flexDirection: 'row',
            justifyContent: 'space-between',
          }}>
            <Text style={{
              fontSize: 12,
              color: '#666',
            }}>Size: {selectedFile.size}</Text>
            <Text style={{
              fontSize: 12,
              color: '#666',
            }}>Date: {selectedFile.date}</Text>
            <Text style={{
              fontSize: 12,
              color: '#666',
            }}>Lines: {selectedFile.lines || 'N/A'}</Text>
          </View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: '#f5f5f5'}}>
      <View style={{
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#ddd',
      }}>
        <Text style={{
          fontSize: 24,
          fontWeight: 'bold',
          color: '#333',
        }}>Account</Text>
      </View>
    
      {/* Transcription Files Section */}
      <View style={{
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#ddd',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <Text style={{
          fontSize: 18,
          fontWeight: 'bold',
          color: '#333',
        }}>Saved Files</Text>
        <TouchableOpacity 
          onPress={refreshFiles}
          style={{
            backgroundColor: '#007AFF',
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 6,
          }}
        >
          <Text style={{
            color: 'white',
            fontSize: 12,
            fontWeight: '500',
          }}>Refresh</Text>
        </TouchableOpacity>
      </View>

      {/* Search Section */}
      <View style={{
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#ddd',
      }}>
        <TextInput
          style={{
            backgroundColor: 'white',
            borderWidth: 1,
            borderColor: '#ddd',
            borderRadius: 8,
            padding: 12,
            fontSize: 16,
            color: '#333',
          }}
          placeholder="Search files by name or content..."
          placeholderTextColor="#999"
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery.length > 0 && (
          <Text style={{
            fontSize: 12,
            color: '#666',
            marginTop: 4,
          }}>
            Found {filteredFiles.length} of {files.length} files
          </Text>
        )}
      </View>

 
      
      {loading ? (
        <View style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
        }}>
          <ActivityIndicator size="large" color="#0000ff" />
        </View>
      ) : files.length === 0 ? (
        <View style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
        }}>
          <Text style={{
            textAlign: 'center',
            marginTop: 24,
            fontSize: 16,
            color: '#666',
          }}>No transcription files available</Text>
        </View>
      ) : filteredFiles.length === 0 ? (
        <View style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
        }}>
          <Text style={{
            textAlign: 'center',
            marginTop: 24,
            fontSize: 16,
            color: '#666',
          }}>No files match your search</Text>
        </View>
      ) : (
        <FlatList
          data={filteredFiles}
          renderItem={renderFileItem}
          keyExtractor={(item) => item.name}
          contentContainerStyle={{
            padding: 16,
          }}
        />
      )}
      {showFileContent && renderFileContent()}
    </SafeAreaView>
  );
}