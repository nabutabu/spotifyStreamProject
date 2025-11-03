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

  // Music Player refresh trigger - increments when playback state changes
  const [musicPlayerRefreshTrigger, setMusicPlayerRefreshTrigger] = useState(0);

  // Audio streaming queue and playback
  const streamQueueRef = useRef([]);
  const audioRef = useRef(null);

  // WebSocket context - now includes lastMessage
  const { isConnected, connectionStatus, sendMessage, lastMessage } = useWebSocket();

  // Host heartbeat for playback sync - with callback to refresh MusicPlayer
  const { lastUpdate, error: heartbeatError } = usePlaybackHeartbeat(
    isHost,
    topic || '',
    5000, // 5 second interval
    (state) => {
      // When host playback state updates, trigger MusicPlayer refresh
      console.log('Host playback state updated:', state);
      setMusicPlayerRefreshTrigger(prev => prev + 1);
    }
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
        action: 'UPDATE_PLAYBACK',
        playback_update: {
          room_id: topic,
          playback_state: {
            track_uri: data.item?.uri || '',
            position_ms: data.progress_ms || 0,
            queue,
            timestamp: Date.now()
          }
        }
      });

      // Trigger MusicPlayer refresh
      setMusicPlayerRefreshTrigger(prev => prev + 1);
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

      // Handle playback sync updates from multiple possible message formats
      if (data.action === 'UpdatePlayback' || data.action === 'UPDATE_PLAYBACK' || data.type === 'PlaybackUpdate') {
        const playbackState = data.playback_state ||
          data.playback_update?.playback_state || {
            track_uri: data.track_uri,
            position_ms: data.position_ms,
            queue: data.queue || [],
            timestamp: data.timestamp || Date.now()
          };

        setSyncedPlaybackState(playbackState);

        // Trigger MusicPlayer to refresh immediately when playback state changes
        console.log('Playback state change detected, refreshing MusicPlayer...');
        setMusicPlayerRefreshTrigger(prev => prev + 1);
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
          {/* Header with back button and connection status */}
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

          {/* Music Player Section - Pass refresh trigger */}
          <MusicPlayer
            isHost={isHost}
            refreshInterval={5000}
            externalRefreshTrigger={musicPlayerRefreshTrigger}
          />

          {/* Rest of the component remains the same... */}
          {/* Playback Sync Status, Connection Info, Audio Controls, etc. */}
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
  const [isHost] = useState(location.state?.is_host || false);

  console.log("Room component props:", { wsUrl, userId, isHost, locationState: location.state });

  return (
    <WebSocketProvider wsUrl={wsUrl} userId={userId} isHost={isHost}>
      <RoomContent />
    </WebSocketProvider>
  );
}