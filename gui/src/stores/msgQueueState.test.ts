// ── 消息队列 · 纯状态机测试（T1）──
// 接缝：msgQueueState.ts 纯函数（无副作用、无 localStorage）

import { describe, it, expect } from "vitest";
import {
  createQueue, enqueue, interrupt, resume, sendNow, moveItem,
  removeAt, clearQueue, updateText, drainHead,
  persistQueueData, loadQueueData,
} from "./msgQueueState";

let seq = 0;
const nid = () => `id${++seq}`;

describe("createQueue", () => {
  it("默认 auto", () => {
    expect(createQueue()).toEqual({ messages: [], autoSend: true });
  });
  it("可指定初始 autoSend", () => {
    expect(createQueue(false).autoSend).toBe(false);
  });
});

describe("enqueue", () => {
  it("追加消息并带 id", () => {
    const q = enqueue(createQueue(), "hello", 20, nid)!;
    expect(q.messages).toEqual([{ id: "id1", text: "hello" }]);
    expect(q.autoSend).toBe(true);
  });

  it("空队列入队 → 恢复 auto（即使之前 paused）", () => {
    const pausedEmpty = { messages: [], autoSend: false };
    const q = enqueue(pausedEmpty, "x", 20, nid)!;
    expect(q.autoSend).toBe(true);
  });

  it("非空队列入队 → 保持当前 autoSend（paused 保持 paused）", () => {
    const q0 = enqueue(createQueue(), "a", 20, nid)!;
    const paused = { ...interrupt(q0), messages: [...q0.messages, { id: "id9", text: "b" }] };
    const q = enqueue(paused, "c", 20, nid)!;
    expect(q.messages.map((m) => m.text)).toEqual(["a", "b", "c"]);
    expect(q.autoSend).toBe(false); // paused 时入队不自动恢复
  });

  it("满队列 → 拒绝（返回 null，状态不变）", () => {
    let q = createQueue();
    for (let i = 0; i < 20; i++) q = enqueue(q, `m${i}`, 20, nid)!;
    const before = q;
    expect(enqueue(q, "overflow", 20, nid)).toBeNull();
    expect(q).toEqual(before);
  });
});

describe("interrupt / resume", () => {
  it("interrupt → paused（消息保留）", () => {
    const q0 = enqueue(createQueue(), "a", 20, nid)!;
    expect(interrupt(q0)).toEqual({ messages: q0.messages, autoSend: false });
  });
  it("空队列 interrupt → 保持 auto（无需手动恢复后续新队列）", () => {
    const q = createQueue();
    expect(interrupt(q)).toBe(q); // 无状态变更
    expect(interrupt(q).autoSend).toBe(true);
  });
  it("resume → auto", () => {
    expect(resume(interrupt(createQueue())).autoSend).toBe(true);
  });
});

describe("sendNow（立即发送）", () => {
  it("提到队首", () => {
    const q0 = enqueue(enqueue(createQueue(), "a", 20, nid)!, "b", 20, nid)!;
    const q = sendNow(q0, 1);
    expect(q.messages.map((m) => m.text)).toEqual(["b", "a"]);
  });
  it("paused → 提到队首并恢复 auto", () => {
    let q = enqueue(enqueue(createQueue(), "a", 20, nid)!, "b", 20, nid)!;
    q = interrupt(q);
    q = sendNow(q, 1);
    expect(q.messages.map((m) => m.text)).toEqual(["b", "a"]);
    expect(q.autoSend).toBe(true);
  });
  it("越界索引无操作", () => {
    const q = createQueue();
    expect(sendNow(q, 5)).toBe(q);
  });
});

describe("moveItem", () => {
  it("上移", () => {
    let q = createQueue();
    for (const t of ["a", "b", "c"]) q = enqueue(q, t, 20, nid)!;
    expect(moveItem(q, 2, 0).messages.map((m) => m.text)).toEqual(["c", "a", "b"]);
  });
  it("下移", () => {
    let q = createQueue();
    for (const t of ["a", "b", "c"]) q = enqueue(q, t, 20, nid)!;
    expect(moveItem(q, 0, 2).messages.map((m) => m.text)).toEqual(["b", "c", "a"]);
  });
  it("to 越界被 clamp", () => {
    let q = createQueue();
    for (const t of ["a", "b", "c"]) q = enqueue(q, t, 20, nid)!;
    expect(moveItem(q, 0, 99).messages.map((m) => m.text)).toEqual(["b", "c", "a"]);
  });
  it("from 越界无操作", () => {
    const q = createQueue();
    expect(moveItem(q, 9, 0)).toBe(q);
  });
});

describe("removeAt / clearQueue", () => {
  it("removeAt 删除指定项", () => {
    let q = createQueue();
    for (const t of ["a", "b", "c"]) q = enqueue(q, t, 20, nid)!;
    expect(removeAt(q, 1).messages.map((m) => m.text)).toEqual(["a", "c"]);
  });
  it("clearQueue 清空消息，autoSend 不变", () => {
    let q = createQueue();
    for (const t of ["a", "b"]) q = enqueue(q, t, 20, nid)!;
    q = interrupt(q);
    expect(clearQueue(q)).toEqual({ messages: [], autoSend: false });
  });
});

describe("updateText", () => {
  it("替换文本", () => {
    let q = createQueue();
    q = enqueue(q, "old", 20, nid)!;
    expect(updateText(q, 0, "new").messages[0].text).toBe("new");
  });
  it("越界无操作", () => {
    const q = createQueue();
    expect(updateText(q, 3, "x")).toBe(q);
  });
});

describe("drainHead", () => {
  it("取出队首并移除", () => {
    let q = createQueue();
    for (const t of ["a", "b"]) q = enqueue(q, t, 20, nid)!;
    const { queue, msg } = drainHead(q);
    expect(msg?.text).toBe("a");
    expect(queue.messages.map((m) => m.text)).toEqual(["b"]);
  });
  it("空队列 → msg null", () => {
    expect(drainHead(createQueue()).msg).toBeNull();
  });
});

describe("持久化（persist / load）", () => {
  it("persist 只存 messages（丢弃 autoSend）", () => {
    let q = createQueue();
    q = enqueue(q, "a", 20, nid)!;
    q = interrupt(q);
    const parsed = JSON.parse(persistQueueData({ s1: q }));
    expect(Object.keys(parsed.s1)).toEqual(["messages"]); // 不含 autoSend
    expect(parsed.s1.messages[0]).toMatchObject({ text: "a" });
  });

  it("load 恢复: 非空一律 paused, 空队列保持 auto", () => {
    const raw = JSON.stringify({ s1: { messages: [{ id: "x", text: "a" }] }, s2: { messages: [] } });
    const data = loadQueueData(raw);
    expect(data.s1.messages).toEqual([{ id: "x", text: "a" }]);
    expect(data.s1.autoSend).toBe(false); // 非空 → 重启保护 paused
    expect(data.s2).toEqual({ messages: [], autoSend: true }); // 空 → auto
  });

  it("load 过滤畸形条目", () => {
    const raw = JSON.stringify({ ok: { messages: [{ id: "1", text: "hi" }] }, bad: { messages: "nope" }, empty: null });
    const data = loadQueueData(raw);
    expect(data.ok.messages).toEqual([{ id: "1", text: "hi" }]);
    expect(data.bad).toBeUndefined();
    expect(data.empty).toBeUndefined();
  });
});
