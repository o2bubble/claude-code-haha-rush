// ── Status messages store — for StatusBar notification log ──

import { eventBus } from "../services/serviceBus";
import { Events } from "../services/events";

export interface StatusMessage {
  id: string;
  text: string;
  timestamp: number;
  level: "info" | "warn" | "error" | "success";
}

let messages: StatusMessage[] = [];
let listeners: Array<() => void> = [];

function notify() {
  for (const fn of listeners) fn();
}

export function getStatusMessages(): StatusMessage[] {
  return messages;
}

export function addStatusMessage(text: string, level: StatusMessage["level"] = "info") {
  messages = [
    ...messages.slice(-99), // keep last 100 max
    { id: crypto.randomUUID(), text, timestamp: Date.now(), level },
  ];
  notify();
}

export function clearStatusMessages() {
  messages = [];
  notify();
}

export function subscribeStatusMessages(fn: () => void) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter(l => l !== fn);
  };
}
