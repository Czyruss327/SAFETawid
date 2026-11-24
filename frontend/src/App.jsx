import ConnectionGate from './components/ConnectionGate.jsx'
import './App.css'

// Check ESP32 setup connectivity before mounting the camera and monitoring dashboard.
function App() {
  return (
    <ConnectionGate />
  )
}

export default App
