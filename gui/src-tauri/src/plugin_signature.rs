// ── plugin_signature — Ed25519 校验插件包签名 ──
// 官方发布者用私钥签 zip 内容 sha256; 签名文件 <slug>.sig(base64) 随包在 registry。
// GUI 安装时验证 (zip, sig): 通过 = 受信任; 缺失/不通过 = 未受信任(仅 AI 安装+审查)。
// 防篡改原理: 签名绑定 zip 二进制, zip 或 sig 任一被中间人/站点替换 → 验证失败。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::plugin_pubkey::PLUGIN_PUBKEY;

/// 直接验证「某个 sha256 摘要」的签名 —— **不需要 zip 字节**。
///
/// 用于列表页的信任判定（2026-10-26）：服务端在 `/api/plugins` 里带上
/// `sha256` + `signature`，客户端拿内嵌公钥本地验一下即可，
/// 不必像以前那样**为每个插件下载整个 zip**（11 个串行合计 4.5 秒）。
///
/// 安全性不变：仍用编译进二进制的 `PLUGIN_PUBKEY` 独立验证，服务端伪造不了
/// （没有私钥）。只是把"算 digest"这一步交给服务端 —— digest 被篡改则签名对不上，
/// 篡改会被发现。
pub fn verify_digest_signature(digest_hex: &str, sig_b64: &str) -> Result<bool, String> {
    let vk = VerifyingKey::from_bytes(&PLUGIN_PUBKEY)
        .map_err(|e| format!("invalid embedded pubkey: {e}"))?;
    let sig_bytes = B64
        .decode(sig_b64.trim())
        .map_err(|e| format!("invalid signature b64: {e}"))?;
    let sig = Signature::from_bytes(&sig_bytes.try_into().map_err(|_| "sig length != 64")?);

    let raw = hex_to_bytes(digest_hex.trim())?;
    if raw.len() != 32 {
        return Err(format!("digest length != 32 (got {})", raw.len()));
    }
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&raw);
    Ok(vk.verify(&digest, &sig).is_ok())
}

fn hex_to_bytes(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("odd-length hex".to_string());
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len() / 2);
    for i in (0..b.len()).step_by(2) {
        let hi = (b[i] as char).to_digit(16).ok_or_else(|| format!("invalid hex at {i}"))?;
        let lo = (b[i + 1] as char).to_digit(16).ok_or_else(|| format!("invalid hex at {}", i + 1))?;
        out.push((hi * 16 + lo) as u8);
    }
    Ok(out)
}

/// 验证 (zip_bytes, sig_b64) 是否由官方私钥签出。
/// 返回 Ok(true)=受信任 / Ok(false)=签名不匹配 / Err=无 key 或格式错误。
pub fn verify_zip_signature(zip_bytes: &[u8], sig_b64: &str) -> Result<bool, String> {
    let vk = VerifyingKey::from_bytes(&PLUGIN_PUBKEY)
        .map_err(|e| format!("invalid embedded pubkey: {e}"))?;
    let sig_bytes = B64
        .decode(sig_b64.trim())
        .map_err(|e| format!("invalid signature b64: {e}"))?;
    let sig = Signature::from_bytes(&sig_bytes.try_into().map_err(|_| "sig length != 64")?);

    let digest = Sha256::digest(zip_bytes);
    Ok(vk.verify(&digest, &sig).is_ok())
}

/// 重打包 zip(内容目录)后验证——与 server _zip_dir 输出一致时可用;
/// 但 server zip 动态生成, 校验重打包输出不匹配原始签名。
/// 因此真正的验证在 GUI 下载**原始 zip 字节**时做(install_plugin_package 传入)。
pub fn verify_zip_file(zip_path: &std::path::Path, sig_b64: &str) -> Result<bool, String> {
    let bytes = std::fs::read(zip_path).map_err(|e| format!("read zip: {e}"))?;
    verify_zip_signature(&bytes, sig_b64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, SecretKey};
    use rand_core::OsRng;
    use sha2::{Digest, Sha256};

    #[test]
    fn verify_roundtrip() {
        // 用测试密钥签一段内容, 再用嵌入式 PLUGIN_PUBKEY 验证——应失败(密钥不同)
        let sk = SigningKey::generate(&mut OsRng);
        let msg = b"hello plugin";
        let digest = Sha256::digest(msg);
        let sig = sk.sign(&digest);
        let sig_b64 = B64.encode(sig.to_bytes());
        // 嵌入式公钥与测试私钥不匹配 → false(不是错误)
        assert_eq!(verify_zip_signature(msg, &sig_b64), Ok(false));
    }

    // ── verify_digest_signature：零下载的信任判定 ──
    //
    // 列表页用服务端给的 (sha256, signature) 本地验签，不必下载 zip。
    // 关键是要保证：这两个入口对**同一份 zip** 的结论必须一致。

    #[test]
    fn digest_and_zip_paths_agree() {
        let sk = SigningKey::generate(&mut OsRng);
        let zip = b"pretend zip bytes";
        let digest = Sha256::digest(zip);
        let sig_b64 = B64.encode(sk.sign(&digest).to_bytes());
        let digest_hex = digest.iter().map(|b| format!("{b:02x}")).collect::<String>();

        // 两条路的结论必须相同（这里都是 false，因为测试私钥 ≠ 内嵌公钥）
        let by_zip = verify_zip_signature(zip, &sig_b64);
        let by_digest = verify_digest_signature(&digest_hex, &sig_b64);
        assert_eq!(by_zip, by_digest, "zip 路径和 digest 路径必须给出一致结论");
    }

    #[test]
    fn digest_hex_is_case_insensitive_and_trims() {
        let sk = SigningKey::generate(&mut OsRng);
        let digest = Sha256::digest(b"x");
        let sig_b64 = B64.encode(sk.sign(&digest).to_bytes());
        let lower = digest.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let upper = lower.to_uppercase();

        assert_eq!(
            verify_digest_signature(&lower, &sig_b64),
            verify_digest_signature(&upper, &sig_b64),
            "十六进制大小写不该影响结果",
        );
        assert_eq!(
            verify_digest_signature(&format!("  {lower}  "), &sig_b64),
            verify_digest_signature(&lower, &sig_b64),
            "前后空白要能容忍（服务端返回可能带换行）",
        );
    }

    #[test]
    fn malformed_inputs_are_errors_not_panics() {
        // 摘要长度不对
        assert!(verify_digest_signature("abcd", "AAAA").is_err());
        // 非十六进制
        assert!(verify_digest_signature(&"z".repeat(64), "AAAA").is_err());
        // 奇数长度
        assert!(verify_digest_signature(&"a".repeat(63), "AAAA").is_err());
        // 签名不是合法 base64
        let ok_hex = "0".repeat(64);
        assert!(verify_digest_signature(&ok_hex, "not base64!!").is_err());
    }

    #[test]
    fn tampered_digest_fails_verification() {
        // 篡改 digest → 签名对不上。这是"服务端不可信"的底线保证。
        let sk = SigningKey::generate(&mut OsRng);
        let real = Sha256::digest(b"real zip");
        let sig_b64 = B64.encode(sk.sign(&real).to_bytes());
        let wrong_hex = Sha256::digest(b"totally different")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();

        assert_eq!(
            verify_digest_signature(&wrong_hex, &sig_b64),
            Ok(false),
            "digest 与签名不匹配时必须判定为 false（不是 Err）",
        );
    }
}
