import { useEffect, useRef, useState } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';

interface PlaybackState {
  track_uri: string;
  position_ms: number;
  queue: string[];
  timestamp: number;
}

const API_BASE_URL = 'https://192.168.1.123:443/api';

export const usePlaybackHeartbeat = (
  isHost: boolean,
  roomId: string,
  intervalMs: number = 5000
) => {
  const { sendMessage, isConnected } = useWebSocket();
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [error, setError] = useState<string>('');
  const heartbeatRef = useRef<NodeJS.Timeout | null>(null);

  const fetchPlaybackState = async (): Promise<PlaybackState | null> => {
    try {
      // Call your backend endpoint that reads the HttpOnly cookie
      const response = await fetch(`${API_BASE_URL}/current_song`, {
        method: 'GET',
        credentials: 'include', // CRITICAL: This sends the HttpOnly cookie
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          console.warn('Not authenticated with Spotify');
          return null;
        }
        throw new Error(`Failed to fetch playback state: ${response.status}`);
      }

      const data = await response.json();
      
      // Check if Spotify returned empty response (no active playback)
      if (!data || !data.item) {
        console.log('No active playback on Spotify');
        return null;
      }

      // Fetch queue through backend as well
      let queue: string[] = [];
      try {
        const queueResponse = await fetch(`${API_BASE_URL}/get_queue`, {
          method: 'GET',
          credentials: 'include', // Send cookie
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if (queueResponse.ok) {
          const queueData = await queueResponse.json();
          queue = queueData.queue?.map((track: any) => track.uri) || [];
        }
      } catch (queueError) {
        console.warn('Failed to fetch queue:', queueError);
      }

      return {
        track_uri: data.item?.uri || '',
        position_ms: data.progress_ms || 0,
        queue,
        timestamp: Date.now()
      };
    } catch (error: any) {
      console.error('Failed to fetch playback state:', error);
      setError(error.message);
      return null;
    }
  };

  useEffect(() => {
    if (!isHost || !isConnected) {
      return;
    }

    const heartbeat = async () => {
      try {
        const currentState = await fetchPlaybackState();
        if (currentState) {
          // Send through WebSocket
          sendMessage({
            action: 'UpdatePlayback',
            room_id: roomId,
            track_uri: currentState.track_uri,
            position_ms: currentState.position_ms,
            queue: currentState.queue,
            timestamp: currentState.timestamp
          });

          setLastUpdate(Date.now());
          setError('');
        }
      } catch (err: any) {
        console.error('Heartbeat error:', err);
        setError(err.message);
      }
    };

    // Run immediately
    heartbeat();

    // Set up interval
    heartbeatRef.current = setInterval(heartbeat, intervalMs);

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
      }
    };
  }, [isHost, isConnected, roomId, intervalMs, sendMessage]);

  return { lastUpdate, error };
};