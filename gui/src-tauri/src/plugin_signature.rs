// ── plugin_signature — Ed25519 校验插件包签名 ──
// 官方发布者用私钥签 zip 内容 sha256; 签名文件 <slug>.sig(base64) 随包在 registry。
// GUI 安装时验证 (zip, sig): 通过 = 受信任; 缺失/不通过 = 未受信任(仅 AI 安装+审查)。
// 防篡改原理: 签名绑定 zip 二进制, zip 或 sig 任一被中间人/站点替换 → 验证失败。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::plugin_pubkey::PLUGIN_PUBKEY;

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
}
