import React from 'react'
import {createRoot} from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import './styles/markdown-viewer.css'
import App from './App'

const container = document.getElementById('root')

const root = createRoot(container!)

root.render(
    <React.StrictMode>
        <App/>
    </React.StrictMode>
)
