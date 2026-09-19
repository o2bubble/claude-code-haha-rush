"""鼠标键盘插件的测试靶子 —— 一个能读回自己状态的窗口。

不拿真实界面做实验：这个窗口带一个按钮和一个输入框，并把**控件的绝对坐标 +
当前状态**持续写到 state 文件里，测试脚本据此验证点击/输入/拖拽是否真的生效。

用法：
    python mk_target.py <state_file>
    关掉它：kill 进程即可
"""
import json
import sys
import tkinter as tk

STATE = sys.argv[1]

root = tk.Tk()
root.title("MKTestTarget")
root.geometry("420x300+260+220")

clicked = {"n": 0}


def on_click():
    clicked["n"] += 1
    root.title(f"CLICKED-{clicked['n']}")


btn = tk.Button(root, text="点我", command=on_click, width=18, height=3)
btn.pack(pady=18)

entry = tk.Entry(root, width=40, font=("Segoe UI", 11))
entry.pack(pady=10)
entry.focus_set()

hint = tk.Label(root, text="(测试靶子 · 可安全关闭)", fg="#888")
hint.pack(pady=4)

# 滚轮事件计数 —— 区分"滚轮消息根本没到窗口"与"到了但控件不吃"
wheel_events = {"n": 0, "delta": 0}


def on_wheel(ev):
    wheel_events["n"] += 1
    wheel_events["delta"] = ev.delta
    return "break"


root.bind("<MouseWheel>", on_wheel)

# 可滚动区域 —— 验证 scroll action（读回 yview 就知道有没有真的滚）
txt = tk.Text(root, height=5, width=40, font=("Consolas", 10))
for i in range(200):
    txt.insert("end", f"行 {i}\n")
txt.pack(pady=4)


def dump():
    """把控件绝对坐标与当前状态写盘 —— 测试脚本读它验证操作是否真的落地。"""
    try:
        data = {
            "title": root.title(),
            "clickCount": clicked["n"],
            "entryText": entry.get(),
            "textYView": round(txt.yview()[0], 4),   # 0=顶部,越大越靠下
            "wheelEvents": wheel_events["n"],        # 窗口收到的滚轮事件数
            "wheelDelta": wheel_events["delta"],
            "win": {
                "x": root.winfo_rootx(), "y": root.winfo_rooty(),
                "w": root.winfo_width(), "h": root.winfo_height(),
            },
            "btn": {
                "x": btn.winfo_rootx() + btn.winfo_width() // 2,
                "y": btn.winfo_rooty() + btn.winfo_height() // 2,
            },
            "entry": {
                "x": entry.winfo_rootx() + entry.winfo_width() // 2,
                "y": entry.winfo_rooty() + entry.winfo_height() // 2,
            },
            "text": {
                "x": txt.winfo_rootx() + txt.winfo_width() // 2,
                "y": txt.winfo_rooty() + txt.winfo_height() // 2,
            },
        }
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass
    root.after(250, dump)


root.after(250, dump)
root.mainloop()
