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
  children: React.ReactNode;
}

export const WebSocketProvider: React.FC<WebSocketProviderProps> = ({
  wsUrl,
  userId,
  children
}) => {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [lastMessage, setLastMessage] = useState<MessageEvent | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

      wsRef.current.onmessage = (event) => {
        console.log('WebSocket message received:', event.data);
        // Expose message through context instead of callback
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
  }, [wsUrl]);

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