import { describe, it, expect } from "vitest";
import { formatMessageTime } from "./messageTime";

const now = new Date(2026, 7, 13, 12, 0, 0).getTime(); // 2026-08-13 12:00 本地

describe("formatMessageTime", () => {
  it("今天 → 只显示时分", () => {
    expect(formatMessageTime(new Date(2026, 7, 13, 9, 5).getTime(), now)).toBe("09:05");
  });

  it("昨天 → 昨天 + 时分", () => {
    expect(formatMessageTime(new Date(2026, 7, 12, 23, 40).getTime(), now)).toBe("昨天 23:40");
  });

  it("今年其他天 → MM-DD + 时分", () => {
    expect(formatMessageTime(new Date(2026, 7, 1, 8, 30).getTime(), now)).toBe("08-01 08:30");
  });

  it("跨年 → YYYY-MM-DD + 时分", () => {
    expect(formatMessageTime(new Date(2025, 11, 31, 20, 15).getTime(), now)).toBe("2025-12-31 20:15");
  });

  it("yesterdayLabel 可自定义", () => {
    expect(formatMessageTime(new Date(2026, 7, 12, 10, 0).getTime(), now, "Yesterday")).toBe("Yesterday 10:00");
  });
});
