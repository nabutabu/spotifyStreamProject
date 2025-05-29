import { useState, useEffect, useRef } from 'react';

const API_BASE_URL = 'http://localhost:8000';
const AUDIO_CHUNK_SIZE = 500; // Size of each audio chunk in milliseconds

export default function WebSocketTopicApp() {
  const [topic, setTopic] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [wsUrl, setWsUrl] = useState('');
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [serverHealth, setServerHealth] = useState(false);
  const [userId, setUserId] = useState(1); // Now using state for user ID
  
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

  // Register topic and get WebSocket URL
  const registerTopic = async () => {
    if (!topic.trim()) {
      setError('Please enter a topic name');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE_URL}/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_id: userId,
          topic: topic.trim()
        }),
      });

      // Increment user ID after successful registration
      setUserId(prevId => prevId + 1);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const websocketUrl = data.url || `ws://localhost:8000/ws/${topic}`;
      
      setWsUrl(websocketUrl);
      connectWebSocket(websocketUrl);
      
    } catch (err) {
      setError(`Failed to register topic: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

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

  // Connect to WebSocket
  const connectWebSocket = (url) => {
    try {
      setConnectionStatus('connecting');
      wsRef.current = new WebSocket(url);

      wsRef.current.onopen = () => {
        setIsConnected(true);
        setConnectionStatus('connected');
        setError('');
        console.log('WebSocket connected');
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const messageId = Date.now() + Math.random();
          const messageIndex = messages.length;
          
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
          
          setMessages(prev => [...prev, newMessage]);
          
        } catch (e) {
          // Handle non-JSON messages
          setMessages(prev => [...prev, {
            id: Date.now() + Math.random(),
            timestamp: new Date().toLocaleString(),
            data: event.data,
            type: 'received',
            isAudio: false,
            userId: 'Unknown',
            isCurrentlyPlaying: false
          }]);
        }
      };

      wsRef.current.onerror = (error) => {
        setError('WebSocket error occurred');
        setConnectionStatus('error');
        console.error('WebSocket error:', error);
      };

      wsRef.current.onclose = () => {
        setIsConnected(false);
        setConnectionStatus('disconnected');
        console.log('WebSocket disconnected');
      };

    } catch (err) {
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
      }, AUDIO_CHUNK_SIZE); // Send audio data every 500ms

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

      setMessages(prev => [...prev, {
        id: Date.now(),
        timestamp: new Date().toLocaleString(),
        data: `Audio chunk sent (${audioArray.length} bytes)`,
        type: 'sent',
        isAudio: false
      }]);

    } catch (err) {
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

      setMessages(prev => [...prev, {
        id: Date.now(),
        timestamp: new Date().toLocaleString(),
        data: messageInput,
        type: 'sent',
        isAudio: false
      }]);

      setMessageInput('');
      
    } catch (err) {
      setError(`Failed to send broadcast: ${err.message}`);
    }
  };

  // Disconnect WebSocket
  const disconnect = () => {
    if (wsRef.current) {
      wsRef.current.close();
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
    setWsUrl('');
    setMessages([]);
    setConnectionStatus('disconnected');
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
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
  }, []);

  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'connected': return 'text-green-600';
      case 'connecting': return 'text-yellow-600';
      case 'error': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const getServerConnectionHealth = async () => {
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      setServerHealth(true);
    } else {
      setServerHealth(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h1 className="text-3xl font-bold text-gray-800 mb-6">WebSocket Audio Stream App</h1>
          
          {/* Connection Section */}
          <div className="mb-6 p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-4 mb-4">
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Enter topic name (e.g., 'cats')"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isConnected}
              />
              {!isConnected ? (
                <button
                  onClick={registerTopic}
                  disabled={isLoading}
                  className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:bg-blue-300"
                >
                  {isLoading ? 'Connecting...' : 'Connect'}
                </button>
              ) : (
                <button
                  onClick={disconnect}
                  className="px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600"
                >
                  Disconnect
                </button>
              )}
            </div>
            
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">Status:</span>
              <span className={`text-sm font-medium ${getStatusColor()}`}>
                {connectionStatus.charAt(0).toUpperCase() + connectionStatus.slice(1)}
              </span>
              {wsUrl && (
                <span className="text-xs text-gray-500 ml-2">({wsUrl})</span>
              )}
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
              {error}
            </div>
          )}

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
                    🔴 Capturing audio and sending chunks every 2 seconds
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
              <p className="text-xs text-gray-600 mt-2">
                Topic: <span className="font-medium">{topic}</span> | User ID: {userId}
              </p>
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

          {/* API Info */}
          <div className="mt-6 p-4 bg-gray-100 rounded-lg">
            <h4 className="font-semibold mb-2">Features:</h4>
            <div className="text-sm text-gray-700 space-y-1">
              <p>• <strong>Tab Audio Capture:</strong> Captures audio from another browser tab</p>
              <p>• <strong>Microphone Capture:</strong> Captures audio from system microphone</p>
              <p>• <strong>Real-time Streaming:</strong> Sends audio chunks every 2 seconds</p>
              <p>• <strong>Streaming Audio Playback:</strong> Continuous audio stream from received chunks</p>
              <p>• <strong>Auto-stream:</strong> Automatically plays incoming audio chunks in sequence</p>
              <p>• <strong>Queue Management:</strong> Manages playback queue for seamless streaming</p>
              <p>• <strong>Audio Level Monitoring:</strong> Visual feedback of audio input</p>
              <p>• <strong>Binary Data:</strong> Converts audio to byte arrays for your Rust server</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}