import React from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
import { ErrorBoundary } from './components/ErrorBoundary'
import WindowRoot from './WindowRoot'

const container = document.getElementById('root')

const root = createRoot(container!)

root.render(
    <React.StrictMode>
        <ErrorBoundary>
            <React.Suspense fallback={null}><WindowRoot/></React.Suspense>
        </ErrorBoundary>
    </React.StrictMode>
)
