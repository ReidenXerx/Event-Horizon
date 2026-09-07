//! RAR, behind the `rar` feature. See the licence note in `lib.rs` — the
//! reason this is opt-in is not technical.

use crate::format::Format;
use crate::{ArchiveError, Extraction};
use eh_progress::Task;
use std::path::Path;

#[cfg(not(feature = "rar"))]
pub(crate) fn extract(_a: &Path, _d: &Path, _t: &Task) -> Result<Extraction, ArchiveError> {
    Err(ArchiveError::Unsupported {
        format: Format::Rar,
        why: "built without the `rar` feature (see the UnRAR licence note in eh-archive)"
            .to_owned(),
    })
}

#[cfg(feature = "rar")]
pub(crate) fn extract(archive: &Path, dest: &Path, task: &Task) -> Result<Extraction, ArchiveError> {
    use crate::writer::Writer;

    fn failed(e: impl std::fmt::Display) -> ArchiveError {
        ArchiveError::Backend { format: Format::Rar, why: e.to_string() }
    }

    // Unlike ZIP and 7z, the entry count is not available without a separate
    // listing pass over the whole archive. The task stays indeterminate rather
    // than paying for a second pass to draw a nicer bar.
    let mut cursor = unrar::Archive::new(archive)
        .open_for_processing()
        .map_err(failed)?;

    let mut writer = Writer::new(dest, Format::Rar);
    while let Some(header) = cursor.read_header().map_err(failed)? {
        let raw = header.entry().filename.to_string_lossy().into_owned();
        let is_dir = header.entry().is_directory();

        cursor = match writer.resolve(&raw) {
            Some(path) if is_dir => {
                writer.make_dir(&path)?;
                header.skip().map_err(failed)?
            }
            Some(path) => {
                writer.prepare_parent(&path)?;
                let size = header.entry().unpacked_size;
                // `extract_to` takes the explicit destination FILE, so our own
                // safe_join decides the location. `extract_with_base` would
                // hand that decision to the archive, which is the bug.
                let next = header.extract_to(&path).map_err(failed)?;
                writer.wrote_file(size);
                next
            }
            None => header.skip().map_err(failed)?,
        };
        task.advance(1);
    }
    Ok(writer.finish())
}
