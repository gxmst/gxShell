import { lazy } from 'react'
import type { ConnectionForm } from './components/ConnectionWindow/ConnectionWindow'

const App = lazy(() => import('./App'))
const NativeTerminal = lazy(() => import('./components/NativeTerminal/NativeTerminal').then(m => ({ default: m.NativeTerminal })))
const WorkspaceWindow = lazy(() => import('./components/NativeTerminal/WorkspaceWindow').then(m => ({ default: m.WorkspaceWindow })))
const SessionPanelWindow = lazy(() => import('./components/NativeTerminal/SessionPanelWindow').then(m => ({ default: m.SessionPanelWindow })))
const ConnectionWindow = lazy(() => import('./components/ConnectionWindow/ConnectionWindow').then(m => ({ default: m.ConnectionWindow })))

const params = new URLSearchParams(window.location.search)
const form = params.get('connection') as ConnectionForm | null
const terminalID = params.get('terminal')
const panel = (['sftp', 'monitor', 'transfers'] as const).find(kind => params.has(kind))
const documentSession = params.get('document')

export default function WindowRoot() {
    if (params.has('approval')) return <WorkspaceWindow/>
    if (documentSession) return <WorkspaceWindow document={{sessionId: documentSession, path: params.get('path') || '', profileId: params.get('profile') || ''}}/>
    if (form && ['new','edit','bulk','quick'].includes(form)) return <ConnectionWindow kind={form} id={params.get('id') || ''}/>
    if (terminalID) return <NativeTerminal id={terminalID}/>
    if (panel) return <SessionPanelWindow id={params.get(panel)!} kind={panel}/>
    return <App/>
}
