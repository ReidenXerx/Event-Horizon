//! Which container is this? Answered from the bytes, never the filename.
//!
//! A mod archive named `.zip` is sometimes a RAR, and a `.7z` is occasionally
//! a ZIP — re-uploaded by someone who renamed rather than repacked. Trusting
//! the extension produces "corrupt archive" for a file that is perfectly fine,
//! and sends the user to re-download something that was never damaged.

use std::fs::File;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Zip,
    SevenZip,
    /// Both RAR 4.x and RAR 5.x — the backend handles the generation.
    Rar,
}

impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Format::Zip => "zip",
            Format::SevenZip => "7z",
            Format::Rar => "rar",
        }
    }
}

/// Longest magic we compare against (RAR 5 is 8 bytes).
pub(crate) const PROBE_BYTES: usize = 8;

/// Identify a container from its leading bytes.
///
/// `None` means no backend claims it — which is a finding in itself: a file
/// no reader recognises is a damaged or truncated download, not merely one we
/// failed to inspect.
pub fn sniff(head: &[u8]) -> Option<Format> {
    const ZIP_LOCAL: &[u8] = b"PK\x03\x04";
    const ZIP_EMPTY: &[u8] = b"PK\x05\x06";
    const ZIP_SPANNED: &[u8] = b"PK\x07\x08";
    const SEVEN_ZIP: &[u8] = b"7z\xbc\xaf\x27\x1c";
    const RAR4: &[u8] = b"Rar!\x1a\x07\x00";
    const RAR5: &[u8] = b"Rar!\x1a\x07\x01\x00";

    if head.starts_with(RAR5) || head.starts_with(RAR4) {
        return Some(Format::Rar);
    }
    if head.starts_with(SEVEN_ZIP) {
        return Some(Format::SevenZip);
    }
    if head.starts_with(ZIP_LOCAL) || head.starts_with(ZIP_EMPTY) || head.starts_with(ZIP_SPANNED) {
        return Some(Format::Zip);
    }
    None
}

/// Read just enough of a file to identify it.
pub fn detect(path: &Path) -> std::io::Result<(Option<Format>, Vec<u8>)> {
    let mut head = vec![0u8; PROBE_BYTES];
    let mut file = File::open(path)?;
    let read = read_up_to(&mut file, &mut head)?;
    head.truncate(read);
    Ok((sniff(&head), head))
}

/// `Read::read` may return short without being at EOF; loop until full or done.
fn read_up_to<R: Read>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_container_is_recognised_by_its_magic() {
        assert_eq!(sniff(b"PK\x03\x04rest"), Some(Format::Zip));
        assert_eq!(sniff(b"7z\xbc\xaf\x27\x1c\x00\x04"), Some(Format::SevenZip));
        assert_eq!(sniff(b"Rar!\x1a\x07\x00xx"), Some(Format::Rar));
        assert_eq!(sniff(b"Rar!\x1a\x07\x01\x00"), Some(Format::Rar));
    }

    #[test]
    fn an_empty_zip_is_still_a_zip() {
        // A ZIP with no entries starts at the end-of-central-directory record.
        assert_eq!(sniff(b"PK\x05\x06\x00\x00\x00\x00"), Some(Format::Zip));
    }

    #[test]
    fn nothing_recognisable_is_none_rather_than_a_guess() {
        assert_eq!(sniff(b"not an archive"), None);
        assert_eq!(sniff(b""), None);
        assert_eq!(sniff(b"PK"), None, "a truncated signature is not a zip");
    }

    #[test]
    fn rar5_is_not_mistaken_for_rar4_or_vice_versa() {
        // Both map to Format::Rar, but neither may fall through to None.
        assert!(sniff(b"Rar!\x1a\x07\x01\x00").is_some());
        assert!(sniff(b"Rar!\x1a\x07\x00\x00").is_some());
    }

    #[test]
    fn detection_ignores_the_extension_entirely() {
        let dir = std::env::temp_dir().join("eh-archive-sniff-test");
        std::fs::create_dir_all(&dir).unwrap();
        let liar = dir.join("actually-a-zip.rar");
        std::fs::write(&liar, b"PK\x03\x04and then some content").unwrap();
        let (format, _) = detect(&liar).unwrap();
        assert_eq!(format, Some(Format::Zip), "extension must not win");
        std::fs::remove_file(&liar).ok();
    }
}
