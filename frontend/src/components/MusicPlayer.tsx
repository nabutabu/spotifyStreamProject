import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';

const API_BASE_URL = 'https://127.0.0.1:443/api';

// Music Player Component
export default function MusicPlayer() {
  const [hasAccessToken, setHasAccessToken] = useState(false);
  const [currentSong, setCurrentSong] = useState(null);
  const [queue, setQueue] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchCurrentSong = async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`${API_BASE_URL}/current_song`);

      if (response.ok) {
        const data = await response.json();
        setCurrentSong(data.item);
      } else if (response.status === 204) {
        // No song currently playing
        setCurrentSong(null);
      }
    } catch (err) {
      console.error('Failed to fetch current song:', err);
      setError('Failed to fetch current song');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchQueue = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/get_queue`);

      if (response.ok) {
        const data = await response.json();
        setQueue(data.queue || []);
      }
    } catch (err) {
      console.error('Failed to fetch queue:', err);
      setError('Failed to fetch queue');
    }
  };

  function getCookie(name: string): string | null {
    const cookies = document.cookie.split(';');

    for (const cookie of cookies) {
      const [key, ...rest] = cookie.trim().split('=');
      if (key === name) {
        return decodeURIComponent(rest.join('='));
      }
    }

    return null;
  }

  // Check for access_token cookie
  const checkAccessToken = () => {
    const accessTokenCookie = getCookie('isAuthenticated') === 'true';
    
    if (accessTokenCookie) {
      setHasAccessToken(true);
      fetchCurrentSong();
      fetchQueue();
    }
  };

  useEffect(() => {
    checkAccessToken();
  }, []);

  const formatDuration = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  if (!hasAccessToken) {
    return (
      <div className="mb-6 p-4 bg-gray-50 rounded-lg">
        <h3 className="text-lg font-semibold mb-2">Music Player</h3>
        <p className="text-sm text-gray-600">
          🎵 Connect your Spotify account to see your current song and queue
        </p>
        <div className="mt-3">
          <a
            href={`${API_BASE_URL}/spotify/login`}
            className="inline-block px-4 py-2 bg-green-500 text-white rounded-md hover:bg-green-600 transition-colors"
          >
            Connect Spotify
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 p-4 bg-gradient-to-r from-green-50 to-green-100 rounded-lg">
      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
        🎵 Your Music
        {isLoading && (
          <div className="w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin"></div>
        )}
      </h3>

      {error && (
        <div className="mb-4 p-3 bg-red-100 border border-red-300 text-red-700 rounded text-sm">
          {error}
        </div>
      )}

      {/* Current Song */}
      <div className="mb-4">
        <h4 className="text-md font-medium mb-2 text-green-800">Now Playing</h4>
        {currentSong ? (
          <div className="bg-white p-3 rounded-lg shadow-sm">
            <div className="flex items-center gap-3">
              {currentSong.album?.images?.[0]?.url && (
                <img
                  src={currentSong.album.images[0].url}
                  alt={currentSong.album.name}
                  className="w-12 h-12 rounded-md object-cover"
                />
              )}
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 truncate">
                  {currentSong.name}
                </p>
                <p className="text-sm text-gray-600 truncate">
                  {currentSong.artists?.map(artist => artist.name).join(', ')}
                </p>
                <p className="text-xs text-gray-500">
                  {currentSong.album?.name} • {formatDuration(currentSong.duration_ms)}
                </p>
              </div>
              {currentSong.external_urls?.spotify && (
                <a
                  href={currentSong.external_urls.spotify}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-green-600 hover:text-green-800 transition-colors"
                  title="Open in Spotify"
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424c-.18.295-.563.387-.857.207-2.348-1.435-5.304-1.76-8.785-.964-.335.077-.67-.133-.746-.47-.077-.334.132-.67.47-.746 3.809-.871 7.077-.496 9.713 1.115.294.18.386.563.206.858zm1.223-2.723c-.226.367-.706.482-1.073.257-2.687-1.652-6.785-2.131-9.965-1.166-.402.122-.824-.164-.946-.567-.123-.403.164-.824.567-.946 3.632-1.102 8.147-.568 11.156 1.329.366.226.482.707.256 1.073zm.105-2.835C14.692 8.95 9.375 8.775 6.297 9.71c-.493.15-1.016-.128-1.166-.62-.149-.493.129-1.016.621-1.166 3.532-1.073 9.404-.865 13.115 1.338.445.264.590.837.327 1.282-.264.444-.838.590-1.282.327z"/>
                  </svg>
                </a>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-white p-3 rounded-lg shadow-sm text-center text-gray-500">
            No song currently playing
          </div>
        )}
      </div>

      {/* Queue */}
      <div>
        <h4 className="text-md font-medium mb-2 text-green-800">
          Up Next ({queue.length} songs)
        </h4>
        {queue.length > 0 ? (
          <div className="bg-white rounded-lg shadow-sm max-h-64 overflow-y-auto">
            {queue.slice(0, 10).map((song, index) => (
              <div
                key={`${song.id}-${index}`}
                className="flex items-center gap-3 p-3 border-b border-gray-100 last:border-b-0 hover:bg-gray-50"
              >
                <div className="w-6 text-xs text-gray-500 text-center">
                  {index + 1}
                </div>
                {song.album?.images?.[2]?.url && (
                  <img
                    src={song.album.images[2].url}
                    alt={song.album.name}
                    className="w-10 h-10 rounded object-cover"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate text-sm">
                    {song.name}
                  </p>
                  <p className="text-xs text-gray-600 truncate">
                    {song.artists?.map(artist => artist.name).join(', ')}
                  </p>
                </div>
                <div className="text-xs text-gray-500">
                  {formatDuration(song.duration_ms)}
                </div>
              </div>
            ))}
            {queue.length > 10 && (
              <div className="p-3 text-center text-sm text-gray-500 bg-gray-50">
                + {queue.length - 10} more songs
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white p-3 rounded-lg shadow-sm text-center text-gray-500">
            No songs in queue
          </div>
        )}
      </div>
    </div>
  );
};