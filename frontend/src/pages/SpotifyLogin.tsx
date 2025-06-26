import { useState, useEffect, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { Music, Headphones, Play } from 'lucide-react';

var client_id = '33761d48be7b443485a146820010cfc7';
var redirect_uri = 'https://127.0.0.1/api/callback';

export default function SpotifyLogin() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [userInfo, setUserInfo] = useState(null);
    const [topic] = useState(location.state?.topic || '');

    const loginToSpotify = useCallback(() => {
        setIsLoading(true);
        setError('');
        
        const scope = [
            'user-read-private',
            'user-read-email',
            'user-read-playback-state',
            'user-modify-playback-state',
            'streaming',
        ].join(' ');

        const state = crypto.randomUUID(); // or some secure nonce
        const authUrl = `https://accounts.spotify.com/authorize` +
            `?client_id=${client_id}` +
            `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
            `&scope=${encodeURIComponent(scope)}` +
            `&response_type=code` +
            `&state=${state}` +
            `&show_dialog=false`;

        window.location.href = authUrl;
    }, []);

    if (isAuthenticated && userInfo) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-green-900 via-black to-green-800 flex items-center justify-center p-4">
                <div className="max-w-md w-full bg-black/30 backdrop-blur-lg rounded-3xl p-8 border border-green-500/20 shadow-2xl text-center">
                    <div className="mb-6">
                        <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-green-500 flex items-center justify-center">
                            <Music className="w-10 h-10 text-black" />
                        </div>
                        <h1 className="text-2xl font-bold text-white mb-2">Welcome back!</h1>
                        <p className="text-green-200 text-sm">
                            Successfully connected to Spotify
                        </p>
                    </div>

                    <div className="mb-6 p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
                        <p className="text-white font-medium">{userInfo.display_name}</p>
                        <p className="text-green-300 text-sm">{userInfo.email}</p>
                        <p className="text-green-400 text-xs mt-1">
                            {userInfo.followers?.total || 0} followers
                        </p>
                    </div>

                    <button
                        onClick={handleContinue}
                        className="w-full bg-green-500 hover:bg-green-400 text-black font-semibold py-4 px-6 rounded-full transition-all duration-300 transform hover:scale-105 active:scale-95 flex items-center justify-center gap-3 shadow-lg hover:shadow-green-500/25"
                    >
                        <Play className="w-5 h-5" />
                        Continue to App
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-green-900 via-black to-green-800 flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-black/30 backdrop-blur-lg rounded-3xl p-8 border border-green-500/20 shadow-2xl">
                {/* Header */}
                <div className="text-center mb-8">
                    <div className="flex items-center justify-center mb-4">
                        <div className="relative">
                            <Music className="w-16 h-16 text-green-400" />
                            <div className="absolute -top-1 -right-1 w-6 h-6 bg-green-400 rounded-full flex items-center justify-center">
                                <Play className="w-3 h-3 text-black fill-current" />
                            </div>
                        </div>
                    </div>
                    <h1 className="text-3xl font-bold text-white mb-2">Connect to Spotify</h1>
                    <p className="text-green-200 text-sm opacity-80">
                        Link your Spotify account to start sharing music
                    </p>
                </div>

                {/* Error Message */}
                {error && (
                    <div className="mb-6 p-4 bg-red-500/20 border border-red-500/30 rounded-lg">
                        <p className="text-red-300 text-sm text-center">{error}</p>
                    </div>
                )}

                {/* Login Button */}
                <button
                    onClick={loginToSpotify}
                    disabled={isLoading}
                    className="w-full bg-green-500 hover:bg-green-400 disabled:bg-green-500/50 disabled:cursor-not-allowed text-black font-semibold py-4 px-6 rounded-full transition-all duration-300 transform hover:scale-105 active:scale-95 flex items-center justify-center gap-3 shadow-lg hover:shadow-green-500/25"
                >
                    {isLoading ? (
                        <>
                            <div className="w-5 h-5 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                            Connecting...
                        </>
                    ) : (
                        <>
                            <Headphones className="w-5 h-5" />
                            Login with Spotify
                        </>
                    )}
                </button>

                {/* Features */}
                <div className="mt-8 space-y-3">
                    <div className="flex items-center gap-3 text-green-200 text-sm">
                        <div className="w-2 h-2 bg-green-400 rounded-full flex-shrink-0" />
                        <span>Stream music together with friends</span>
                    </div>
                    <div className="flex items-center gap-3 text-green-200 text-sm">
                        <div className="w-2 h-2 bg-green-400 rounded-full flex-shrink-0" />
                        <span>Control playback from any device</span>
                    </div>
                    <div className="flex items-center gap-3 text-green-200 text-sm">
                        <div className="w-2 h-2 bg-green-400 rounded-full flex-shrink-0" />
                        <span>Discover new music together</span>
                    </div>
                </div>

                {/* Footer */}
                <div className="mt-8 text-center">
                    <p className="text-xs text-green-300/60">
                        By connecting, you agree to Spotify's terms of service
                    </p>
                </div>
            </div>

            {/* Background Animation */}
            <div className="fixed inset-0 -z-10 overflow-hidden">
                <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-green-500/10 rounded-full blur-3xl animate-pulse" />
                <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-green-600/5 rounded-full blur-3xl animate-pulse delay-1000" />
            </div>
        </div>
    );
}