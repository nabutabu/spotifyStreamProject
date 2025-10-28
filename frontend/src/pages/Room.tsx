import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { usePlaybackHeartbeat } from '../hooks/usePlaybackHeartbeat';
import { WebSocketProvider, useWebSocket } from '../contexts/WebSocketContext';
import MusicPlayer from '../components/MusicPlayer';

const AUDIO_CHUNK_SIZE = 500;

// Inner component that uses WebSocket context
function RoomContent() {
  const { topic } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [userId] = useState(location.state?.id || "");
  const [isHost] = useState(location.state?.is_host || false);

  console.log("RoomContent props:", { topic, userId, isHost, locationState: location.state });

  // Message state
  const [messages, setMessages] = useState([]);
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // UI states
  const [messageInput, setMessageInput] = useState('');
  const [isStreamPlaying, setIsStreamPlaying] = useState(false);
  const [playbackVolume, setPlaybackVolume] = useState(0.7);
  const [currentlyPlayingIndex, setCurrentlyPlayingIndex] = useState(-1);
  const [error, setError] = useState('');
  const [isCapturing, setIsCapturing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [captureMode, setCaptureMode] = useState('tab');

  // Playback sync state
  const [syncedPlaybackState, setSyncedPlaybackState] = useState(null);

  // Audio streaming queue and playback
  const streamQueueRef = useRef([]);
  const audioRef = useRef(null);

  // WebSocket context - now includes lastMessage
  const { isConnected, connectionStatus, sendMessage, lastMessage } = useWebSocket();

  // Host heartbeat for playback sync
  const { lastUpdate, error: heartbeatError } = usePlaybackHeartbeat(
    isHost, 
    topic || ''
  );

  // Display heartbeat errors
  useEffect(() => {
    if (heartbeatError) {
      setError(`Playback sync error: ${heartbeatError}`);
    }
  }, [heartbeatError]);

  // Manual heartbeat function
  const sendManualHeartbeat = async () => {
    try {
      const accessToken = localStorage.getItem('access_token');
      if (!accessToken) {
        setError('No Spotify access token available');
        return;
      }

      // Fetch current playback state
      const response = await fetch('https://api.spotify.com/v1/me/player', {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!response.ok) {
        if (response.status === 204) {
          setError('No active playback on Spotify');
          return;
        }
        throw new Error(`Failed to fetch playback: ${response.status}`);
      }

      const data = await response.json();

      // Fetch queue
      let queue = [];
      try {
        const queueResponse = await fetch('https://api.spotify.com/v1/me/player/queue', {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });

        if (queueResponse.ok) {
          const queueData = await queueResponse.json();
          queue = queueData.queue?.map((track) => track.uri) || [];
        }
      } catch (queueError) {
        console.warn('Failed to fetch queue:', queueError);
      }

      // Send through WebSocket
      sendMessage({
        action: 'UpdatePlayback',
        room_id: topic,
        track_uri: data.item?.uri || '',
        position_ms: data.progress_ms || 0,
        queue,
        timestamp: Date.now()
      });

      setError(''); // Clear any previous errors
      console.log('Manual heartbeat sent successfully');
    } catch (err) {
      console.error('Manual heartbeat error:', err);
      setError(`Manual heartbeat failed: ${err.message}`);
    }
  };

  // Fix: playNextChunk should always use the latest playbackVolume
  const playbackVolumeRef = useRef(playbackVolume);
  useEffect(() => {
    playbackVolumeRef.current = playbackVolume;
    if (audioRef.current) {
      audioRef.current.volume = playbackVolume;
    }
  }, [playbackVolume]);

  // Fix: playNextChunk should not be recreated on every render
  const playNextChunk = useCallback(() => {
    if (streamQueueRef.current.length === 0) {
      setIsStreamPlaying(false);
      setCurrentlyPlayingIndex(-1);
      return;
    }
    const { audioUrl, index } = streamQueueRef.current.shift();
    setCurrentlyPlayingIndex(index);
    setIsStreamPlaying(true);
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.onended = playNextChunk;
      audioRef.current.onerror = playNextChunk;
    }
    audioRef.current.src = audioUrl;
    audioRef.current.volume = playbackVolumeRef.current;
    audioRef.current.play().catch(() => playNextChunk());
  }, []);

  // Update stream volume
  const updateStreamVolume = (volume) => {
    setPlaybackVolume(volume);
  };

  // Stop audio stream
  const stopAudioStream = () => {
    setIsStreamPlaying(false);
    setCurrentlyPlayingIndex(-1);
    if (audioRef.current) {
      audioRef.current.pause();
      if (audioRef.current.src) {
        URL.revokeObjectURL(audioRef.current.src);
        audioRef.current.src = '';
      }
    }
    // Clean up all queued blobs
    streamQueueRef.current.forEach(({ audioUrl }) => {
      URL.revokeObjectURL(audioUrl);
    });
    streamQueueRef.current = [];
  };

  // Audio capture stubs
  const startAudioCapture = () => {
    setIsCapturing(true);
    setAudioLevel(0);
  };
  
  const stopAudioCapture = () => {
    setIsCapturing(false);
    setAudioLevel(0);
  };

  // Disconnect WebSocket
  const disconnect = () => {
    stopAudioStream();
    setMessages([]);
    setError('');
  };

  // Handle incoming WebSocket messages
  const handleWsMessage = useCallback((event) => {
    try {
      const data = JSON.parse(event.data);
      
      // Handle playback sync updates
      if (data.action === 'UpdatePlayback') {
        setSyncedPlaybackState({
          track_uri: data.track_uri,
          position_ms: data.position_ms,
          queue: data.queue || [],
          timestamp: data.timestamp || Date.now()
        });
        return;
      }

      // Handle audio chunks
      const isAudio = !!(data.array && Array.isArray(data.array));
      let audioUrl = null;
      
      if (isAudio) {
        const uint8Array = new Uint8Array(data.array);
        const audioBlob = new Blob([uint8Array], { type: 'audio/webm' });
        audioUrl = URL.createObjectURL(audioBlob);
        streamQueueRef.current.push({ audioUrl, index: messagesRef.current.length });
        
        // Start playback if not already playing
        if (!isStreamPlaying && streamQueueRef.current.length === 1) {
          playNextChunk();
        }
        data.audioUrl = audioUrl;
      }
      
      setMessages(prev => [...prev, {
        id: `msg_${Date.now()}`,
        timestamp: new Date().toLocaleString(),
        data,
        type: 'received',
        isAudio,
        userId: data.user_id || 'Unknown',
      }]);
    } catch {
      setMessages(prev => [...prev, {
        id: `msg_${Date.now()}`,
        timestamp: new Date().toLocaleString(),
        data: event.data,
        type: 'received',
        isAudio: false,
        userId: 'Unknown',
      }]);
    }
  }, [isStreamPlaying, playNextChunk]);

  // Listen to WebSocket messages from context
  useEffect(() => {
    if (lastMessage) {
      handleWsMessage(lastMessage);
    }
  }, [lastMessage, handleWsMessage]);

  // Send broadcast message
  const sendBroadcast = () => {
    if (!messageInput.trim()) return;
    sendMessage({
      action: 'Broadcast',
      user_id: userId,
      topic,
      timestamp: Date.now(),
      array: Array.from(new TextEncoder().encode(messageInput)),
    });
    setMessages(prev => [...prev, {
      id: `msg_${Date.now()}`,
      timestamp: new Date().toLocaleString(),
      data: messageInput,
      type: 'sent',
      isAudio: false,
      userId,
    }]);
    setMessageInput('');
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        if (audioRef.current.src) {
          URL.revokeObjectURL(audioRef.current.src);
        }
        audioRef.current = null;
      }
      streamQueueRef.current.forEach(({ audioUrl }) => {
        URL.revokeObjectURL(audioUrl);
      });
      streamQueueRef.current = [];
      messagesRef.current.forEach(msg => {
        if (msg.isAudio && msg.data?.audioUrl) {
          URL.revokeObjectURL(msg.data.audioUrl);
        }
      });
    };
  }, []);

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
              <div className={`flex items-center gap-2 px-3 py-2 rounded-full ${
                connectionStatus === 'connected' ? 'text-green-600' :
                connectionStatus === 'connecting' ? 'text-yellow-600' :
                connectionStatus === 'error' ? 'text-red-600' : 'text-gray-600'
              }`}>
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
          <MusicPlayer />

          {/* Playback Sync Status */}
          {isHost && (
            <div className="mb-6 p-4 bg-purple-50 rounded-lg">
              <h3 className="text-lg font-semibold mb-2">Host Playback Sync</h3>
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-600">
                  Status: <span className="font-medium text-purple-600">
                    {lastUpdate ? `Syncing (last: ${new Date(lastUpdate).toLocaleTimeString()})` : 'Initializing...'}
                  </span>
                </p>
                <button
                  onClick={sendManualHeartbeat}
                  disabled={!isConnected}
                  className={`px-4 py-2 rounded-md font-medium transition-colors ${
                    isConnected 
                      ? 'bg-purple-500 text-white hover:bg-purple-600' 
                      : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  }`}
                >
                  📡 Send Heartbeat Now
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                💡 Automatic sync runs every 5 seconds. Use the manual button to sync immediately.
              </p>
            </div>
          )}

          {/* Synced Playback State (for non-hosts) */}
          {!isHost && syncedPlaybackState && (
            <div className="mb-6 p-4 bg-blue-50 rounded-lg">
              <h3 className="text-lg font-semibold mb-2">Synced Playback</h3>
              <p className="text-sm text-gray-600">
                Track: <span className="font-medium">{syncedPlaybackState.track_uri}</span>
              </p>
              <p className="text-sm text-gray-600">
                Position: <span className="font-medium">{Math.floor(syncedPlaybackState.position_ms / 1000)}s</span>
              </p>
              {syncedPlaybackState.queue.length > 0 && (
                <p className="text-sm text-gray-600">
                  Queue: <span className="font-medium">{syncedPlaybackState.queue.length} tracks</span>
                </p>
              )}
            </div>
          )}

          {/* Connection Info */}
          <div className="mb-6 p-4 bg-gray-50 rounded-lg">
            <h3 className="text-lg font-semibold mb-2">Connection Info</h3>
            <p className="text-sm text-gray-600">
              Topic: <span className="font-medium">{topic}</span> | 
              User ID: <span className="font-medium">{userId}</span> | 
              Role: <span className="font-medium">{isHost ? 'Host' : 'Guest'}</span> |
              Messages: <span className="font-medium">{messages.length}</span>
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
                🎵 Audio chunks are automatically played in sequence as they arrive.
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
                <p className="text-gray-500 text-center py-8">No messages yet. Connect to start!</p>
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
                              {currentlyPlayingIndex === index ? '🔊 Playing' : '⏳ Queued'}
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

// Outer component with WebSocketProvider
export default function Room() {
  const location = useLocation();
  const [wsUrl] = useState(location.state?.wsUrl || '');
  const [userId] = useState(location.state?.id || "");

  console.log("Room component props:", { wsUrl, userId, locationState: location.state });

  return (
    <WebSocketProvider wsUrl={wsUrl} userId={userId}>
      <RoomContent />
    </WebSocketProvider>
  );
}