"""workbench 封装 —— 云服务器运维入口（i-2ze2rouoikcqrlbseu8a / cn-beijing）

本机/公司网络连不上云主机 IP（企业网络策略），云上操作一律走 workbench。

用法:
    python homepage/deploy/wb.py "<shell command>" [timeout_seconds]
    MSYS_NO_PATHCONV=1 python homepage/deploy/wb.py upload <local> <remote>

注意（踩过的坑）:
  - upload 必须带 MSYS_NO_PATHCONV=1，否则 Git Bash 把远端 /opt/... 改写成
    C:/Program Files (x86)/.../git/opt/... → InvalidParameter.Path
  - --force 必须有：目标已存在时 workbench 交互式询问，非交互环境会被当成"用户取消"
  - workbench 进度条用 Braille 字符（⠋）→ 输出侧 GBK 会崩，需重配 stdout
"""
import subprocess
import sys

# workbench 输出含 Braille 进度字符（⠋ 等），Windows GBK 控制台直接 print 会崩
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

WB = r"C:\Program Files\workbench\workbench.exe"
INSTANCE = "i-2ze2rouoikcqrlbseu8a"


def _emit(r):
    if r.stdout:
        print(r.stdout)
    if r.stderr:
        print("STDERR:", r.stderr)
    return r.stdout


def run(cmd: str, timeout: int = 120) -> str:
    return _emit(subprocess.run(
        [WB, "exec", "-i", INSTANCE, "-c", cmd, "--timeout", str(timeout), "--output", "json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    ))


def upload(local: str, remote: str) -> str:
    return _emit(subprocess.run(
        [WB, "upload", local, remote, "--instance-id", INSTANCE, "--output", "json", "--force"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", input="y\n",
    ))


if __name__ == "__main__":
    if sys.argv[1] == "upload":
        upload(sys.argv[2], sys.argv[3])
    else:
        run(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 120)
