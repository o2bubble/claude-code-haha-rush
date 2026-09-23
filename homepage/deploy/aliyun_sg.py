"""查询云服务器安全组规则（只读）

用法: python homepage/deploy/aliyun_sg.py

用 workbench 配置里的 AK 调阿里云 ECS API。排障时用：网站打不开先看
80/443 规则是否还在（预期有 website http / website https 两条放行 0.0.0.0/0）。
"""
import json
import os

from aliyunsdkcore.client import AcsClient
from aliyunsdkcore.request import CommonRequest

INSTANCE = "i-2ze2rouoikcqrlbseu8a"
REGION = "cn-beijing"


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


def main():
    ak, sk = load_ak()
    client = AcsClient(ak, sk, REGION)

    inst = call(client, "DescribeInstances", {"InstanceIds": json.dumps([INSTANCE])})
    info = inst["Instances"]["Instance"][0]
    print(f"实例: {info['InstanceName']} | 状态: {info['Status']}")
    print(f"公网 IP: {info.get('PublicIpAddress', {}).get('IpAddress', [])}")
    iattr = call(client, "DescribeInstanceAttribute", {"InstanceId": INSTANCE})
    sg_ids = iattr["SecurityGroupIds"]["SecurityGroupId"]
    print(f"安全组: {sg_ids}\n")

    for sg in sg_ids:
        attr = call(client, "DescribeSecurityGroupAttribute", {
            "SecurityGroupId": sg, "RegionId": REGION, "Direction": "ingress",
        })
        print(f"=== {sg} ({attr.get('SecurityGroupName')}) 入方向 ===")
        perms = attr.get("Permissions", {}).get("Permission", [])
        if not perms:
            print("  (无规则)")
        for p in perms:
            src = p.get("SourceCidrIp") or p.get("Ipv6SourceCidrIp") or p.get("SourceGroupId", "")
            print(f"  {p.get('IpProtocol',''):5s} {p.get('PortRange',''):14s} {src:20s} {p.get('Description','')}")


if __name__ == "__main__":
    main()
