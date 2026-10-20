//! Content-addressed identity: what a mod archive *is*, independent of its name.
//!
//! ─── SCOPE ──────────────────────────────────────────────────────────────
//! SHA-256 over archive bytes, ZIP central-directory reading, and the
//! comparison verdicts (`matches` / `differs` / `damaged` / `unknown`).
//!
//! ─── WHY THIS IS THE LOAD-BEARING CRATE ─────────────────────────────────
//! An external mod's identity is its `archiveSha256` and nothing else — no
//! name, no version, no filename fallback. Every other mod manager surveyed
//! gets this wrong in the same direction: Limo's `struct Mod` has no hash
//! field at all, so a LoversLab or Google Drive mod is identified by a string
//! the user typed. Those links rot; the hash outlives the URL.
//!
//! The `differs` / `damaged` split is not cosmetic. Only a damaged archive is
//! fixed by downloading it again, and only that one is not the curator's
//! problem. Collapsing them sends users to re-download a file that was
//! already correct.
//!
//! ─── NATIVE ZIP FIRST, BY DESIGN ────────────────────────────────────────
//! A large share of mod archives are ZIPs and the central directory carries
//! the same CRCs a subprocess would report, so the native path is a cheaper
//! route to an identical answer rather than a weaker one. Detection is by
//! CONTENT, never by extension: a mod archive named `.zip` is sometimes a RAR.
//!
//! STATUS: hashing only. Verdicts and ZIP central-directory reading are next.

#![forbid(unsafe_code)]

use eh_progress::Task;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::Path;

/// Read in chunks this size. Large enough that a multi-gigabyte archive is
/// not a syscall storm, small enough to keep progress moving.
const CHUNK: usize = 1 << 20;

/// Lowercase hex, exactly 64 characters — the only spelling `.ehcoll` accepts.
/// An uppercase hash is not normalised anywhere: identity comparisons happen
/// in many places, and a silently-normalised value is one of them forgetting.
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn to_hex(digest: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// The SHA-256 of everything `reader` yields, and how many bytes that was.
/// Advances `task` by bytes read, when given one.
pub fn sha256_reader(mut reader: impl Read, task: Option<&Task>) -> io::Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        hasher.update(&buf[..n]);
        total += n as u64;
        if let Some(t) = task {
            t.advance(n as u64);
        }
    }
    Ok((to_hex(&hasher.finalize()), total))
}

/// The SHA-256 of a file's bytes, and its length.
pub fn sha256_file(path: &Path, task: Option<&Task>) -> io::Result<(String, u64)> {
    sha256_reader(File::open(path)?, task)
}

/// A writer that hashes what passes through it.
///
/// For the places where bytes are being written anyway — a download, a copy
/// into staging — so proving what landed costs no second read of the file.
pub struct HashingWriter<W: Write> {
    inner: W,
    hasher: Sha256,
    written: u64,
}

impl<W: Write> HashingWriter<W> {
    pub fn new(inner: W) -> Self {
        Self { inner, hasher: Sha256::new(), written: 0 }
    }

    /// Bytes written so far.
    pub fn written(&self) -> u64 {
        self.written
    }

    /// Flush, and hand back the writer with the hash and length of everything
    /// that was written through it.
    pub fn finish(mut self) -> io::Result<(W, String, u64)> {
        self.inner.flush()?;
        Ok((self.inner, to_hex(&self.hasher.finalize()), self.written))
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // Hash exactly what the inner writer accepted, never the whole buffer:
        // a short write followed by a retry would otherwise hash bytes twice.
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Published test vectors (FIPS 180-2), not values computed by this code.
    const EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn known_vectors() {
        assert_eq!(sha256_reader(&b""[..], None).unwrap(), (EMPTY.to_owned(), 0));
        assert_eq!(sha256_reader(&b"abc"[..], None).unwrap(), (ABC.to_owned(), 3));
    }

    #[test]
    fn a_reader_spanning_many_chunks_hashes_like_one_buffer() {
        let data: Vec<u8> = (0..(CHUNK * 2 + 17)).map(|i| (i % 251) as u8).collect();
        let (whole, n) = sha256_reader(&data[..], None).unwrap();
        let mut w = HashingWriter::new(Vec::new());
        for piece in data.chunks(4093) {
            w.write_all(piece).unwrap();
        }
        let (inner, streamed, m) = w.finish().unwrap();
        assert_eq!((whole, n), (streamed, m));
        assert_eq!(inner, data);
    }

    /// A writer that accepts one byte per call.
    struct Stingy(Vec<u8>);
    impl Write for Stingy {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let n = buf.len().min(1);
            self.0.extend_from_slice(&buf[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_short_writing_inner_is_hashed_once_per_byte() {
        let mut w = HashingWriter::new(Stingy(Vec::new()));
        w.write_all(b"abc").unwrap(); // three calls of one byte each
        let (_, hash, n) = w.finish().unwrap();
        assert_eq!((hash.as_str(), n), (ABC, 3));
    }

    #[test]
    fn only_lowercase_64_hex_is_a_sha256() {
        assert!(is_sha256_hex(EMPTY));
        assert!(!is_sha256_hex(&EMPTY.to_uppercase()));
        assert!(!is_sha256_hex(&EMPTY[..63]));
        assert!(!is_sha256_hex(&format!("{}g", &EMPTY[..63])));
    }
}
