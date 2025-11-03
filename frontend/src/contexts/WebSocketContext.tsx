import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';

interface WebSocketContextType {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
  isConnected: boolean;
  connectionStatus: string;
  lastMessage: MessageEvent | null;
}

const WebSocketContext = createContext<WebSocketContextType>({
  ws: null,
  sendMessage: () => {},
  isConnected: false,
  connectionStatus: 'disconnected',
  lastMessage: null,
});

export const useWebSocket = () => useContext(WebSocketContext);

interface WebSocketProviderProps {
  wsUrl: string;
  userId: string;
  isHost?: boolean;
  children: React.ReactNode;
}

const API_BASE_URL = 'https://192.168.1.123:443/api';

export const WebSocketProvider: React.FC<WebSocketProviderProps> = ({
  wsUrl,
  userId,
  isHost = false,
  children
}) => {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [lastMessage, setLastMessage] = useState<MessageEvent | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Function to call backend start_playback endpoint
  const startPlayback = async (playbackState: any) => {
    try {
      console.log('Calling start_playback with:', playbackState);

      const response = await fetch(`${API_BASE_URL}/start_playback`, {
        method: 'POST',
        credentials: 'include', // Send HttpOnly cookies
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          track_uri: playbackState.track_uri,
          position_ms: playbackState.position_ms,
          queue: playbackState.queue || [],
          timestamp: playbackState.timestamp
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Failed to start playback:', response.status, errorText);
        return;
      }

      const result = await response.json();
      console.log('Start playback response:', result);
    } catch (error) {
      console.error('Error calling start_playback:', error);
    }
  };

  const connectWebSocket = useCallback(() => {
    if (!wsUrl) return;

    try {
      setConnectionStatus('connecting');
      console.log('Connecting to WebSocket:', wsUrl);

      // Close existing connection if any
      if (wsRef.current) {
        wsRef.current.close();
      }

      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        setIsConnected(true);
        setConnectionStatus('connected');
        console.log('WebSocket connected successfully');

        // Clear any reconnection timeout
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      wsRef.current.onmessage = async (event) => {
        console.log('WebSocket message received:', event.data);

        // Try to parse and check for PlaybackUpdate
        try {
          const data = JSON.parse(event.data);

          // Check for different possible message structures from backend
          // Structure 1: { type: 'PlaybackUpdate', playback_state: {...} }
          if (data.type === 'PlaybackUpdate' && data.playback_state && !isHost) {
            console.log('PlaybackUpdate (type) detected for guest, calling start_playback...');
            await startPlayback(data.playback_state);
          }
          // Structure 2: { action: 'UPDATE_PLAYBACK', playback_update: { playback_state: {...} } }
          else if (data.action === 'UPDATE_PLAYBACK' && data.playback_update?.playback_state && !isHost) {
            console.log('PlaybackUpdate (action) detected for guest, calling start_playback...');
            await startPlayback(data.playback_update.playback_state);
          }
          // Structure 3: Direct playback state with action field
          else if (data.action === 'UpdatePlayback' && !isHost) {
            console.log('UpdatePlayback action detected for guest, calling start_playback...');
            await startPlayback({
              track_uri: data.track_uri,
              position_ms: data.position_ms,
              queue: data.queue || [],
              timestamp: data.timestamp || Date.now()
            });
          }
        } catch (parseError) {
          console.log('Could not parse message as JSON or no playback update, treating as raw data');
        }

        // Always expose message through context for other handlers
        setLastMessage(event);
      };

      wsRef.current.onerror = (error) => {
        console.error('WebSocket error:', error);
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
            connectWebSocket();
          }, 3000);
        }
      };

    } catch (err: any) {
      console.error('Failed to create WebSocket connection:', err);
      setConnectionStatus('error');
    }
  }, [wsUrl, isHost]);

  useEffect(() => {
    if (wsUrl) {
      connectWebSocket();
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmounted');
      }

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [wsUrl, connectWebSocket]);

  const sendMessage = useCallback((message: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('Sending WebSocket message:', message);
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.error('WebSocket is not connected');
    }
  }, []);

  return (
    <WebSocketContext.Provider value={{
      ws: wsRef.current,
      sendMessage,
      isConnected,
      connectionStatus,
      lastMessage
    }}>
      {children}
    </WebSocketContext.Provider>
  );
};