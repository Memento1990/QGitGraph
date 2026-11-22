//! Parsers for plain `git cat-file --batch-check` and `git cat-file --batch`.
//! Compatible with Git 2.38: stdin contains only full hexadecimal OIDs and LF,
//! never paths or revision expressions. Resolve paths separately with NUL output.
//! Preflight both sides together, then request only blobs within the content limit.
//! Callers must bound captured stdout and must not enable filters, textconv,
//! symlink following, custom formats, or all-object enumeration. No Git is run here.

use crate::error::{AppError, Result};

pub(crate) const MAX_BATCH_OBJECTS: usize = 128;
// A SHA-256 OID, object type, usize decimal size and separators fit comfortably.
const MAX_HEADER_BYTES: usize = 128;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ObjectInfo {
    pub oid: String,
    pub kind: String,
    pub size: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ObjectBytes {
    pub oid: String,
    pub kind: String,
    pub bytes: Vec<u8>,
}

fn invalid(message: &str) -> AppError {
    AppError::new("GIT_PARSE", message)
}

fn validate_oids(oids: &[String]) -> Result<()> {
    if oids.len() > MAX_BATCH_OBJECTS {
        return Err(invalid("A Git object batch exceeds 128 requests"));
    }
    for oid in oids {
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid("A Git object batch requires full hexadecimal OIDs"));
        }
    }
    Ok(())
}

/// LF-delimited OID-only input for either command, at most 128 * 65 bytes.
/// Empty requests are valid; callers should skip spawning Git in that case.
/// IDs should be canonical full OIDs from Git: responses match byte-for-byte.
/// Duplicates are intentionally preserved, with one response per input position.
pub(crate) fn batch_input(oids: &[String]) -> Result<Vec<u8>> {
    validate_oids(oids)?;
    let capacity = oids.iter().map(|oid| oid.len() + 1).sum();
    let mut input = Vec::with_capacity(capacity);
    for oid in oids {
        input.extend_from_slice(oid.as_bytes());
        input.push(b'\n');
    }
    Ok(input)
}

fn object_size(bytes: &[u8]) -> Result<usize> {
    if bytes.is_empty() {
        return Err(invalid("Missing Git object size"));
    }
    bytes.iter().try_fold(0usize, |size, &byte| {
        if !byte.is_ascii_digit() {
            return Err(invalid("Invalid Git object size"));
        }
        size.checked_mul(10)
            .and_then(|size| size.checked_add(usize::from(byte - b'0')))
            .ok_or_else(|| invalid("Git object size exceeds the supported range"))
    })
}

// Parse only a bounded header, never a line from the binary payload. Returning
// borrowed/static metadata lets the content parser check size before copying.
fn header(remaining: &mut &[u8], expected: &str) -> Result<(&'static str, usize)> {
    let end = remaining[..remaining.len().min(MAX_HEADER_BYTES)]
        .iter()
        .position(|&byte| byte == b'\n')
        .ok_or_else(|| invalid("Truncated or oversized Git object header"))?;
    let line = &remaining[..end];
    *remaining = &remaining[end + 1..];
    let mut fields = line.split(|&byte| byte == b' ');
    if fields.next() != Some(expected.as_bytes()) {
        return Err(invalid(
            "Git object response does not match the requested OID",
        ));
    }
    let kind = match fields.next() {
        Some(b"blob") => "blob",
        Some(b"tree") => "tree",
        Some(b"commit") => "commit",
        Some(b"tag") => "tag",
        Some(b"missing") => return Err(invalid("A requested Git object is missing")),
        _ => return Err(invalid("Unknown Git object type in batch response")),
    };
    let size = object_size(
        fields
            .next()
            .ok_or_else(|| invalid("Missing Git object size"))?,
    )?;
    if fields.next().is_some() {
        return Err(invalid("Unexpected fields in Git object header"));
    }
    Ok((kind, size))
}

/// Parse default `--batch-check` output, in exactly the requested order/count.
/// Known non-blob types and large sizes are returned as metadata only, so callers
/// can exclude them before requesting contents. Missing objects are errors.
pub(crate) fn parse_batch_check(bytes: &[u8], expected: &[String]) -> Result<Vec<ObjectInfo>> {
    validate_oids(expected)?;
    let mut remaining = bytes;
    let mut objects = Vec::with_capacity(expected.len());
    for oid in expected {
        let (kind, size) = header(&mut remaining, oid)?;
        objects.push(ObjectInfo {
            oid: oid.clone(),
            kind: kind.to_owned(),
            size,
        });
    }
    if !remaining.is_empty() {
        return Err(invalid("Unexpected trailing Git object metadata"));
    }
    Ok(objects)
}

