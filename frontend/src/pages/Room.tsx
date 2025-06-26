import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import MusicPlayer from '../components/MusicPlayer';

const API_BASE_URL = 'http://localhost:8000';
const AUDIO_CHUNK_SIZE = 500;

export default function Room() {
  const { topic } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [userId] = useState(location.state?.userId || 1);
  const [wsUrl] = useState(location.state?.wsUrl || '');

  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [serverHealth, setServerHealth] = useState(false);

  // Audio capture states
  const [isCapturing, setIsCapturing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [captureMode, setCaptureMode] = useState('tab');
  
  // Audio streaming states
  const [isStreamPlaying, setIsStreamPlaying] = useState(false);
  const [playbackVolume, setPlaybackVolume] = useState(0.7);
  const [streamBuffer, setStreamBuffer] = useState([]);
  const [currentlyPlayingIndex, setCurrentlyPlayingIndex] = useState(-1);
  
  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioElementsRef = useRef({});
  const streamAudioRef = useRef(null);
  const streamQueueRef = useRef([]);
  const isPlayingStreamRef = useRef(false);
  const messagesRef = useRef([]);
  const reconnectTimeoutRef = useRef(null);
  const messageIdCounter = useRef(0);

  // Keep messagesRef in sync with messages state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (wsUrl && !isConnected) {
      connectWebSocket(wsUrl);
    }

    // Cleanup on unmount
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      
      // Clean up stream audio
      stopAudioStream();
      
      // Clean up individual audio URLs
      Object.values(audioElementsRef.current).forEach(audio => {
        if (audio?.src) {
          URL.revokeObjectURL(audio.src);
        }
      });
    };
  }, [wsUrl]);

  // Initialize streaming audio element
  useEffect(() => {
    streamAudioRef.current = new Audio();
    streamAudioRef.current.volume = playbackVolume;
    
    streamAudioRef.current.onended = () => {
      playNextInQueue();
    };
    
    streamAudioRef.current.onerror = (e) => {
      console.error('Stream audio error:', e);
      setError('Audio stream playback error');
      playNextInQueue();
    };
    
    return () => {
      if (streamAudioRef.current) {
        streamAudioRef.current.pause();
        if (streamAudioRef.current.src) {
          URL.revokeObjectURL(streamAudioRef.current.src);
        }
      }
    };
  }, []);

  // Generate unique message ID
  const generateMessageId = () => {
    messageIdCounter.current += 1;
    return `msg_${Date.now()}_${messageIdCounter.current}`;
  };

  // Add message using callback to avoid stale state
  const addMessage = useCallback((newMessage) => {
    setMessages(prevMessages => {
      console.log('Adding message:', newMessage);
      console.log('Previous messages count:', prevMessages.length);
      const updatedMessages = [...prevMessages, newMessage];
      console.log('New messages count:', updatedMessages.length);
      return updatedMessages;
    });
  }, []);

  // Play next audio chunk in the streaming queue
  const playNextInQueue = () => {
    if (streamQueueRef.current.length === 0) {
      setIsStreamPlaying(false);
      isPlayingStreamRef.current = false;
      setCurrentlyPlayingIndex(-1);
      return;
    }
    
    const nextChunk = streamQueueRef.current.shift();
    setCurrentlyPlayingIndex(nextChunk.index);
    
    if (streamAudioRef.current.src) {
      URL.revokeObjectURL(streamAudioRef.current.src);
    }
    
    streamAudioRef.current.src = nextChunk.audioUrl;
    streamAudioRef.current.volume = playbackVolume;
    
    streamAudioRef.current.play().catch(error => {
      console.error('Error playing stream chunk:', error);
      playNextInQueue();
    });
  };

  // Add audio chunk to streaming queue
  const addToStreamQueue = (audioUrl, messageIndex) => {
    streamQueueRef.current.push({ audioUrl, index: messageIndex });
    
    // If not currently playing, start the stream
    if (!isPlayingStreamRef.current) {
      setIsStreamPlaying(true);
      isPlayingStreamRef.current = true;
      playNextInQueue();
    }
  };

  // Stop the audio stream
  const stopAudioStream = () => {
    if (streamAudioRef.current) {
      streamAudioRef.current.pause();
      if (streamAudioRef.current.src) {
        URL.revokeObjectURL(streamAudioRef.current.src);
        streamAudioRef.current.src = '';
      }
    }
    
    // Clear queue and clean up URLs
    streamQueueRef.current.forEach(chunk => {
      if (chunk.audioUrl) {
        URL.revokeObjectURL(chunk.audioUrl);
      }
    });
    streamQueueRef.current = [];
    
    setIsStreamPlaying(false);
    isPlayingStreamRef.current = false;
    setCurrentlyPlayingIndex(-1);
  };

  // Update stream volume
  const updateStreamVolume = (newVolume) => {
    setPlaybackVolume(newVolume);
    if (streamAudioRef.current) {
      streamAudioRef.current.volume = newVolume;
    }
  };

  // Connect to WebSocket with retry logic
  const connectWebSocket = (url) => {
    try {
      setConnectionStatus('connecting');
      console.log('Connecting to WebSocket:', url);
      
      // Close existing connection if any
      if (wsRef.current) {
        wsRef.current.close();
      }
      
      wsRef.current = new WebSocket(url);

      wsRef.current.onopen = () => {
        setIsConnected(true);
        setConnectionStatus('connected');
        setError('');
        console.log('WebSocket connected successfully');
        
        // Clear any reconnection timeout
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      wsRef.current.onmessage = (event) => {
        console.log('WebSocket message received:', event.data);
        
        try {
          const data = JSON.parse(event.data);
          console.log('Parsed message data:', data);
          
          const messageId = generateMessageId();
          const currentMessageCount = messagesRef.current.length;
          const messageIndex = currentMessageCount;
          
          // Check if the message contains audio data (byte array)
          const isAudioData = data.array && Array.isArray(data.array) && data.array.length > 1000;
          let audioUrl = null;
          
          if (isAudioData) {
            // Convert byte array to audio blob
            const uint8Array = new Uint8Array(data.array);
            const audioBlob = new Blob([uint8Array], { type: 'audio/webm' });
            audioUrl = URL.createObjectURL(audioBlob);
            
            // Automatically add to streaming queue
            addToStreamQueue(audioUrl, messageIndex);
          }
          
          const newMessage = {
            id: messageId,
            timestamp: new Date().toLocaleString(),
            data: data,
            type: 'received',
            isAudio: isAudioData,
            audioUrl: audioUrl,
            userId: data.user_id || 'Unknown',
            isCurrentlyPlaying: false
          };
          
          console.log('Adding new message:', newMessage);
          addMessage(newMessage);
          
        } catch (e) {
          console.log('Non-JSON message received:', event.data);
          // Handle non-JSON messages
          const messageId = generateMessageId();
          const newMessage = {
            id: messageId,
            timestamp: new Date().toLocaleString(),
            data: event.data,
            type: 'received',
            isAudio: false,
            userId: 'Unknown',
            isCurrentlyPlaying: false
          };
          
          addMessage(newMessage);
        }
      };

      wsRef.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        setError('WebSocket connection error');
        setConnectionStatus('error');
      };

      wsRef.current.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        setIsConnected(false);
        setConnectionStatus('disconnected');
        
        // Attempt to reconnect after 3 seconds if not manually disconnected
        if (event.code !== 1000 && event.code !== 1001) {
          console.log('Attempting to reconnect in 3 seconds...');
          reconnectTimeoutRef.current = setTimeout(() => {
            if (wsUrl) {
              connectWebSocket(wsUrl);
            }
          }, 3000);
        }
      };

    } catch (err) {
      console.error('Failed to create WebSocket connection:', err);
      setError(`Failed to connect to WebSocket: ${err.message}`);
      setConnectionStatus('error');
    }
  };

  // Check browser support
  const checkAudioSupport = () => {
    const isSecureContext = window.isSecureContext || location.protocol === 'https:';
    const hasGetDisplayMedia = navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia;
    const hasGetUserMedia = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    
    return {
      isSecureContext,
      hasGetDisplayMedia,
      hasGetUserMedia,
      tabAudioSupported: isSecureContext && hasGetDisplayMedia,
      microphoneSupported: hasGetUserMedia
    };
  };

  // Start audio capture
  const startAudioCapture = async () => {
    const support = checkAudioSupport();
    
    try {
      let stream;
      
      if (captureMode === 'tab') {
        if (!support.tabAudioSupported) {
          throw new Error(
            !support.isSecureContext 
              ? 'Tab audio capture requires HTTPS. Try using https://localhost or deploy to a secure server.'
              : 'Tab audio capture is not supported in this browser. Try Chrome/Edge 74+ or Firefox 66+.'
          );
        }
        
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              sampleRate: 44100
            }
          });
          
          const audioTracks = stream.getAudioTracks();
          if (audioTracks.length === 0) {
            throw new Error('No audio track found. Make sure to check "Share tab audio" in the browser dialog.');
          }
          
          const videoTracks = stream.getVideoTracks();
          videoTracks.forEach(track => track.stop());
          
        } catch (displayError) {
          try {
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: false,
              audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 44100
              }
            });
          } catch (audioOnlyError) {
            throw new Error(`Tab audio capture failed: ${displayError.message}. Try selecting "Share tab audio" in the dialog, or switch to microphone mode.`);
          }
        }
        
      } else {
        if (!support.microphoneSupported) {
          throw new Error('Microphone access is not supported in this browser.');
        }
        
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 44100
          }
        });
      }

      streamRef.current = stream;

      audioContextRef.current = new AudioContext();
      const source = audioContextRef.current.createMediaStreamSource(stream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      source.connect(analyserRef.current);

      monitorAudioLevel();

      mediaRecorderRef.current = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await sendAudioData(audioBlob);
        audioChunksRef.current = [];
      };

      mediaRecorderRef.current.start();
      setIsCapturing(true);

      const interval = setInterval(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
          setTimeout(() => {
            if (streamRef.current && streamRef.current.active) {
              mediaRecorderRef.current.start();
            }
          }, 100);
        }
      }, AUDIO_CHUNK_SIZE);

      streamRef.current.intervalId = interval;

    } catch (err) {
      setError(`Failed to start audio capture: ${err.message}`);
      console.error('Audio capture error:', err);
    }
  };

  // Stop audio capture
  const stopAudioCapture = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      if (streamRef.current.intervalId) {
        clearInterval(streamRef.current.intervalId);
      }
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
    }

    setIsCapturing(false);
    setAudioLevel(0);
  };

  // Monitor audio levels for visual feedback
  const monitorAudioLevel = () => {
    if (!analyserRef.current) return;

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    
    const updateLevel = () => {
      if (!analyserRef.current || !isCapturing) return;
      
      analyserRef.current.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
      setAudioLevel(average);
      
      requestAnimationFrame(updateLevel);
    };
    
    updateLevel();
  };

  // Send audio data to server
  const sendAudioData = async (audioBlob) => {
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioArray = Array.from(new Uint8Array(arrayBuffer));

      const broadcastData = {
        user_id: userId,
        topic: topic,
        timestamp: Date.now(),
        array: audioArray
      };

      console.log('Sending audio data:', broadcastData);

      const response = await fetch(`${API_BASE_URL}/broadcast`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(broadcastData),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const messageId = generateMessageId();
      const sentMessage = {
        id: messageId,
        timestamp: new Date().toLocaleString(),
        data: `Audio chunk sent (${audioArray.length} bytes)`,
        type: 'sent',
        isAudio: false
      };

      addMessage(sentMessage);

    } catch (err) {
      console.error('Failed to send audio data:', err);
      setError(`Failed to send audio data: ${err.message}`);
    }
  };
  
  // Send broadcast message
  const sendBroadcast = async () => {
    if (!messageInput.trim()) return;

    try {
      const messageBytes = Array.from(new TextEncoder().encode(messageInput));
      
      const broadcastData = {
        user_id: userId,
        topic: topic,
        timestamp: Date.now(),
        array: messageBytes
      };

      console.log('Sending broadcast message:', broadcastData);

      const response = await fetch(`${API_BASE_URL}/broadcast`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(broadcastData),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const messageId = generateMessageId();
      const sentMessage = {
        id: messageId,
        timestamp: new Date().toLocaleString(),
        data: messageInput,
        type: 'sent',
        isAudio: false
      };

      addMessage(sentMessage);
      setMessageInput('');
      
    } catch (err) {
      console.error('Failed to send broadcast:', err);
      setError(`Failed to send broadcast: ${err.message}`);
    }
  };

  // Disconnect WebSocket
  const disconnect = () => {
    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnected'); // Normal closure
    }
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    // Stop audio stream and clean up
    stopAudioStream();
    
    // Clean up individual audio elements
    Object.values(audioElementsRef.current).forEach(audio => {
      if (audio?.src) {
        URL.revokeObjectURL(audio.src);
      }
    });
    audioElementsRef.current = {};
    
    setIsConnected(false);
    setMessages([]);
    setConnectionStatus('disconnected');
    setError('');
  };

  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'connected': return 'text-green-600';
      case 'connecting': return 'text-yellow-600';
      case 'error': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const getServerConnectionHealth = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/health`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      setServerHealth(response.ok);
    } catch (error) {
      console.error('Health check failed:', error);
      setServerHealth(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-6">
          <div className="flex justify-between items-center mb-4">
            <button
              onClick={() => navigate('/')}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
            >
              ← Back to Home
            </button>
            
            <div className="flex items-center gap-4">
              <div className={`flex items-center gap-2 px-3 py-2 rounded-full ${getStatusColor()}`}>
                <div className={`w-2 h-2 rounded-full ${
                  connectionStatus === 'connected' ? 'bg-green-500' : 
                  connectionStatus === 'connecting' ? 'bg-yellow-500 animate-pulse' :
                  connectionStatus === 'error' ? 'bg-red-500' : 'bg-gray-400'
                }`}></div>
                <span className="text-sm font-medium capitalize">{connectionStatus}</span>
              </div>
              
              {isConnected && (
                <button
                  onClick={disconnect}
                  className="px-3 py-1 bg-red-500 text-white text-sm rounded hover:bg-red-600"
                >
                  Disconnect
                </button>
              )}
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
              {error}
              <button
                onClick={() => setError('')}
                className="ml-2 text-red-500 hover:text-red-700"
              >
                ×
              </button>
            </div>
          )}

          {/* Music Player Section */}
          {
            <MusicPlayer/>
          }

          {/* Connection Info */}
          <div className="mb-6 p-4 bg-gray-50 rounded-lg">
            <h3 className="text-lg font-semibold mb-2">Connection Info</h3>
            <p className="text-sm text-gray-600">
              Topic: <span className="font-medium">{topic}</span> | 
              User ID: <span className="font-medium">{userId}</span> | 
              Messages: <span className="font-medium">{messages.length}</span>
            </p>
            <p className="text-sm text-gray-600">
              WebSocket URL: <span className="font-mono text-xs">{wsUrl}</span>
            </p>
          </div>
          
          {/* Audio Stream Controls */}
          {isConnected && (
            <div className="mb-6 p-4 bg-green-50 rounded-lg">
              <h3 className="text-lg font-semibold mb-4">Audio Stream Playback</h3>
              
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-4">
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-full ${
                    isStreamPlaying ? 'bg-green-200 text-green-800' : 'bg-gray-200 text-gray-600'
                  }`}>
                    <div className={`w-2 h-2 rounded-full ${
                      isStreamPlaying ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
                    }`}></div>
                    <span className="text-sm font-medium">
                      {isStreamPlaying ? 'Stream Playing' : 'Stream Idle'}
                    </span>
                  </div>
                  
                  {streamQueueRef.current?.length > 0 && (
                    <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                      {streamQueueRef.current.length} chunks queued
                    </span>
                  )}
                </div>
                
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-600">Volume:</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={playbackVolume}
                      onChange={(e) => updateStreamVolume(parseFloat(e.target.value))}
                      className="w-24"
                    />
                    <span className="text-xs text-gray-500 w-8">{Math.round(playbackVolume * 100)}%</span>
                  </div>
                  
                  {isStreamPlaying && (
                    <button
                      onClick={stopAudioStream}
                      className="px-3 py-1 bg-red-500 text-white text-sm rounded hover:bg-red-600"
                    >
                      Stop Stream
                    </button>
                  )}
                </div>
              </div>
              
              <p className="text-xs text-gray-600">
                🎵 Audio chunks are automatically played in sequence as they arrive, creating a continuous stream.
                {currentlyPlayingIndex >= 0 && ` Currently playing chunk #${currentlyPlayingIndex + 1}.`}
              </p>
            </div>
          )}

          {/* Audio Capture Section */}
          {isConnected && (
            <div className="mb-6 p-4 bg-purple-50 rounded-lg">
              <h3 className="text-lg font-semibold mb-4">Audio Capture</h3>
              
              <div className="flex items-center gap-4 mb-4">
                <select
                  value={captureMode}
                  onChange={(e) => setCaptureMode(e.target.value)}
                  disabled={isCapturing}
                  className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="tab">Browser Tab Audio</option>
                  <option value="microphone">Microphone</option>
                </select>
                
                {!isCapturing ? (
                  <button
                    onClick={startAudioCapture}
                    className="px-4 py-2 bg-purple-500 text-white rounded-md hover:bg-purple-600"
                  >
                    Start Capture
                  </button>
                ) : (
                  <button
                    onClick={stopAudioCapture}
                    className="px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600"
                  >
                    Stop Capture
                  </button>
                )}
              </div>

              {/* Audio Level Indicator */}
              {isCapturing && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm text-gray-600">Audio Level:</span>
                    <div className="flex-1 bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-purple-500 h-2 rounded-full transition-all duration-100"
                        style={{ width: `${Math.min(audioLevel * 2, 100)}%` }}
                      ></div>
                    </div>
                    <span className="text-xs text-gray-500">{Math.round(audioLevel)}</span>
                  </div>
                  <p className="text-xs text-gray-600">
                    🔴 Capturing audio and sending chunks every {AUDIO_CHUNK_SIZE}ms
                  </p>
                </div>
              )}

              <p className="text-xs text-gray-600">
                {captureMode === 'tab' 
                  ? 'Select "Share tab audio" when prompted to capture audio from another browser tab'
                  : 'Microphone audio will be captured directly'
                }
              </p>
            </div>
          )}

          {/* Text Message Input */}
          {isConnected && (
            <div className="mb-6 p-4 bg-blue-50 rounded-lg">
              <h3 className="text-lg font-semibold mb-4">Text Messages</h3>
              <div className="flex gap-4">
                <input
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  placeholder="Enter your message..."
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onKeyPress={(e) => e.key === 'Enter' && sendBroadcast()}
                />
                <button
                  onClick={sendBroadcast}
                  className="px-4 py-2 bg-green-500 text-white rounded-md hover:bg-green-600"
                >
                  Send Text
                </button>
              </div>
            </div>
          )}

          {/* Messages Display */}
          <div className="bg-white border rounded-lg h-96 overflow-y-auto">
            <div className="p-4">
              <h3 className="text-lg font-semibold mb-4">Messages & Audio Chunks</h3>
              {messages.length === 0 ? (
                <p className="text-gray-500 text-center py-8">No messages yet. Connect to a topic to start!</p>
              ) : (
                <div className="space-y-3">
                  {messages.map((message, index) => (
                    <div
                      key={message.id}
                      className={`p-3 rounded-lg ${
                        message.type === 'sent' 
                          ? 'bg-blue-100 ml-12' 
                          : message.isAudio && currentlyPlayingIndex === index
                            ? 'bg-green-200 mr-12 border-2 border-green-400'
                            : 'bg-gray-100 mr-12'
                      }`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium ${
                            message.type === 'sent' ? 'text-blue-600' : 'text-gray-600'
                          }`}>
                            {message.type === 'sent' ? 'You' : `User ${message.userId}`}
                          </span>
                          {message.isAudio && (
                            <div className="flex items-center gap-1">
                              <span className="text-xs bg-green-200 text-green-800 px-2 py-1 rounded">
                                🎵 Audio #{index + 1}
                              </span>
                              {currentlyPlayingIndex === index && (
                                <span className="text-xs bg-yellow-200 text-yellow-800 px-2 py-1 rounded animate-pulse">
                                  Playing
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <span className="text-xs text-gray-500">{message.timestamp}</span>
                      </div>
                      
                      <div className="text-sm mb-2">
                        {message.isAudio ? (
                          <div className="flex items-center gap-3">
                            <span>Audio stream chunk ({message.data.array?.length || 0} bytes)</span>
                            <span className="text-xs text-gray-500">
                              {currentlyPlayingIndex === index ? '🔊 Playing in stream' : '⏳ Queued for stream'}
                            </span>
                          </div>
                        ) : (
                          typeof message.data === 'string' ? message.data : JSON.stringify(message.data, null, 2)
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}