import { useEffect, useState, useRef } from "react";
import { windowBus, commandRegistry } from "./windowBus";
import { Events } from "./events";

/** 事件名的值类型（Events 枚举的值联合） */
type EventName = (typeof Events)[keyof typeof Events];

/** Subscribe to an event and return its latest emitted value. Re-renders on each emit. */
export function useEvent<T = any>(event: EventName): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const latestRef = useRef<T | undefined>(undefined);

  useEffect(() => {
    return windowBus.on(event, (data: T) => {
      latestRef.current = data;
      setValue(data);
    });
  }, [event]);

  return value;
}

/** Subscribe to an event with a side-effect handler. Cleaned up on unmount. */
export function useEventHandler<T = any>(event: EventName, handler: (data: T) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return windowBus.on(event, (data: T) => {
      handlerRef.current(data);
    });
  }, [event]);
}

/** Register a command handler. Cleaned up on unmount. */
export function useCommand(command: string, handler: (...args: any[]) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return commandRegistry.register(command, (...args: any[]) => {
      handlerRef.current(...args);
    });
  }, [command]);
}

/**
 * Hook that subscribes to an event and also returns a stable reference
 * to the latest value (no re-render on change — for callbacks).
 */
export function useEventLatest<T = any>(event: EventName): { current: T | undefined } {
  const ref = useRef<T | undefined>(undefined);

  useEffect(() => {
    return windowBus.on(event, (data: T) => {
      ref.current = data;
    });
  }, [event]);

  return ref;
}
