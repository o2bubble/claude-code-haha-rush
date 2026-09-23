"""给安全组放行 80/443（公网 Web）

用法: python homepage/deploy/aliyun_open_web.py

2026-09-23 首次执行（当时规则里没有 80/443）。幂等：已存在的规则会跳过。
若哪天规则被误删导致站点外网不可达，重跑本脚本即可恢复。
"""
import json
import os

from aliyunsdkcore.client import AcsClient
from aliyunsdkcore.request import CommonRequest

REGION = "cn-beijing"
SG = "sg-2ze6zy9h72b0i4r7gpyt"   # sg-20260728，业务端口安全组


def load_ak():
    c = json.load(open(os.path.expanduser("~/.workbench/config.json")))
    p = c["profiles"][c["current"]]
    return p["access_key_id"], p["access_key_secret"]


def call(client, action, params):
    req = CommonRequest()
    req.set_accept_format("json")
    req.set_domain(f"ecs.{REGION}.aliyuncs.com")
    req.set_version("2014-05-26")
    req.set_action_name(action)
    for k, v in params.items():
        req.add_query_param(k, v)
    return json.loads(client.do_action_with_exception(req))


def existing_ports(client):
    attr = call(client, "DescribeSecurityGroupAttribute", {
        "SecurityGroupId": SG, "RegionId": REGION, "Direction": "ingress",
    })
    ports = set()
    for p in attr.get("Permissions", {}).get("Permission", []):
        src = p.get("SourceCidrIp") or ""
        if p.get("IpProtocol") == "TCP" and src.startswith("0.0.0.0/"):
            ports.add(p.get("PortRange"))
    return ports


def main():
    ak, sk = load_ak()
    client = AcsClient(ak, sk, REGION)

    have = existing_ports(client)
    for port, desc in ((80, "website http"), (443, "website https")):
        if f"{port}/{port}" in have:
            print(f"  {port}: 规则已存在，跳过")
            continue
        call(client, "AuthorizeSecurityGroup", {
            "RegionId": REGION, "SecurityGroupId": SG,
            "IpProtocol": "tcp", "PortRange": f"{port}/{port}",
            "SourceCidrIp": "0.0.0.0/0", "Description": desc,
        })
        print(f"  {port}: 已添加")

    print("\n当前公网放行的 TCP 端口:", sorted(existing_ports(client)))


if __name__ == "__main__":
    main()
