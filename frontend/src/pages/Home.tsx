import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const API_BASE_URL = 'https://127.0.0.1:443/api';

export default function Home() {
  const [topic, setTopic] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [userId, setUserId] = useState(1);
  const navigate = useNavigate();

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, topic: topic.trim() }),
      });
      setUserId((prev) => prev + 1);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      const websocketUrl = data.url;
      // On success, navigate to the Room page with wsUrl
      navigate(`/room/${encodeURIComponent(topic.trim())}`, { state: { userId, wsUrl: websocketUrl } });
    } catch (err) {
      setError(`Failed to register topic: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h1 className="text-3xl font-bold text-gray-800 mb-6">WebSocket Audio Stream App</h1>
          <div className="mb-6 p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-4 mb-4">
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Enter topic name (e.g., 'cats')"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isLoading}
              />
              <button
                onClick={registerTopic}
                disabled={isLoading}
                className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:bg-blue-300"
              >
                {isLoading ? 'Connecting...' : 'Connect'}
              </button>
            </div>
            {error && (
              <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
                {error}
              </div>
            )}
          </div>
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