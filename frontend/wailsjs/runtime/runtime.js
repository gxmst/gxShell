import { Browser, Clipboard, Events } from "@wailsio/runtime";

export function EventsOn(name, callback) {
  if (window.runtime) return window.runtime.EventsOnMultiple(name, callback, -1);
  return Events.On(name, event => callback(event.data));
}
export function EventsOff(name) {
  if (window.runtime) return window.runtime.EventsOff(name);
  return Events.Off(name);
}
export function BrowserOpenURL(url) {
  if (window.runtime) return window.runtime.BrowserOpenURL(url);
  return Browser.OpenURL(url);
}
export function ClipboardSetText(text) {
  if (window.runtime) return window.runtime.ClipboardSetText(text);
  return Clipboard.SetText(text).then(() => true);
}
