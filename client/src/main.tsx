import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import App from './App'
import Gallery from './Gallery'
import { adoptAccessCodeFromUrl } from './api'
// Typeface identity (design pass): Bricolage Grotesque for the display/brand
// face, IBM Plex Sans for readable body/UI, IBM Plex Mono for instrument-style
// numerics (phase/beat chips, tabular values). Bundled locally via @fontsource
// — no CDN. Imported before styles.css so the @font-face rules exist when the
// cascade resolves our --font-* custom properties. KaTeX ships its own math
// fonts (katex.min.css below) and is left untouched.
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import 'mafs/core.css'
import 'katex/dist/katex.min.css'
import './styles.css'

// Must run before Root's first render: `#code=…` is consumed (and cleared)
// here so the gallery-vs-app hash check below never sees it, and the very
// first /api/session call already carries the x-board-code header.
adoptAccessCodeFromUrl()

function Root() {
  const [isGallery, setIsGallery] = useState(window.location.hash === '#gallery')

  useEffect(() => {
    const handleHashChange = () => {
      setIsGallery(window.location.hash === '#gallery')
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  return isGallery ? <Gallery /> : <App />
}

createRoot(document.getElementById('root')!).render(<Root />)
