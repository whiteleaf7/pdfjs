import { PdfViewer } from './components/PdfViewer'
import './components/PdfViewer.css'
import './App.css'

function App() {
  return (
    <div className="app">
      <h1>PDF Viewer</h1>
      <PdfViewer scale={1.5} />
    </div>
  )
}

export default App
