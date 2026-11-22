use crate::{
    error::{AppError, Result},
    git::{redact, GitService},
    model::{Repository, VerificationResult, VerifyQuery},
};

impl GitService {
    pub async fn verify_signature(
        &self,
        repo: &Repository,
        query: &VerifyQuery,
    ) -> Result<VerificationResult> {
        if !repo.trusted {
            return Err(AppError::new(
                "UNTRUSTED",
                "Trust this repository before running its configured signature verifier.",
            ));
        }
        let (oid, signed) = match query.kind.as_str() {
            "commit" => {
                let oid = self
                    .resolve_revision(repo, &query.request_id, &query.target)
                    .await?;
                let raw = self
                    .run_bytes(
                        repo,
                        &query.request_id,
                        vec!["cat-file".into(), "commit".into(), oid.clone()],
                        false,
                    )
                    .await?;
                let signed = crate::git::parse::has_commit_signature(&raw)?;
                (oid, signed)
            }
            "tag" => {
                let detail = self
                    .tag_detail(repo, &query.target, &query.request_id)
                    .await?;
                (
                    detail.oid,
                    detail.annotated && detail.signature.status != "N",
                )
            }
            _ => {
                return Err(AppError::new(
                    "SIGNATURE",
                    "Only commit and annotated tag signatures can be verified.",
                ))
            }
        };
        if !signed {
            return Ok(VerificationResult {
                kind: query.kind.clone(),
                oid,
                status: "unsigned".into(),
                signer: String::new(),
                key: String::new(),
                output: "This object has no embedded signature.".into(),
            });
        }
        let output = self
            .run_output(
                repo,
                &query.request_id,
                vec![
                    format!("verify-{}", query.kind),
                    "--raw".into(),
                    "--".into(),
                    oid.clone(),
                ],
                None,
                true,
            )
            .await?;
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        if !output.stderr.is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&String::from_utf8_lossy(&output.stderr));
        }
        let (status, signer, key) = parse_status(output.code, &text);
        Ok(VerificationResult {
            kind: query.kind.clone(),
            oid,
            status: status.into(),
            signer,
            key,
            output: redact(&text),
        })
    }
}

fn parse_status(code: i32, output: &str) -> (&'static str, String, String) {
    let mut signer = String::new();
    let mut key = String::new();
    let mut good = false;
    let mut valid = false;
    let mut bad = false;
    let mut expired = false;
    let mut revoked = false;
    let mut no_key = false;
    let mut untrusted = false;
    let mut verifier_failed = false;
    for line in output.lines() {
        let Some(line) = line.strip_prefix("[GNUPG:] ") else {
            continue;
        };
        let mut parts = line.splitn(2, ' ');
        let name = parts.next().unwrap_or("");
        let data = parts.next().unwrap_or("");
        match name {
            "GOODSIG" | "EXPSIG" | "EXPKEYSIG" | "REVKEYSIG" => {
                let mut identity = data.splitn(2, ' ');
                key = identity.next().unwrap_or("").into();
                signer = identity.next().unwrap_or("").into();
                if name == "GOODSIG" {
                    good = true;
                }
                if matches!(name, "EXPSIG" | "EXPKEYSIG") {
                    expired = true;
                }
                if name == "REVKEYSIG" {
                    revoked = true;
                }
            }
            "VALIDSIG" => {
                valid = true;
                key = data.split_whitespace().next().unwrap_or("").into();
            }
            "BADSIG" => bad = true,
            "NO_PUBKEY" => {
                no_key = true;
                key = data.into();
            }
            "TRUST_UNDEFINED" | "TRUST_NEVER" | "TRUST_MARGINAL" => untrusted = true,
            "KEYEXPIRED" | "SIGEXPIRED" => expired = true,
            "KEYREVOKED" => revoked = true,
            "ERRSIG" => verifier_failed = true,
            _ => {}
        }
    }
    let lower = output.to_ascii_lowercase();
    let status = if revoked {
        "revoked"
    } else if expired {
        "expired"
    } else if bad {
        "invalid"
    } else if no_key {
        "unknown-key"
    } else if (good || valid) && untrusted {
        "untrusted"
    } else if code == 0
        && (good
            || valid
            || lower.contains("good \"git\" signature")
            || lower.contains("good git signature"))
    {
        "valid"
    } else if lower.contains("no such file")
        || lower.contains("cannot run")
        || lower.contains("not found")
        || lower.contains("allowed signers")
        || lower.contains("allowedsignersfile")
    {
        "unavailable"
    } else if code == 0 {
        "valid"
    } else if verifier_failed {
        "unavailable"
    } else if lower.contains("good \"git\" signature") && lower.contains("no principal matched") {
        "untrusted"
    } else if lower.contains("bad signature")
        || lower.contains("incorrect signature")
        || lower.contains("signature verification failed")
        || lower.contains("invalid format")
        || lower.contains("parse signature")
    {
        "invalid"
    } else {
        "error"
    };
    (status, signer, key)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn differentiates_presence_trust_and_invalid() {
        assert_eq!(parse_status(0,"[GNUPG:] GOODSIG ABC Person\n[GNUPG:] VALIDSIG FINGERPRINT 1\n[GNUPG:] TRUST_UNDEFINED 0").0,"untrusted");
        assert_eq!(parse_status(1, "[GNUPG:] NO_PUBKEY 123").0, "unknown-key");
        assert_eq!(parse_status(1, "[GNUPG:] BADSIG 123 Person").0, "invalid");
        assert_eq!(
            parse_status(
                0,
                "Good \"git\" signature for person with ED25519 key SHA256:key"
            )
            .0,
            "valid"
        );
        assert_eq!(
            parse_status(1, "error: cannot run verifier: No such file").0,
            "unavailable"
        );
    }
}
