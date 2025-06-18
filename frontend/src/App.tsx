import { Routes, Route, Link } from 'react-router-dom';
import Home from './pages/Home';
import Room from './pages/Room';
import SpotifyLogin from './pages/SpotifyLogin';

function App() {
  return (
    <div>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/SpotifyLogin" element={<SpotifyLogin />} />
        <Route path="/room/:topic" element={<Room />} />
      </Routes>
    </div>
  );
}

export default App;