/// Parse default `--batch` output: header LF, exactly `size` raw bytes, then LF.
/// Only blob contents are accepted; binary/NUL/non-UTF-8 contents are unchanged.
/// `limit` is per blob (inclusive), not a combined old/new content budget. Each
/// size and frame are checked before copying its payload; the runner must also
/// bound stdout before calling this parser. No missing/extra records are ignored.
pub(crate) fn parse_batch(
    bytes: &[u8],
    expected: &[String],
    limit: usize,
) -> Result<Vec<ObjectBytes>> {
    validate_oids(expected)?;
    let mut remaining = bytes;
    let mut objects = Vec::with_capacity(expected.len());
    for oid in expected {
        let (kind, size) = header(&mut remaining, oid)?;
        if kind != "blob" {
            return Err(invalid("Only blob contents are supported in this batch"));
        }
        if size > limit {
            return Err(AppError::new(
                "OUTPUT_LIMIT",
                "Git object contents exceed the requested byte limit",
            ));
        }
        let frame_len = size
            .checked_add(1)
            .ok_or_else(|| invalid("Git object frame size exceeds the supported range"))?;
        let frame = remaining
            .get(..frame_len)
            .ok_or_else(|| invalid("Truncated Git object contents or footer"))?;
        if frame[size] != b'\n' {
            return Err(invalid("Missing LF footer after Git object contents"));
        }
        objects.push(ObjectBytes {
            oid: oid.clone(),
            kind: kind.to_owned(),
            bytes: frame[..size].to_vec(),
        });
        remaining = &remaining[frame_len..];
    }
    if !remaining.is_empty() {
        return Err(invalid("Unexpected trailing Git object contents"));
    }
    Ok(objects)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oid(c: char) -> String {
        c.to_string().repeat(40)
    }

    fn frame(oid: &str, kind: &str, contents: &[u8]) -> Vec<u8> {
        let mut bytes = format!("{oid} {kind} {}\n", contents.len()).into_bytes();
        bytes.extend_from_slice(contents);
        bytes.push(b'\n');
        bytes
    }

    #[test]
    fn input_is_oid_only_with_full_sha1_sha256_and_duplicates() {
        let a = oid('a');
        let b = "b".repeat(64);
        let expected = vec![a.clone(), b.clone(), a.clone()];
        assert_eq!(
            batch_input(&expected).unwrap(),
            format!("{a}\n{b}\n{a}\n").as_bytes()
        );
    }

    #[test]
    fn input_rejects_abbreviations_other_lengths_and_injection() {
        let mut invalid_ids: Vec<String> = [0, 4, 39, 41, 63, 65, 128]
            .into_iter()
            .map(|len| "a".repeat(len))
            .collect();
        invalid_ids.extend([
            oid('g'),
            format!("{}\n", "a".repeat(39)),
            format!("{}\0", "a".repeat(39)),
            format!("{}\r", "a".repeat(39)),
            format!("{} ", "a".repeat(39)),
            format!("{}:path\n", oid('a')),
            "HEAD".into(),
            "--batch-all-objects".into(),
        ]);
        for value in invalid_ids {
            let expected = [value];
            assert!(batch_input(&expected).is_err(), "{expected:?}");
            assert!(parse_batch_check(b"", &expected).is_err());
            assert!(parse_batch(b"", &expected, 0).is_err());
        }
    }

    #[test]
    fn count_and_total_input_are_bounded_even_for_duplicates() {
        let hash = "f".repeat(64);
        let mut expected = vec![hash.clone(); MAX_BATCH_OBJECTS];
        assert_eq!(batch_input(&expected).unwrap().len(), 128 * 65);
        let metadata = format!("{hash} blob 0\n").repeat(MAX_BATCH_OBJECTS);
        let contents = format!("{hash} blob 0\n\n").repeat(MAX_BATCH_OBJECTS);
        assert_eq!(
            parse_batch_check(metadata.as_bytes(), &expected)
                .unwrap()
                .len(),
            128
        );
        assert_eq!(
            parse_batch(contents.as_bytes(), &expected, 0)
                .unwrap()
                .len(),
            128
        );
        expected.push(hash);
        assert!(batch_input(&expected).is_err());
        assert!(parse_batch_check(metadata.as_bytes(), &expected).is_err());
        assert!(parse_batch(contents.as_bytes(), &expected, 0).is_err());
    }

    #[test]
    fn check_keeps_large_sizes_and_all_known_types_as_metadata() {
        let expected = vec![oid('a'), oid('b'), oid('c'), "d".repeat(64)];
        let metadata = format!(
            "{} blob {}\n{} tree 0\n{} commit 123\n{} tag 7\n",
            expected[0],
            usize::MAX,
            expected[1],
            expected[2],
            expected[3]
        );
        let result = parse_batch_check(metadata.as_bytes(), &expected).unwrap();
        for (index, (kind, size)) in [
            ("blob", usize::MAX),
            ("tree", 0),
            ("commit", 123),
            ("tag", 7),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(result[index].oid, expected[index]);
            assert_eq!(result[index].kind, kind);
            assert_eq!(result[index].size, size);
        }
    }

    #[test]
    fn contents_are_length_framed_not_lines_or_text() {
        let expected = [oid('a')];
        let contents = b"\0first\n\xff\r\nsecond\0\n";
        let bytes = frame(&expected[0], "blob", contents);
        let result = parse_batch(&bytes, &expected, contents.len()).unwrap();
        assert_eq!(result[0].oid, expected[0]);
        assert_eq!(result[0].kind, "blob");
        assert_eq!(result[0].bytes, contents);
    }

    #[test]
    fn multiple_sha256_empty_and_duplicate_blobs_preserve_positions() {
        let a = oid('a');
        let b = "b".repeat(64);
        let expected = [a.clone(), b.clone(), a.clone()];
        let bytes = [
            frame(&a, "blob", b"x\n\0"),
            frame(&b, "blob", b""),
            frame(&a, "blob", b"x\n\0"),
        ]
        .concat();
        let result = parse_batch(&bytes, &expected, 3).unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0], result[2]);
        assert_eq!(result[1].oid, b);
        assert!(result[1].bytes.is_empty());
        let metadata = format!("{a} blob 3\n{b} blob 0\n{a} blob 3\n");
        assert_eq!(
            parse_batch_check(metadata.as_bytes(), &expected)
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn missing_unknown_and_non_blob_contents_fail_closed() {
        let expected = [oid('a')];
        for status in ["missing", "ambiguous", "excluded", "filtered"] {
            let bytes = format!("{} {status}\n", expected[0]);
            assert!(parse_batch_check(bytes.as_bytes(), &expected).is_err());
            assert!(parse_batch(bytes.as_bytes(), &expected, 10).is_err());
        }
        for kind in ["tree", "commit", "tag", "unknown", "blob\0"] {
            let bytes = frame(&expected[0], kind, b"");
            assert!(parse_batch(&bytes, &expected, 0).is_err());
        }
        assert!(
            parse_batch_check(format!("{} unknown 0\n", expected[0]).as_bytes(), &expected)
                .is_err()
        );
    }

    #[test]
    fn malformed_headers_and_non_decimal_sizes_are_rejected() {
        let hash = oid('a');
        let expected = [hash.clone()];
        for line in [
            format!("{hash} blob\n"),
            format!("{hash} blob 1 extra\n"),
            format!("{hash}  blob 1\n"),
            format!("{hash}\tblob 1\n"),
            format!("{hash} blob \n"),
            format!("{hash} blob +1\n"),
            format!("{hash} blob -1\n"),
            format!("{hash} blob 1.0\n"),
            format!("{hash} blob 1a\n"),
            format!("{hash} blob 1\r\n"),
            format!("{hash} blob 1\0\n"),
            format!("{hash} blob 1"),
            format!("{hash} blob {}\n", "0".repeat(512)),
        ] {
            assert!(
                parse_batch_check(line.as_bytes(), &expected).is_err(),
                "{line:?}"
            );
            assert!(parse_batch(line.as_bytes(), &expected, 10).is_err());
        }
    }

    #[test]
    fn size_and_frame_arithmetic_overflow_do_not_allocate_payloads() {
        let expected = [oid('a')];
        let overflow = format!("{} blob {}0\n", expected[0], usize::MAX);
        assert!(parse_batch_check(overflow.as_bytes(), &expected).is_err());
        assert!(parse_batch(overflow.as_bytes(), &expected, usize::MAX).is_err());
        let largest = format!("{} blob {}\n", expected[0], usize::MAX);
        assert!(parse_batch(largest.as_bytes(), &expected, usize::MAX).is_err());
    }

    #[test]
    fn oversize_is_rejected_from_header_and_limit_is_inclusive_per_blob() {
        let a = oid('a');
        let header_only = format!("{a} blob 4\n");
        let expected = [a.clone()];
        assert_eq!(
            parse_batch(header_only.as_bytes(), &expected, 3)
                .unwrap_err()
                .code,
            "OUTPUT_LIMIT"
        );
        assert_eq!(
            parse_batch_check(header_only.as_bytes(), &expected).unwrap()[0].size,
            4
        );
        assert!(parse_batch(&frame(&a, "blob", b"1234"), &expected, 4).is_ok());
        assert!(parse_batch(&frame(&a, "blob", b""), &expected, 0).is_ok());
        let duplicates = [a.clone(), a.clone()];
        let bytes = [frame(&a, "blob", b"1234"), frame(&a, "blob", b"1234")].concat();
        assert_eq!(parse_batch(&bytes, &duplicates, 4).unwrap().len(), 2);
    }

    #[test]
    fn truncation_bad_footers_and_trailing_data_are_errors() {
        let expected = [oid('a')];
        let bytes = frame(&expected[0], "blob", b"a\0\nz");
        for end in 0..bytes.len() {
            assert!(parse_batch(&bytes[..end], &expected, 4).is_err());
        }
        for footer in [b'\0', b'\r', b' '] {
            let mut bad = bytes.clone();
            *bad.last_mut().unwrap() = footer;
            assert!(parse_batch(&bad, &expected, 4).is_err());
        }
        let mut extra = bytes.clone();
        extra.push(b'\n');
        assert!(parse_batch(&extra, &expected, 4).is_err());
        let metadata = format!("{} blob 4\n\n", expected[0]);
        assert!(parse_batch_check(metadata.as_bytes(), &expected).is_err());
        let mut no_footer = bytes[..bytes.len() - 1].to_vec();
        no_footer.extend_from_slice(&bytes);
        assert!(parse_batch(&no_footer, &[expected[0].clone(), expected[0].clone()], 4).is_err());
    }

    #[test]
    fn response_ids_order_lengths_and_record_counts_must_match_exactly() {
        let a = oid('a');
        let b = oid('b');
        let expected = [a.clone(), b.clone()];
        let bytes = [frame(&a, "blob", b""), frame(&b, "blob", b"")].concat();
        let metadata = format!("{a} blob 0\n{b} blob 0\n");
        for wrong in [
            vec![b.clone(), a.clone()],
            vec![a.clone()],
            vec![a.clone(), b, a.clone()],
        ] {
            assert!(parse_batch_check(metadata.as_bytes(), &wrong).is_err());
            assert!(parse_batch(&bytes, &wrong, 0).is_err());
        }
        assert!(parse_batch(&bytes, &expected, 0).is_ok());
        for wrong in [
            oid('c'),
            a.to_ascii_uppercase(),
            format!("{a}{}", "b".repeat(24)),
        ] {
            let output = frame(&wrong, "blob", b"");
            let info = format!("{wrong} blob 0\n");
            assert!(parse_batch(&output, std::slice::from_ref(&a), 0).is_err());
            assert!(parse_batch_check(info.as_bytes(), std::slice::from_ref(&a)).is_err());
            assert!(parse_batch(&frame(&a, "blob", b""), std::slice::from_ref(&wrong), 0).is_err());
            assert!(parse_batch_check(format!("{a} blob 0\n").as_bytes(), &[wrong]).is_err());
        }
    }

    #[test]
    fn empty_batches_require_empty_output() {
        assert!(batch_input(&[]).unwrap().is_empty());
        assert!(parse_batch_check(b"", &[]).unwrap().is_empty());
        assert!(parse_batch(b"", &[], 0).unwrap().is_empty());
        assert!(parse_batch_check(b"\n", &[]).is_err());
        assert!(parse_batch(b"\n", &[], 0).is_err());
    }
}
