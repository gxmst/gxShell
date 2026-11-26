export function EventsOn(name: string, callback: (...args: any[]) => void): () => void;
export function EventsOff(name: string): void;
export function BrowserOpenURL(url: string): Promise<void>;
export function ClipboardSetText(text: string): Promise<boolean>;
