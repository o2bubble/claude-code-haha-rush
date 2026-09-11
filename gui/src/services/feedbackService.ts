import { getSettings } from "../stores/settingsStore";

const BASE = () => getSettings().skillRegistryUrl ?? "http://192.168.186.96:8765";

export interface FeedbackForm {
  type: "bug" | "suggestion";
  message: string;
  appVersion: string;
  image?: File;
}

export async function submitFeedback(form: FeedbackForm): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const fd = new FormData();
    fd.append("type", form.type);
    fd.append("message", form.message);
    fd.append("app_version", form.appVersion);
    if (form.image) {
      fd.append("image", form.image);
    }

    const res = await fetch(`${BASE()}/api/feedback`, {
      method: "POST",
      body: fd,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
